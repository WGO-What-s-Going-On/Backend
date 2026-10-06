# WGO Post Service

## WebSocket Gateway 내부 계약 (2026-09-26)

`boardId=postId`다. Gateway는 서비스 JWT로
`GET /internal/v1/posts/{postId}/status`의 ACTIVE 상태를 확인한다. 같은 인증으로
`GET /internal/v1/posts/{postId}`, `GET /internal/v1/posts/{postId}/comments`,
`POST /internal/v1/posts/{postId}/comments`를 호출한다. 서비스 JWT는 30초 수명이며
댓글 작성에는 검증된 숫자 `userId`를 담는다. `mutationId`는 사용자·게시물별로
유일하고 반복 요청은 기존 댓글을 반환한다. Outbox Worker는 트랜잭션 커밋 직후
깨우고 1초 주기 폴링을 복구용으로 유지한다.

NestJS와 MongoDB 기반의 Post Service다. 생성 API는 MongoDB 트랜잭션에
도메인 데이터와 Outbox 이벤트를 함께 기록한다. Outbox Worker는 Redis Streams의
`post:events`에 이벤트를 발행한다.

완료 범위와 다음 작업은 [작업 현황](./POST_SERVICE_STATUS.md)에 기록한다.

## 코드 구조

- `src/post/presentation`: HTTP 요청·헤더 검증과 도메인 오류의 HTTP 응답 변환
- `src/post/application`: 네 생성 Command와 별도 조회 유스케이스·포트
- `src/post/domain`: Post 상태, 생성 결과, 중복 참여·재참여 규칙
- `src/post/infrastructure`: Mongoose 저장소·Outbox Worker와 Map gRPC 클라이언트

Command와 조회 유스케이스는 포트 인터페이스에만 의존한다. `PostModule`이 포트를 Mongoose 구현과
Map Service gRPC 클라이언트에 연결한다. 생성 전 상태 조회 포트와 API 조회 포트는 분리되어 있다. 저장소 구현은 도메인 데이터와 Outbox를
같은 MongoDB 트랜잭션에서 기록한다.

## 준비 사항

- Node.js 24
- pnpm 10
- Docker와 Docker Compose

## 로컬 실행

```bash
cp .env.example .env
docker compose up -d mongo redis
docker compose run --rm mongo-init
pnpm install
pnpm dev
```

Map Service도 실행하고 `.env.example`의 `MAP_GRPC_ADDRESS`를 설정한다.
Map에 `MAP_SERVICE_TRUSTED_JWKS` 공개키와 HS256 동시 검증 버전을 먼저 배포하고
기존 Post 호출을 확인한 다음, Post에 `POST_SERVICE_SIGNING_JWK` 개인키와 ES256
버전을 배포한다. 두 키의 `kid`가 일치해야 한다. Post Service는 기본 500ms
deadline과 호출마다 새로 서명한 30초 토큰으로 두 읽기 전용 RPC를 호출한다.
키 설정 오류, 인증 실패, Map 장애·deadline 초과는 503으로 종료한다. 위치 거부는
403이다. 되돌릴 때는 기존 Post 버전으로 복귀할 수 있도록 Map의 동시 검증과
양쪽 `MAP_SERVICE_JWT_SECRET`을 유지한다. HS256 제거는 내부 인증 계약 4단계에서
수행한다. 운영 키는 비밀값으로 주입하고, 내부 gRPC 구간 TLS를 배포 전에 확인한다.
운영 후속작업과 검증 기준은 [Post→Map 인증 전환 체크리스트](../map-service/POST_MAP_AUTH_ROLLOUT.md)에 기록했다.

두 번째 Compose 명령이 MongoDB 8 단일 노드 Replica Set(`rs0`)을 초기화하고
Primary 선출을 기다린다. 재실행해도 기존 설정을 유지한다. 개발용
`MONGODB_URI`는 호스트에서 실행하는 Post Service를 대상으로 한다. MongoDB
트랜잭션을 사용하려면 Replica Set이 정상 초기화되어야 한다.

애플리케이션은 기본적으로 `http://localhost:3002`에서 실행된다.

