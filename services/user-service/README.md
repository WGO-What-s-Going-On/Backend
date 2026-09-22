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
Token은 응답으로 한 번만 전달되고 Redis에는 SHA-256 hash만 저장된다. 현재 범위에는
refresh 및 logout endpoint가 포함되지 않는다.

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
