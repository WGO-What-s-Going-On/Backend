# Map Service 작업 현황

2026-09-30 기준. 이 문서는 **실제로 구현한 Map Service 범위**와 후속 작업을 기록한다. 전체 목표 구조는 [백엔드 아키텍처](../../ARCHITECTURE.md), 현재 실행 방법은 [README](./README.md)를 참고한다.

## 이번에 구현한 범위

### 사용자 위치 갱신 이력

- `PUT /api/v1/location`은 `latitude`, `longitude`를 받고 서버 시각으로 `updatedAt`을 정한다. 위도는 −90~90, 경도는 −180~180 범위의 유한한 숫자여야 한다. 알 수 없는 필드는 거부한다.
- 로컬·테스트 환경에서는 양의 정수 `X-User-Id`를 사용자 식별자로 사용한다. 성공 시 위치와 갱신 시각을 `200`으로 반환한다. 잘못된 본문은 `400`, 식별자가 없거나 잘못되면 `403`, 저장소 장애는 `503`이다.
- 유효한 요청마다 Cassandra `wgo_map.user_location_history`에 새 행을 기록한다. 같은 좌표와 재시도도 별도 이력이다. UTC 일별 버킷과 서버 생성 `timeuuid` 내림차순 키를 사용하며, 7일 TTL과 6시간 시계열 compaction을 적용한다. TTL 만료 행은 조회되지 않고 물리적 공간은 이후 compaction에서 회수된다.
- Cassandra 이력 기록 후 Redis `map:location:{userId}`의 최신 위치 캐시를 갱신한다. 동시 쓰기가 역순으로 끝나도 이전 위치로 되돌리지 않는다. 생성·참여 판정은 캐시를 먼저 읽고, 캐시가 없거나 Redis 장애이면 오늘 버킷의 최신 한 건, 없으면 전날 버킷의 최신 한 건을 조회한다. 기존 `user_locations`는 이관하지 않으며 전환 확인 후 폐기한다. 자세한 전환·후속 범위는 [위치 갱신 이력 계획](./LOCATION_HISTORY_PLAN.md)에 있다.
- 운영 환경의 공개 위치 갱신은 사용자 인증 연동 전까지 `503`으로 닫혀 있다.

### Post Service용 읽기 전용 gRPC 판정

계약은 [`contracts/map-authorization.proto`](./contracts/map-authorization.proto)에 있다. Post Service에도 같은 계약 사본을 둔다.

| RPC | 입력 | 판정 |
| --- | --- | --- |
| `CheckPostCreation` | `userId`, 생성 중심 위·경도, `radiusM` | 사용자 최신 위치가 생성 중심에서 반경 이내인지 확인 |
| `CheckPostParticipation` | `userId`, `postId`, 저장된 게시물 중심 위·경도, `radiusM` | 사용자 최신 위치가 게시물 중심에서 반경 이내인지 확인 |

- 두 RPC는 `{ allowed, reason }`을 반환한다. 거부 사유는 `LOCATION_MISSING`, `LOCATION_STALE`, `OUTSIDE_RADIUS`다. 위치가 갱신된 지 **5분 초과**했거나 서버 시각보다 5초 넘게 미래이면 오래된 위치로 취급한다. 경계 거리와 정확히 같으면 허용한다. 거리는 위·경도에 대한 대원거리 계산으로 구한다.
- 요청은 유효한 사용자 ID, 좌표, 1~10,000m 반경을 요구한다. 참여 요청은 게시물 ID 형식도 확인한다. 현재 Map Service는 게시물 원본을 보유하지 않으므로 `postId`의 존재나 ACTIVE 상태는 확인하지 않는다. Post Service가 MongoDB의 게시물 중심·반경을 전달하고 트랜잭션 안에서 ACTIVE 상태를 다시 확인한다.
- gRPC 메타데이터의 서비스 JWT는 별도 `MAP_SERVICE_JWT_SECRET`으로 HS256 서명하며 issuer `wgo-post-service`, audience `wgo-map-service`, subject `post-service`, 발급·만료 시각과 최대 60초 수명을 검증한다. 없거나 잘못된 토큰은 `UNAUTHENTICATED`, 잘못된 입력은 `INVALID_ARGUMENT`, 위치 저장소 장애는 `UNAVAILABLE`이다.
- Post Service는 30초 수명의 JWT와 기본 500ms deadline으로 RPC를 호출한다. Map의 위치 거부는 Post HTTP `403`, Map 장애·인증 오류·deadline 초과는 `503`으로 처리한다. 거부된 생성·참여에서는 Post 데이터와 Outbox를 기록하지 않는다.

### 로컬 실행과 검증

`compose.yaml`은 Map 전용 Cassandra와 Redis를 실행한다. `schema.cql`을 적용한 후 `.env.example`의 연결 정보와 양쪽 서비스의 동일한 `MAP_SERVICE_JWT_SECRET`을 설정한다. 자세한 명령은 README에 있다.

- Map 단위·HTTP/gRPC·Cassandra 통합 테스트에서 반복 갱신 이력, 최신 조회, TTL 만료, 위치 없음·5분 경과·거리 경계, 위치 갱신 후 생성·참여 판정, 잘못된 JWT, 운영 위치 갱신 차단을 확인했다.
- Post 통합 테스트 17개 통과: MongoDB·Redis와 gRPC 테스트 서버를 연결해 위치 거부, 잘못된 서비스 JWT, Map 장애·deadline 초과에서 Post/Outbox 미기록을 확인했다.
- Map과 Gateway의 타입 검사·빌드가 통과했다. Gateway Redis 통합 테스트에서 위치 갱신 61번째 요청의 `429`와 Map 미전달, 다른 경로 통과를 확인했다.

