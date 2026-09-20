# WGO HTTP Gateway

Local-first transparent HTTP gateway built with Fastify and TypeScript.

## Prerequisites

- Node.js 20, 22, 24, or 26
- pnpm 10+
- Docker with Docker Compose

## Local development

```bash
cp .env.example .env
docker compose up -d redis
pnpm install
pnpm dev
```

The gateway listens on `http://127.0.0.1:8080` by default.

```bash
curl http://127.0.0.1:8080/health/live
curl http://127.0.0.1:8080/health/ready
```

The server loads `.env` automatically when the file exists. Defaults also match
`.env.example`, so local service-specific overrides are optional.

## Local route table

| Prefix | Local upstream |
| --- | --- |
| `/api/v1/auth` | `http://127.0.0.1:3001` |
| `/api/v1/users` | `http://127.0.0.1:3001` |
| `/api/v1/posts` | `http://127.0.0.1:3002` |
| `/api/v1/location` | `http://127.0.0.1:3003` |
| `/api/v1/notifications` | `http://127.0.0.1:3004` |
| `/api/v1/moderation` | `http://127.0.0.1:3005` |

The gateway preserves the matched prefix and streams the upstream response. It
does not aggregate or reshape service payloads.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run both Redis and the gateway in containers when needed:

```bash
docker compose --profile gateway up --build
```

In that profile, downstream services still run on the local host and are
reached through `host.docker.internal`.

## Current scope

- Transparent routing to all local services
- Redis-backed IP rate limiting
- CORS and security headers
- Request ID generation and propagation
- Liveness/readiness endpoints
- Upstream connection pooling, timeouts, and GET/HEAD retry
- Gateway-owned error responses

JWT authentication is intentionally deferred.
