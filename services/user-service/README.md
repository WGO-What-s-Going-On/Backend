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
