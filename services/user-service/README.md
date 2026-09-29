# WGO User Service

NestJS와 PostgreSQL 기반의 WGO User Service다. 사용자 프로필과 계정 상태,
카카오 로그인 및 User Service 전용 Redis 인증 세션을 관리한다.

## Prerequisites

- Node.js 24
- pnpm 10
- Docker with Docker Compose

## Local development

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

애플리케이션은 기본적으로 `http://localhost:3001`에서 실행된다.

```bash
curl http://localhost:3001/health/live
```

## Database migrations

PostgreSQL을 실행한 뒤 migration을 적용하거나 원복하고 현재 상태를 확인할 수 있다.

```bash
docker compose up -d
pnpm migration:run
pnpm migration:revert
pnpm migration:show
```

## Terms

Set the three document URLs in `.env`, seed the initial terms, and query the public endpoint.

```bash
TERMS_SERVICE_DOCUMENT_URL=https://...
TERMS_PRIVACY_DOCUMENT_URL=https://...
TERMS_LOCATION_DOCUMENT_URL=https://...

pnpm seed:terms
curl http://localhost:3001/api/v1/terms
```

## Kakao login

`.env`에 카카오 OAuth, JWT, Redis 설정을 지정한다. 모든 인증 설정값은 필수이며
TTL은 초 단위의 양의 정수다. 실제 secret은 저장소에 커밋하지 않는다.

```bash
REDIS_URL=redis://localhost:6379
KAKAO_REST_API_KEY=...
KAKAO_CLIENT_SECRET=...
KAKAO_REDIRECT_URI=...
JWT_ACCESS_SECRET=...
JWT_ISSUER=wgo-user-service
JWT_AUDIENCE=wgo-api
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=2592000
```

카카오 authorization code로 로그인한다.

```bash
curl -X POST http://localhost:3001/api/v1/auth/kakao \
  -H "Content-Type: application/json" \
  -d '{"authorizationCode":"..."}'
```

Access Token은 WGO JWT이며 Refresh Token은 opaque random token이다. 원문 Refresh
Token은 응답으로 전달되고 Redis에는 전체 토큰의 SHA-256 hash만 저장된다.

## Refresh and logout

`POST /api/v1/auth/refresh`는 Access Token 없이 `{ "refreshToken": "..." }`를 받는다.
성공 시 HTTP 200과 `{ "accessToken": "...", "refreshToken": "...", "expiresIn": 900 }`를
반환한다. `expiresIn`은 설정된 Access Token TTL이다.

Refresh Token의 `<sessionId>.<secret>`을 파싱해 세션을 직접 조회하고 timingSafeEqual로
해시를 검증한다. 같은 sessionId에 새로운 secret을 발급하며, Redis Lua의 비교 후 교체로
동시 재사용을 차단한다. 현재 TTL이 0 이하이면 거부하고 `SET KEEPTTL`로 기존 만료 시각을
유지한다. 사용자별 세션 Set은 변경하지 않는다. 잘못된 토큰은 동일한 401, Redis 장애는 503이다.

`POST /api/v1/auth/logout`은 내부 헤더 `x-user-id`, `x-session-id`로 현재 세션을 지정한다.
기존 Gateway 전달 규약이 없어 이 두 헤더를 사용한다. **이 헤더는 인증 수단이 아니다.**
운영 시 User Service는 신뢰된 Gateway에서만 접근할 수 있어야 하며, Gateway는 클라이언트가
보낸 같은 이름의 헤더를 제거하고 검증한 JWT의 `sub`, `sid`로 덮어써야 한다.
Gateway 연결 및 네트워크 접근 제한은 이번 구현에 포함되지 않는다.

소유자가 일치하면 세션 삭제와 Set의 SREM을 원자적으로 수행하고 HTTP 204를 반환한다.
이미 없는 세션도 204이며 다른 사용자의 세션은 401, Redis 장애는 503이다.
다른 기기의 세션과 PostgreSQL은 변경하지 않는다. 기존 Access JWT는 만료까지 유효하며
blacklist는 사용하지 않는다.

기존 JWT 발급기는 초 단위 iat/exp와 같은 sub/sid를 사용하므로 같은 초 안에 발급한
Access JWT 문자열은 같을 수 있다. 이번 작업에서는 JWT claim 구조를 변경하지 않는다.

## Current user profile

