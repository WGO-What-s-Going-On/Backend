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
포함한다. Redis Streams 발행 및 Outbox worker는 구현하지 않았다.

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