### API와 내부 계약 문서

- HTTP Gateway에 등록된 Map 경로는 `PUT /api/v1/location` 한 개다. 로컬·테스트에서만 실행되며 운영에서는 인증 연동 전까지 `503`이다. [OpenAPI 문서](./contracts/map-http.openapi.json)를 Map 직접 접속 `/docs/openapi.json`으로 제공하고 `/docs`에서 Swagger UI로 확인할 수 있다. 문서 경로는 Gateway에 등록되지 않았다.
- 두 위치 판정 RPC는 Post Service 전용 내부 API다. [Proto](./contracts/map-authorization.proto)와 [인증·오류 의미](./contracts/map-authorization.md)에 계약이 있다. `PostCreated` 소비, Dead Letter, H3/Cassandra/Redis GEO, 재구축 명령은 HTTP API가 아니다. 이벤트 계약은 [JSON Schema](./contracts/post-created.schema.json)와 [Stream 필드 문서](./contracts/post-events.md)에 기록했다.
- Map 직접 접속의 내부 `GET /internal/v1/posts/nearby`를 구현했다. 별도 Gateway JWT를 모든 환경에서 확인하며 반경 150·250·350m, 기본 20·최대 100개, 좌표·반경에 묶인 커서를 지원한다. Swagger는 HTTP 경로만 명세한다. Gateway의 JWT 발급과 공개 응답 조합은 후속 작업이다.

### 게시물 공간 인덱스

- Post Service의 `post:events`에 독립된 `post-map` Consumer Group을 Stream 시작점 `0`에서 생성한다. `PostCreated`, `PostExpired`, `PostDeleted` 버전 1의 `data` JSON과 Stream 식별자를 검사한다. 다른 이벤트는 ACK하고, 잘못된 이벤트는 원본 Stream ID·이벤트 ID·오류와 함께 `map:post:dead`에 기록한 뒤 ACK한다.
- Cassandra `post_locations`는 게시물 ID 기준 복구 원본으로 `event_id`, 위치, 반경, 카테고리, 만료 시각, H3 cell·shard를 저장한다. `posts_by_cell`은 `(cell, shard)` 파티션과 게시물 ID 키를 사용한다. H3 resolution은 **8**, shard 수는 **16**으로 고정한다. 해상도 변경에는 재구축이 필요하다.
- 생성 처리는 `post_status`를 없을 때만 `ACTIVE`로 채우고 원본 행 → cell 행 → Redis GEO → XACK 순으로 진행한다. 비활성 상태는 조건부 갱신 후 현재·재구축 GEO에서 제거한다. `XAUTOCLAIM`으로 Pending을 회수하며 5회 실패 후 Dead Letter 기록 성공을 확인하고 ACK한다. 30초마다 Pending 수·최장 대기 시간·처리 실패·Dead Letter 수를 로그에 기록한다.
- `pnpm rebuild:posts`는 원본을 페이지 단위로 읽어 cell 행을 복구하고 별도 GEO 키를 만든 뒤 포인터를 전환한다. 재구축 중 새 게시물은 소비자가 현재·새 GEO 키 양쪽에 기록한다. 기동 시 전체 스캔은 없다. 상세 실행 및 중단 후 복구는 README에 있다.
- 로컬 Cassandra·Redis 통합 테스트에서 상태 중복·역순, 세 반경 경계, GEO 장애 시 H3 검색, 페이지·커서, 비활성·만료 제외와 재구축을 검증했다. 기존 위치 HTTP/gRPC 및 Swagger 경로와 함께 Node 24에서 총 17개 테스트가 통과했다. `pnpm typecheck`와 `pnpm build`도 통과했다.

## 추후 작업

1. **운영 사용자 인증 연결.** HTTP Gateway가 검증한 사용자 신원을 위치 갱신·게시물 생성·참여에 전달할 계약을 정하고, 현재 운영 `503` 차단을 인증 검증으로 교체한다. 현재 `X-User-Id`는 로컬·테스트 전용이다.
2. **Gateway 주변 조회 연결.** 내부 검색을 호출할 단기 JWT를 발급하고 클라이언트용 API와 Post 상세 응답을 조합한다.
3. **Post 상태 이벤트 생산.** Post Service에서 만료·삭제 전이와 `PostExpired`·`PostDeleted` 발행을 구현한다. Map은 이 이벤트의 상태 사영과 GEO 제거를 처리하지만 생산자가 아직 없다.
4. **위치 조사와 운영 정책.** [계획](./LOCATION_HISTORY_PLAN.md)에 따라 판정에 쓴 갱신 ID·시각을 Post 행위 근거에 연결하고, 권한이 제한된 조사 조회와 삭제 처리를 설계한다. 일반 이력과 별도인 신고 사건 증거 보존 기간을 정해야 한다. 이력만으로 GPS 위·변조를 입증할 수는 없다.
5. **Stream 자체 유실 대조.** Map이 소비하기 전에 Stream 이벤트가 유실되었다면 Post Service 원본과 대조하고 재발행해야 한다.

Map은 내부 주변 검색에서 로컬 상태가 `ACTIVE`이고 만료되지 않은 게시물만 반환한다. 상태 이벤트가 전파되기까지 짧은 지연이 있을 수 있다. GEO 일부 항목이 유실되고 다른 후보가 남아 있다면 재구축 전까지 누락될 수 있다. 기존 `post_locations`의 누락 상태는 관리 재구축에서만 조건부로 `ACTIVE`로 채운다. 극지방 좌표는 GEO에 넣지 않고 H3에서 검색한다.
