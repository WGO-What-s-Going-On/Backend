# WGO User Service

NestJS와 PostgreSQL 기반의 WGO User Service다. 현재는 애플리케이션 bootstrap,
데이터베이스 연결, liveness endpoint만 제공하며 사용자 도메인 기능은 포함하지 않는다.

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