`GET /api/v1/users/me`와 `PATCH /api/v1/users/me`는 Gateway가 검증한 내부
`x-user-id`를 사용한다. 위 logout과 동일한 Gateway 신뢰 경계가 적용된다.
응답에는 userId, nickname, profileImageKey, status, onboardingRequired, createdAt만 포함한다.

PATCH는 nickname 및 profileImageKey의 부분 수정을 지원한다. 빈 요청과 알 수 없는 필드는
400이다. nickname은 availability API와 같은 trim/최대 30자 검증을 적용하며 다른 사용자와의
대소문자 무시 중복은 409다. profileImageKey는 최대 500자의 문자열 또는 null(삭제)을 받으며
별도 trim, 파일 존재 확인은 하지 않는다.

온보딩 미완료 사용자가 유효한 nickname을 직접 제출하면 최초 완료로 처리한다.
이미 저장된 임시 닉네임과 동일한 값을 제출해도 명시적인 설정으로 인정한다.
이미지만 수정하면 온보딩은 계속 미완료이며 이벤트를 생성하지 않는다.
온보딩 완료 이후 실제 프로필 값이 바뀔 때만 USER_PROFILE_UPDATED를 생성한다.

사용자 행의 FOR UPDATE 잠금, 프로필 수정, Outbox INSERT를 하나의 PostgreSQL 트랜잭션에서
수행한다. 최초 완료에는 USER_CREATED를 한 번만 생성한다. Outbox payload에는 전체
eventId/type/target/occurredAt/version/producer/correlationId/payload envelope를 저장한다. 초기 상태는 PENDING,
publishAttempts는 0, publishedAt은 null이다. domain payload는 userId/nickname/profileImageKey만
포함한다. 커밋된 이벤트는 아래 Outbox Worker가 Redis Streams에 발행한다.

`producer`는 `user-service`이며, `correlationId`는 HTTP Gateway가 전달하는
`x-request-id`를 사용한다. 헤더가 없거나 비어 있는 직접 호출은 요청 처리 시 UUID를 생성한다.
두 필드는 USER_CREATED와 USER_PROFILE_UPDATED 전체 envelope의 최상위에 저장한다.
기존 eventId, target, occurredAt, 숫자 version 1 및 domain payload는 유지한다.
이미 저장된 Outbox row는 소급 변경하지 않는다.

## Term consents and badges

두 API는 기존 users/me와 동일하게 Gateway가 검증해 전달한 `x-user-id`를 사용한다.
인증 context가 없거나 잘못되면 401, 사용자가 없으면 404다.

`POST /api/v1/users/me/term-consents`는 `{ "termIds": [1, 2, 3] }`를 받고
HTTP 200과 `{ "termIds": ["1", "2", "3"] }`를 반환한다. ID는 양의 정수 또는
10진수 문자열을 받으며, JavaScript 안전 정수 범위를 넘는 BIGINT는 문자열로 보내야 한다.
응답은 중복을 제거한 문자열 ID를 입력 순서대로 반환한다.

GET /api/v1/terms와 동일하게 code별 현재 시행 중인 최신 약관을 선택한다
(`effective_at DESC`, 동률이면 `id DESC`). 현재 필수 약관은 매 요청에 모두 포함해야 한다.
빈 목록, 잘못된 ID, 존재하지 않는 약관, 과거 버전, 미래 시행 약관, 필수 약관 누락은 400이다.
사용자 행 잠금과 단일 트랜잭션으로 동시 제출을 직렬화한다. 활성 동의는 agreed_at을
유지하며, 철회된 row에 재동의하면 agreed_at을 갱신하고 revoked_at을 null로 바꾼다.

`GET /api/v1/users/me/badges`는 `{ "badges": [...] }`를 반환한다. 각 항목은 문자열
badgeId, code, name, nullable description/imageKey, ISO-8601 grantedAt을 포함한다.
본인에게 부여된 미회수·활성 배지만 `granted_at DESC, badge_id DESC`로 조회하며,
없으면 빈 배열이다. 배지 부여/조건 판정은 포함하지 않는다.

두 API는 온보딩·프로필·인증 상태를 변경하지 않고 Outbox나 도메인 이벤트를 생성하지 않는다.
Redis도 사용하지 않는다.

## Withdrawal and Kakao recovery

