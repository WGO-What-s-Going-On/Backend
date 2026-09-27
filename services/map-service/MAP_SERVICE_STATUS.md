# Map Service 작업 현황

2026-09-27 기준. 이 문서는 이번 Post Service 연동에서 **실제로 구현한 Map Service 범위**와 후속 작업을 기록한다. 전체 목표 구조는 [백엔드 아키텍처](../../ARCHITECTURE.md), 현재 실행 방법은 [README](./README.md)를 참고한다.

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

## 추후 작업

1. **운영 사용자 인증 연결.** HTTP Gateway가 검증한 사용자 신원을 위치 갱신·게시물 생성·참여에 전달할 계약을 정하고, 현재 운영 `503` 차단을 인증 검증으로 교체한다. 현재 `X-User-Id`는 로컬·테스트 전용이다.
2. **게시물 공간 인덱스와 이벤트 소비.** Post Service가 발행하는 `PostCreated`를 Map Service의 독립 Redis Streams Consumer Group으로 처리한다. 보드 위치·수명주기 데이터 모델, Cassandra 영속 인덱스, Redis GEO/H3 파생 인덱스, 중복 이벤트 방지와 장애 후 재구축을 구현한다. 현재 생성 전 gRPC 판정은 인덱스를 등록하지 않는다.
3. **주변 보드 검색.** H3 후보 조회, Redis GEO와 Cassandra 조회·복구, 정확한 거리 필터, 페이지·커서와 Gateway 응답 조합을 구현한다. 현재 주변 검색 API는 없다.
4. **보드 상태 변경 반영.** 게시물 만료·삭제 등 후속 이벤트와 인덱스 제거/갱신, 참여 판정에 필요한 상태 계약을 정한다. 현재 Map은 게시물 상태를 저장하지 않는다.
5. **위치 데이터 운영 정책.** 위치 보존·삭제 기간, 접근 통제, 관측 지표와 장애 복구 절차를 확정한다. 클라이언트 좌표의 GPS 위·변조 방지도 현재 계약 범위 밖이다.

이번 구현은 **최신 사용자 위치와 생성·참여 허가**까지만 제공한다. 아키텍처 문서의 전체 Map 기능이 이미 구현된 것으로 해석하지 않는다.
