# Map Service 작업 현황

2026-09-29 기준. 이 문서는 **실제로 구현한 Map Service 범위**와 후속 작업을 기록한다. 전체 목표 구조는 [백엔드 아키텍처](../../ARCHITECTURE.md), 현재 실행 방법은 [README](./README.md)를 참고한다.

## 이번에 구현한 범위

### 최신 사용자 위치 저장

- `PUT /api/v1/location`은 `latitude`, `longitude`를 받고 서버 시각으로 `updatedAt`을 정한다. 위도는 −90~90, 경도는 −180~180 범위의 유한한 숫자여야 한다. 알 수 없는 필드는 거부한다.
- 로컬·테스트 환경에서는 양의 정수 `X-User-Id`를 사용자 식별자로 사용한다. 성공 시 위치와 갱신 시각을 `200`으로 반환한다. 잘못된 본문은 `400`, 식별자가 없거나 잘못되면 `403`, 저장소 장애는 `503`이다.
- 사용자별 최신 위치 한 건을 Cassandra `wgo_map.user_locations`에 저장한다. Cassandra가 원본이며, Redis `map:location:{userId}`는 300초 TTL의 캐시다. 캐시를 읽지 못하면 Cassandra에서 조회하고, 이미 오래된 위치는 캐시에 다시 넣지 않는다. 현재 Cassandra 행 자체에는 TTL을 설정하지 않았다.
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

### 게시물 공간 인덱스

- Post Service의 `post:events`에 독립된 `post-map` Consumer Group을 Stream 시작점 `0`에서 생성한다. `PostCreated` 버전 1의 `data` JSON과 Stream 식별자를 검사한다. 다른 이벤트는 ACK하고, 잘못된 이벤트는 원본 Stream ID·이벤트 ID·오류와 함께 `map:post:dead`에 기록한 뒤 ACK한다.
- Cassandra `post_locations`는 게시물 ID 기준 복구 원본으로 `event_id`, 위치, 반경, 카테고리, 만료 시각, H3 cell·shard를 저장한다. `posts_by_cell`은 `(cell, shard)` 파티션과 게시물 ID 키를 사용한다. H3 resolution은 **8**, shard 수는 **16**으로 고정한다. 해상도 변경에는 재구축이 필요하다.
- 처리 순서는 원본 행 → cell 행 → Redis GEO → XACK이다. 같은 이벤트의 재전달은 동일한 값을 다시 기록한다. `XAUTOCLAIM`으로 Pending을 회수하며 5회 실패 후 Dead Letter 기록 성공을 확인하고 ACK한다. 30초마다 Pending 수·최장 대기 시간·처리 실패·Dead Letter 수를 로그에 기록한다.
- `pnpm rebuild:posts`는 원본을 페이지 단위로 읽어 cell 행을 복구하고 별도 GEO 키를 만든 뒤 포인터를 전환한다. 재구축 중 새 게시물은 소비자가 현재·새 GEO 키 양쪽에 기록한다. 기동 시 전체 스캔은 없다. 상세 실행 및 중단 후 복구는 README에 있다.
- 로컬 Cassandra·Redis 통합 테스트에서 최초·중복 소비, 원본·cell·GEO 저장 실패 후 Pending 회수, 잘못된 이벤트, 5회 실패 Dead Letter, 다중 소비자 분담, GEO 유실 후 재구축, 재구축 중 새 이벤트를 검증했다. 기존 위치 HTTP/gRPC 테스트와 함께 Node 24.21.0에서 총 12개 테스트가 통과했다. `pnpm typecheck`, `pnpm build`와 관리 재구축 명령도 통과했다.

## 추후 작업

1. **운영 사용자 인증 연결.** HTTP Gateway가 검증한 사용자 신원을 위치 갱신·게시물 생성·참여에 전달할 계약을 정하고, 현재 운영 `503` 차단을 인증 검증으로 교체한다. 현재 `X-User-Id`는 로컬·테스트 전용이다.
2. **주변 보드 검색.** H3 후보 조회, Redis GEO와 Cassandra 조회·복구, 정확한 거리 필터, 페이지·커서와 Gateway 응답 조합을 구현한다. 현재 주변 검색 API는 없다.
3. **보드 상태 변경 반영.** 게시물 만료·삭제 등 후속 이벤트와 인덱스 제거/갱신, 참여 판정에 필요한 상태 계약을 정한다. 현재 Map은 게시물의 생성 위치만 저장한다.
4. **위치 데이터 운영 정책.** 위치 보존·삭제 기간, 접근 통제, 관측 지표와 장애 복구 절차를 확정한다. 클라이언트 좌표의 GPS 위·변조 방지도 현재 계약 범위 밖이다.
5. **Stream 자체 유실 대조.** Map이 소비하기 전에 Stream 이벤트가 유실되었다면 Post Service 원본과 대조하고 재발행해야 한다.

이번 구현은 **최신 사용자 위치, 생성·참여 허가와 PostCreated 공간 인덱스**까지 제공한다. 주변 검색과 게시물 상태 변경은 아직 구현하지 않았다.