`POST /api/v1/users/me/withdrawal`은 기존 users/me와 동일한 trusted `x-user-id`를
사용한다. ACTIVE 사용자를 WITHDRAWAL_PENDING으로 바꾸고 신청 시각 및 정확히
30일(30 × 24시간) 뒤의 복구 기한을 저장한다. withdrawn_at과 온보딩·프로필은 유지한다.
HTTP 200 응답은 `{ "status": "WITHDRAWAL_PENDING", "recoverableUntil": "<ISO-8601>" }`다.
이미 신청된 사용자는 기존 기한을 반환하고 신청 시각·기한을 갱신하거나 이벤트를 중복 생성하지 않는다.
인증 context 오류는 401, 없는 사용자는 404, SUSPENDED/WITHDRAWN 및 기한이 없는 비정상
WITHDRAWAL_PENDING 상태는 409다. SUSPENDED의 로그인 거부 정책은 유지한다.

사용자 행의 FOR UPDATE 잠금 안에서 상태 변경과 USER_WITHDRAWAL_STARTED Outbox INSERT를
수행하고 Redis 세션을 삭제한 뒤 DB를 커밋한다. 기존 RedisSessionStore의 Lua 한 번으로
`auth:user-sessions:{userId}`의 모든 sessionId에 해당하는 세션과 Set을 삭제한다.
만료된 세션이나 빈 Set도 안전하며 다른 사용자의 세션은 유지한다. 반복 신청에서도 세션을 정리한다.
Redis 실패는 503으로 반환하며 DB 변경을 롤백한다. Redis 삭제 후 DB 커밋 실패 시 세션 삭제는
되돌릴 수 없으므로 사용자가 다시 로그인해야 할 수 있다. 이는 분산 트랜잭션이 아니다.

`POST /api/v1/auth/kakao`는 복구 기한 **이전**의 WITHDRAWAL_PENDING 사용자를 행 잠금 아래
ACTIVE로 복구하고 withdrawal_requested_at/withdrawal_deadline_at을 null로 초기화한다.
USER_RESTORED Outbox를 같은 DB 트랜잭션에 저장하고 **커밋 후** 새 토큰과 세션을 발급한다.
응답에 `restoredFromWithdrawal: boolean`을 추가한다. 이번 요청이 복구했다면 true,
신규 가입·일반 로그인·동시 요청 중 이미 복구된 계정을 읽은 요청은 false다.
기한이 지났거나 없으면 401이며 WITHDRAWN으로 즉시 변경하지 않는다. WITHDRAWN 로그인도 401이다.
복구 커밋 후 Redis 저장 실패 시 503이며 계정 복구와 이벤트는 유지한다. 재로그인은 가능하고
이때 restoredFromWithdrawal은 false다. Kakao OAuth 및 JWT claim 형식은 변경하지 않는다.

두 이벤트는 기존의 전체 envelope를 Outbox JSONB에 저장한다. producer는 `user-service`,
version은 숫자 1, target은 `{ "type": "USER", "id": "<userId>" }`이며 correlationId는
`x-request-id` 또는 UUID fallback이다. eventId/type/target.id는 각각 Outbox의
event_id/event_type/aggregate_id와 일치한다. occurredAt은 생성 시각의 ISO-8601 문자열이며
초기 status는 PENDING, publish_attempts는 0, published_at은 null이다. domain payload는 각각:

- USER_WITHDRAWAL_STARTED: `{ "userId": "...", "recoverableUntil": "<ISO-8601>" }`
- USER_RESTORED: `{ "userId": "...", "status": "ACTIVE" }`

Refresh는 DB의 현재 사용자 상태를 잠금 확인하고 ACTIVE가 아니면 stale Redis 세션이
남아 있어도 401로 거부한다. 이 잠금을 rotation까지 유지하며 기존 hash 비교/CAS/TTL 정책은
유지한다. 로그인도 복구 커밋 후 ACTIVE를 다시 잠금 확인하고 세션 저장까지 잠금을 유지해
탈퇴 cleanup과 엇갈린 세션 생성을 방지한다. Redis 응답을 기다리는 동안 DB 잠금이 유지되므로
운영 시 Redis 지연·장애 및 DB connection/lock 대기를 감시해야 한다.

이미 발급된 Access JWT는 만료까지 유효하다. blacklist, 복구 DELETE API, 최종 탈퇴 Scheduler,
USER_WITHDRAWN은 포함하지 않는다. 향후 Scheduler도 동일
사용자 행 잠금과 기한 재확인이 필요하다.

## Transactional Outbox Worker

