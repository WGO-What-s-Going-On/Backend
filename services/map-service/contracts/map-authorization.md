# MapAuthorization 내부 gRPC 계약

전송 형식과 메서드는 [map-authorization.proto](./map-authorization.proto)가 정의한다. 이 서비스는 Post Service에서만 호출하는 읽기 전용 내부 API다. Swagger/OpenAPI의 HTTP 경로에 포함하지 않는다.

| 메서드 | 입력 | 허용 조건 |
| --- | --- | --- |
| `CheckPostCreation` | 사용자 ID, 게시물 중심 좌표, 반경 | 사용자 최신 위치가 5분 이내이며 중심에서 반경 이내 |
| `CheckPostParticipation` | 위 입력과 게시물 ID | 같은 위치 조건. 전달된 게시물 ID 형식도 검사 |

두 메서드는 `LocationDecision { allowed, reason }`을 반환한다. 거부 사유는 `LOCATION_MISSING`, `LOCATION_STALE`, `OUTSIDE_RADIUS`이고 허용 시 `reason`은 빈 문자열이다. 반경은 1~10,000m이며 거리 경계는 포함한다. 참여 요청의 게시물 존재와 ACTIVE 상태는 Map이 확인하지 않는다. Post Service가 자신의 원본 상태를 확인한다.

요청의 `authorization` 메타데이터에는 `Bearer <JWT>`가 필요하다. JWT는 HS256, issuer `wgo-post-service`, audience `wgo-map-service`, subject `post-service`, 최대 수명 60초여야 한다. 토큰 오류는 `UNAUTHENTICATED`, 입력 오류는 `INVALID_ARGUMENT`, 위치 저장소 장애는 `UNAVAILABLE` gRPC 상태로 응답한다. 호출자는 deadline을 설정해야 한다.
