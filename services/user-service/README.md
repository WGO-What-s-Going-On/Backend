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