## OpenAPI / Swagger

- Swagger UI: `http://localhost:3002/docs`
- OpenAPI JSON: `http://localhost:3002/docs/openapi.json`

공개 게시물·댓글·반응·참여 API, 내부 조회·작성 API, 생존 확인 경로를 문서화한다.
Swagger의 `X-User-Id` 헤더는 로컬·테스트용 공개 생성 API에만 사용한다.
내부 API는 문서의 `service-jwt` Bearer 인증을 사용한다. 내부 batch-get은 운영
환경에서 비활성화되어 있고, meta/status는 운영에서 서비스 JWT가 필요하다.

로컬·테스트 환경의 생성 API는 `X-User-Id` 헤더에 양의 정수 사용자 ID를 요구한다.
운영 환경은 실제 사용자 인증 연동 전까지 공개 생성·참여 요청을 거부한다.
로컬·테스트에서도 위치를 먼저 `PUT http://localhost:3003/api/v1/location`에
`X-User-Id`와 `{ "latitude": 37.4979, "longitude": 127.0276 }`로 갱신해야 한다.
생성은 요청 중심, 참여는 저장된 게시물 중심·반경에 대해 5분 이내 위치를 검사한다.
위치 거부는 403, Map 장애·deadline 초과는 503이며 이때 Post와 Outbox는 기록되지 않는다.
생성 전 gRPC 판정은 공간 인덱스를 변경하지 않는다. 인덱스 등록은 기존
`PostCreated` 이벤트를 소비하는 별도 Map 작업이다.

```bash
curl -X POST http://localhost:3002/api/v1/posts \
  -H 'Content-Type: application/json' -H 'X-User-Id: 123' \
  -d '{"title":"무슨 일인가요?","content":"현장 상황을 공유합니다.","category":"INCIDENT","latitude":37.4979,"longitude":127.0276,"radiusM":250}'
```

응답의 `postId`를 사용해 `/api/v1/posts/{postId}/comments` (`{"content":"..."}`),
`/reactions` (`{"type":"LIKE"}`), `/participants` (`{}`)에 POST할 수 있다.
새 게시물의 `expiresAt`은 `null`이며 Moderation 연동 후 설정된다. Redis Stream은
`docker compose exec redis redis-cli XRANGE post:events - +`로 확인한다.

## 조회 API

공개 조회는 인증 없이 `ACTIVE` 게시물만 반환한다. `GET /api/v1/posts/{postId}`는
게시물 상세를 반환하며, 없는·비활성 게시물은 `404`다. `GET
/api/v1/posts/{postId}/comments?limit=30&cursor=...`는 ACTIVE 댓글을 최신순으로
`{"comments":[...],"nextCursor":null}` 형태로 반환한다. `limit`은 기본 30,
허용 범위 1–100이다. 다음 페이지가 있을 때만 `nextCursor`에 불투명한 문자열이
들어간다. 잘못된 커서와 다른 게시물의 커서는 `400`이다. 응답에는 MongoDB `_id`가 없다.

내부 조회는 다음과 같다. 운영에서 batch-get은 기존대로 `503`이며,
meta/status는 서비스 JWT를 요구한다.

| 경로 | 요청·응답 |
| --- | --- |
| `POST /internal/v1/posts/batch-get` | `{"postIds":[...]}` → `{"posts":[{"postId","title","category","status","createdAt"}]}`. 최대 100개, 중복 제거, ACTIVE만 입력 순서대로 반환 |
| `GET /internal/v1/posts/{postId}/meta` | `postId`, `status`, `category`, `locationSnapshot`, `radiusM`, `expiresAt` |
| `GET /internal/v1/posts/{postId}/status` | `postId`, `status`, `expiresAt` |

내부 meta/status는 없는 게시물에 `404`를 반환하고 비활성 게시물에는 실제 상태를
포함한 `200`을 반환한다. 조회는 카운터와 Outbox를 변경하지 않는다. 주변 검색과
응답 조합은 Map Service·Gateway가 담당한다.

