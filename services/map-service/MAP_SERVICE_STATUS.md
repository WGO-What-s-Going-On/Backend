# Map Service 작업 현황

2026-09-29 기준. 이 문서는 **실제로 구현한 Map Service 범위**와 후속 작업을 기록한다. 전체 목표 구조는 [백엔드 아키텍처](../../ARCHITECTURE.md), 현재 실행 방법은 [README](./README.md)를 참고한다.

## 이번에 구현한 범위

### 최신 사용자 위치 저장

- `PUT /api/v1/location`은 `latitude`, `longitude`를 받고 서버 시각으로 `updatedAt`을 정한다. 위도는 −90~90, 경도는 −180~180 범위의 유한한 숫자여야 한다. 알 수 없는 필드는 거부한다.
- 로컬·테스트 환경에서는 양의 정수 `X-User-Id`를 사용자 식별자로 사용한다. 성공 시 위치와 갱신 시각을 `200`으로 반환한다. 잘못된 본문은 `400`, 식별자가 없거나 잘못되면 `403`, 저장소 장애는 `503`이다.
- 사용자별 최신 위치 한 건을 Cassandra `wgo_map.user_locations`에 저장한다. Cassandra가 원본이며, Redis `map:location:{userId}`는 300초 TTL의 캐시다. 캐시를 읽지 못하면 Cassandra에서 조회하고, 이미 오래된 위치는 캐시에 다시 넣지 않는다. 현재 Cassandra 행 자체에는 TTL을 설정하지 않았다.
- **계획:** 위치 변경 로그(위치 갱신 요청별 Cassandra 이력)를 남겨 게시물 생성·참여 판정의 최신 위치 원본으로 사용하고, 위치 조작 의심·부정 이용 신고 조사에 활용한다. 현재는 이력이 구현되지 않았으며 과거 갱신을 조회할 수 없다. 수집·조회·보존·전환 범위는 [위치 갱신 이력 계획](./LOCATION_HISTORY_PLAN.md)에 정리했다.
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

- Map 단위·HTTP/gRPC 계약 테스트 5개 통과: 위치 없음·5분 경과·거리 경계, 위치 갱신 후 생성·참여 판정, 잘못된 JWT, 운영 위치 갱신 차단.
- Post 통합 테스트 17개 통과: MongoDB·Redis와 gRPC 테스트 서버를 연결해 위치 거부, 잘못된 서비스 JWT, Map 장애·deadline 초과에서 Post/Outbox 미기록을 확인했다.
- 두 서비스의 타입 검사와 빌드가 통과했다. 로컬 Cassandra·Redis를 사용한 실제 HTTP → gRPC 왕복에서 위치 갱신 후 게시물 생성·참여 성공과 위치가 없는 사용자에 대한 `403`을 확인했고, Cassandra 저장 행과 Redis TTL도 확인했다.

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
4. **위치 갱신 이력과 운영 정책.** [계획](./LOCATION_HISTORY_PLAN.md)에 따라 Cassandra 요청별 이력을 추가하고 최신 이력을 생성·참여 판정의 원본으로 전환한다. 위치 조작 의심·부정 이용 조사에 필요한 행위 근거 연결과 제한된 내부 조회를 구현한다. 수집 빈도, 보존·삭제 기간, 접근 통제와 관측 지표를 확정해야 한다. 이력만으로 GPS 위·변조를 입증할 수는 없다.
5. **Stream 자체 유실 대조.** Map이 소비하기 전에 Stream 이벤트가 유실되었다면 Post Service 원본과 대조하고 재발행해야 한다.

Map은 내부 주변 검색에서 로컬 상태가 `ACTIVE`이고 만료되지 않은 게시물만 반환한다. 상태 이벤트가 전파되기까지 짧은 지연이 있을 수 있다. GEO 일부 항목이 유실되고 다른 후보가 남아 있다면 재구축 전까지 누락될 수 있다. 기존 `post_locations`의 누락 상태는 관리 재구축에서만 조건부로 `ACTIVE`로 채운다. 극지방 좌표는 GEO에 넣지 않고 H3에서 검색한다.
