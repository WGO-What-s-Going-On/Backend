# MapAuthorization 내부 gRPC 계약

전송 형식과 메서드는 [map-authorization.proto](./map-authorization.proto)가 정의한다. 이 서비스는 Post Service에서만 호출하는 읽기 전용 내부 API다. Swagger/OpenAPI의 HTTP 경로에 포함하지 않는다.

| 메서드 | 입력 | 허용 조건 |
| --- | --- | --- |
| `CheckPostCreation` | 사용자 ID, 게시물 중심 좌표, 반경 | 사용자 최신 위치가 5분 이내이며 중심에서 반경 이내 |
| `CheckPostParticipation` | 위 입력과 게시물 ID | 같은 위치 조건. 전달된 게시물 ID 형식도 검사 |

두 메서드는 `LocationDecision { allowed, reason }`을 반환한다. 거부 사유는 `LOCATION_MISSING`, `LOCATION_STALE`, `OUTSIDE_RADIUS`이고 허용 시 `reason`은 빈 문자열이다. 반경은 1~10,000m이며 거리 경계는 포함한다. 참여 요청의 게시물 존재와 ACTIVE 상태는 Map이 확인하지 않는다. Post Service가 자신의 원본 상태를 확인한다.

초기 gRPC 메타데이터의 `authorization` 값은 정확히 하나의 `Bearer <JWT>`여야 한다. 새 토큰은 ES256, `typ=wgo-service+jwt`, 등록된 `kid`, `iss=wgo-post-service`, `sub=post-service`, `aud=wgo-map-service`를 사용한다. `iat`와 `exp`는 정수 Unix 초이며, 수명은 최대 60초, 미래 발급 허용치는 5초다. 허용 호출자는 두 RPC 모두 `post-service`다. 전환 기간에는 같은 issuer, subject, audience, 시간 조건을 만족하는 기존 HS256 `typ=JWT` 토큰도 허용한다. ES256 검증 실패 시 HS256으로 재시도하지 않는다.

누락·중복·잘못된 토큰은 `UNAUTHENTICATED`, 인증된 호출자의 권한 부족은 `PERMISSION_DENIED`, 입력 오류는 `INVALID_ARGUMENT`, 위치 저장소 장애는 `UNAVAILABLE` gRPC 상태로 응답한다. 호출자는 deadline을 설정해야 한다. 요청·응답 proto 필드는 이 전환에서 바뀌지 않는다.


## MapPostQuery.SearchNearbyPosts

같은 proto에 정의된 신규 검색 RPC다. 좌표·radiusM(150/250/350)·limit(1–200)·cursor를 받으며 `{items:[{postId,distanceM}],truncated,nextCursor}`를 반환한다. 공간 인덱스의 ACTIVE·미만료 후보를 거리·postId 순서로 조회하고 다음 후보가 존재하면 truncated=true다. 페이지당 최대 200개이며 공개 HTTP의 100개/커서 계약은 유지한다. Post 유사도 검색이 MongoDB 원본의 최근 24시간·최종 상태를 별도로 검증한다. 일반 목록을 위한 공간 조회에는 24시간 제한을 적용하지 않는다.

ES256으로 인증된 post-service만 허용한다. 기존 MapAuthorization의 HS256 호환성은 이 RPC에 적용하지 않는다. 누락/HS256/잘못된 신원은 UNAUTHENTICATED, 입력 오류는 INVALID_ARGUMENT, 저장소 장애는 UNAVAILABLE이다. Post는 MAP_GRPC_TIMEOUT_MS deadline을 적용한다.


`NearbyPostsRequest.cursor=5`, `NearbyPostsResponse.next_cursor=3`을 추가했다. 기존 필드 번호는 유지하며 첫 요청의 cursor는 생략하거나 빈 문자열을 보낸다. nextCursor가 빈 문자열이면 마지막 페이지, 그 외에는 같은 좌표·반경·해당 커서로 다음 페이지를 요청한다. limit은 페이지마다 1–200 범위에서 선택할 수 있다. 정렬은 기존 Map 조회와 같은 거리·postId 오름차순이다. cursor는 Map HTTP가 사용하는 값을 그대로 전달하며 좌표·반경이 다른 요청에 재사용하면 INVALID_ARGUMENT이다. 커서는 최대 1024자의 base64url 문자열이다. 공간 인덱스가 실시간 변경되므로 여러 페이지에 걸친 고정 스냅샷을 보장하지 않는다.

truncated는 nextCursor 존재 여부와 같다. 구 Post 클라이언트는 새 필드를 무시할 수 있고, 새 Post의 유사도 검색도 구 Map 서버의 응답을 계속 처리한다. 커서 페이지 조회는 nextCursor를 제공하는 Map 배포 이후 사용한다. Post 유사도 검색은 150m·첫 페이지 최대 200개만 요청하고 다음 페이지를 자동으로 따라가지 않는다.