WS Gateway의 Stream 소비·room 브로드캐스트는 구현됐다. Map 검색을 통한 주변
조회 조합은 후속 작업이다. 진행 상태는 [작업 현황](./POST_SERVICE_STATUS.md)을 참고한다.

## 상태 확인

```bash
curl http://localhost:3002/health/live
```

예상 응답:

```json
{"service":"post-service","status":"ok"}
```

MongoDB Replica Set 상태 확인:

```bash
docker compose exec mongo mongosh --quiet --eval 'rs.status().myState'
```

`1`이면 Primary다. 데이터는 Docker 볼륨에 보존되며, DB 컨테이너만 중지하려면
`docker compose down`을 실행한다.

## 검증

```bash
pnpm typecheck
pnpm test
pnpm build
```

테스트를 개발 중 계속 실행하려면 `pnpm test:watch`를 사용한다. 통합 테스트는
MongoDB Replica Set과 Redis가 실행 중일 때 `RUN_INTEGRATION=1 pnpm test`로 실행한다.

## 유사 게시물 조회·벡터 인덱싱 기반

`POST /api/v1/posts/similar`와 Map 200개 후보 gRPC, ES 검색, 독립 Redis Streams Worker, 원본 기반 backfill/rebuild를 구현했다. 계약과 실패/복구 정책은 [semantic-search.md](contracts/semantic-search.md), HTTP 스키마는 `/docs`에서 확인한다. 공개 batch-get 최대 100개와 생성/조회 동작은 유지한다.

**실제 임베딩 모델은 미연결이다.** 일반 실행은 추천 503 `SIMILARITY_CHECK_UNAVAILABLE`, 검색 Worker 미실행이다. ES가 없어도 기존 앱 시작과 생존 확인은 가능하다. `SEMANTIC_THRESHOLD` 기본값은 없으며 실제 모델 평가 후 설정해야 한다. 환경 변수로 가짜 벡터를 활성화하는 경로는 없다. 모델 연결 시 `createEmbeddingProvider()`의 구현을 교체하면 API·Worker·CLI가 같은 포트를 사용한다. 테스트는 Nest overrideProvider 또는 생성자 주입으로만 fixture를 사용한다.

```bash
# 선택적 로컬 ES (Mongo/Redis와 별도, 보안 비활성은 loopback 개발용)
docker compose -f compose.semantic.yaml up -d --wait
pnpm semantic:init
# 모델 미연결 시 두 명령은 데이터 변경 전에 명시적으로 실패한다.
pnpm semantic:backfill
pnpm semantic:rebuild
```

backfill도 새 물리 인덱스를 검증한 뒤 별칭을 교체한다. 실행 중 Worker job이 lease를 보유하면 명령은 busy로 종료하므로 잠시 뒤 재시도한다. 긴 재구축은 `SEMANTIC_WORKER_ENABLED=false`로 소비 프로세스를 정상 종료한 뒤 수행할 수 있다. 원본 스캔 중에도 Outbox 발행은 계속되며 watermark 이후 이벤트를 따라잡는다. 실패한 인덱스는 공개하지 않는다. Stream 보존 구간 유실·원본 동시 변경으로 검증이 실패하면 원본에서 다시 실행한다.

실제 MongoDB(replica set), Redis(:6380), Cassandra(:9042, Map schema), Map gRPC 및 Elasticsearch(:9200)를 연결하는 테스트/fixture 적재 명령:

```bash
# Node 24, 설치된 Post/Map 의존성 및 Map schema.cql 필요
(cd ../map-service && pnpm build)
RUN_INTEGRATION=1 pnpm test
pnpm semantic:fixture
```

`semantic:fixture`는 테스트 전용 MongoDB와 Redis DB 14에 201개 생성 이벤트를 적재하여 실제 후보/검색/회수/재구축을 검증한다. ES 테스트 인덱스와 MongoDB는 종료 시 정리한다. 고정 벡터는 연동과 정렬을 검증하며 한국어 의미 품질을 입증하지 않는다. 모델 다운로드·ONNX·학습·양자화·성능 튜닝·운영 인증 개방은 후속 범위다.