NestJS 시작 완료 시 즉시 한 배치를 처리하고 이후 주기적으로 PENDING 이벤트를 발행한다.
도메인 서비스에 Worker 의존성이나 wake 호출을 추가하지 않았다. polling은 커밋된 row만
조회하므로 요청 rollback과 분리되며, 재시작이나 신호 누락에도 발행을 복구한다.
동일 인스턴스의 실행은 겹치지 않으며, 종료 시 polling을 중단하고 진행 중인 발행을 마친 뒤
전용 Redis 연결을 닫는다. SIGINT/SIGTERM에도 Nest shutdown hook이 실행된다.

환경변수의 기본값은 다음과 같다. 모두 양의 정수다.

```bash
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_BATCH_SIZE=20
OUTBOX_REDIS_TIMEOUT_MS=2000
```

인증과 같은 `REDIS_URL`을 사용하되 기존 RedisSessionStore는 변경하지 않는다.
Publisher는 독립 ioredis 연결을 사용하고 연결·명령 timeout을 적용한다. 클라이언트의
자동 명령 재전송과 offline queue는 끄고 Worker polling에서 재시도한다.
향후 이벤트용 Redis 분리가 필요하면 publisher 연결 설정을 별도로 확장할 수 있다.
현재는 하나의 endpoint 설정을 유지하며, 소비자도 같은 Redis endpoint/DB를 사용해야 한다.

User용 Stream key가 기존 아키텍처·코드에 정의되어 있지 않아 Post의 `post:events`
규칙에 맞춰 **`user:events`**를 사용한다. transport field는 Post와 동일하다.

```text
XADD user:events *
  eventId   <outbox.payload.eventId>
  eventType <outbox.payload.type>
  data      <JSON.stringify(outbox.payload)>
```

data는 저장된 전체 User envelope 그대로다. Post의 eventType/schemaVersion/aggregateId
형식으로 변환하거나 occurredAt/eventId를 재생성하지 않는다. row와 envelope의 eventId/type이
불일치하면 경고 후 PENDING으로 남기고 자동 보정하지 않는다.

각 배치는 하나의 PostgreSQL transaction에서 `created_at ASC, event_id ASC` 순으로
최대 batchSize개의 PENDING row를 `FOR UPDATE SKIP LOCKED`로 잠근다. 여러 replica는
다른 Worker가 잠근 row를 건너뛴다. 배치 내부 순서는 결정적이지만, 여러 replica·실패 재시도
사이의 전역/사용자별 이벤트 순서까지 보장하지 않는다.

XADD 성공 시 PUBLISHED와 published_at을 저장한다. XADD 실패는 PENDING/null을 유지하고
시도 횟수만 저장한 뒤 배치를 종료해 다음 poll에서 재시도한다. 앞서 성공한 row는 함께 커밋한다.
DB/Redis 오류는 Worker가 처리하여 polling을 유지한다. publish_attempts는 **XADD 호출마다
성공·실패 모두 +1**이며, 연결 단계 실패나 envelope 불일치는 실제 호출 전이므로 증가하지 않는다.
단, transaction rollback/commit 실패/프로세스 중단에서는 카운터도 롤백되므로 절대적인
외부 호출 횟수 감사 기록이 아니라 커밋된 시도 횟수다.

Redis 네트워크 I/O 동안 DB row lock을 유지하는 방식이며 claim lease용 schema는 추가하지
않았다. 한 번의 발행 실패에서 배치를 중단해 연속 timeout으로 lock을 길게 잡지 않도록 했다.
XADD 성공 후 DB UPDATE/COMMIT 전에 실패하면 이벤트가 다시 PENDING으로 보이고 동일
eventId로 재발행된다. **At-least-once** 방식이므로 소비자는 eventId로 멱등 처리해야 한다.
Redis timeout으로 결과가 불명확한 경우에도 중복은 가능하다.

Redis가 수락한 이벤트의 장애 후 보존은 Redis persistence/replication 설정에 달려 있다.
이번 구현에는 trim/보존 기간, Outbox 정리, retry 상한, DLQ, Consumer를 추가하지 않았다.
운영에서는 미발행 건수·최장 대기 시간·반복 실패·DB lock 대기를 감시하고, 잘못된 envelope를
수동 점검해야 한다. PENDING 조회 인덱스 및 claim lease는 규모가 커질 때 별도 검토한다.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Docker image

```bash
docker build -t wgo-user-service .
```
