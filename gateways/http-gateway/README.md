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
- Redis-backed IP rate limiting: global 100 requests per minute, plus 60 location PUTs per rolling 60 seconds per IP. A location excess returns 429 with `Retry-After` before reaching Map; a Redis check failure returns 503. Shared IPs share the temporary limit. After user authentication, replace it with a user token bucket averaging one update per five seconds with a burst of two.
- CORS and security headers
- Request ID generation and propagation
- Liveness/readiness endpoints
- Upstream connection pooling, timeouts, and GET/HEAD retry
- Gateway-owned error responses

JWT authentication is intentionally deferred.


## 통합 공개 OpenAPI / Swagger (로컬·dev 전용)

Gateway 디렉터리에서 실행한다. `NODE_ENV=development`와 `.env`의
`DOCS_ENABLED=true`로 명시적으로 활성화한다. 기본값은 꺼짐이며
`NODE_ENV=production`에서는 플래그가 켜져 있어도 `/docs`, JSON, Swagger 자산
라우트를 등록하지 않는다. 테스트 환경에서도 명시적 활성화가 필요하다.

```bash
cd gateways/http-gateway
cp .env.example .env
pnpm install
# .env에서 DOCS_ENABLED=true 설정
# User, Post, Map, Notification을 각 서비스 README의 절차로 먼저 실행
pnpm docs:generate
pnpm dev
```

- Swagger UI: `http://localhost:8080/docs`
- 통합 JSON: `http://localhost:8080/docs/openapi.json`
- 갱신: 계약 또는 Gateway 설정 변경 후 `pnpm docs:generate` 재실행. Gateway 재시작은 필요 없다.

User·Post·Map·Notification이 각각 `/docs/openapi.json`을 제공해야 한다. 기본 포트는
각각 3001·3002·3003·3004이며 기존 `USER_SERVICE_URL`, `POST_SERVICE_URL`,
`MAP_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`을 재사용한다. 필요한 MongoDB,
Cassandra, Redis 등은 해당 서비스 README를 따른다. Gateway의 기본 rate limit은
Redis도 필요하며, 로컬에서 비활성화하려면 기존 `RATE_LIMIT_ENABLED=false`를 사용한다.
Moderation은 아직 OpenAPI 수집 미지원이다. Notification의 알림 조회·읽음 처리·푸시 구독
operation은 포함하고 health는 제외한다. 구버전의 health 전용 문서도 수집할 수 있으며,
공개 operation이 없을 때만 `x-services-without-public-operations`로 구분한다.
Notification 수집 실패도 전체 갱신 실패이며 기존 파일을 보존한다.
User의 `/api/v1/terms`는 서비스 문서에만 포함하며 현재 Gateway 라우팅에 없으므로 병합에서 제외한다.
새 문서 제공 서비스가 생기면 `src/openapi.ts`의 대상 목록과 테스트를 갱신한다.

수집은 서비스별 `DOCS_FETCH_TIMEOUT_MS`(기본 5000ms)로 제한한다. 모든 대상의
수집·원본 검증·병합 검증이 성공해야 `DOCS_FILE`(기본 `generated/openapi.json`,
Gateway 작업 디렉터리 기준)을 원자적으로 교체한다. 오류는 서비스·주소·타임아웃
또는 검증 실패 이유와 함께 보고하며 명령은 실패 종료한다. 일부 결과로 덮어쓰지 않는다.
파일은 Git에서 제외하며 일반 API 부팅/요청 중에는 서비스 문서를 수집하지 않는다.
문서 파일이 없거나 JSON을 읽지 못하면 문서 JSON만 503을 반환한다.
기존 파일이 있으면 마지막 성공 결과를 계속 제공하므로 계약 변경 후 반드시 갱신한다.

실패 시 대상 서비스의 문서 URL과 URL 설정, 서비스 상태를 확인한다. 중복 경로·메서드,
중복 operationId, 잘못된 참조는 서비스 소유 계약을 수정한 뒤 명령을 재실행한다.
OpenAPI는 현재 3.0.x와 문서 내 JSON 참조만 지원한다. 외부 참조, 참조형 path item,
HTTP callback은 오류로 보고한다. 원본을 변경하거나 자동으로 외부 파일을 가져오지 않는다.
3.1 도입 시 검증·병합기를 함께 확장해야 한다.

공개 경로는 `src/routes.ts`의 서비스별 prefix 경계와 일치하는 원본 HTTP operation만
포함한다. 내부/health/metrics/docs 경로와 사용되지 않는 내부 components·인증 정의는
제외한다. components와 operationId는 서비스 이름으로 구분하고 `$ref`, discriminator,
security, link 참조도 갱신한다. 통합 문서는 `servers: [{url: '/'}]`를 사용하며 경로·operation
수준 서비스 URL을 제거하므로 Try it out은 현재 접속한 Gateway origin으로 요청한다.
Swagger 자산은 `swagger-ui-dist` 로컬 의존성에서 제공한다. 문서 라우트만 로컬 HTTP용
CSP를 적용하며, 스크립트·API 요청은 같은 origin으로 제한하고 기존 API 헤더는 유지한다.

Gateway 사용자 JWT 인증은 아직 구현되지 않았다. Post·Map의 로컬 사용자 ID는 각
operation의 `X-User-Id` 파라미터로 입력한다. User의 프로필 등도 현재 `X-User-Id`를
직접 읽으며 Gateway 신원 검증은 미연결이다. 로그아웃에는 `X-Session-Id`도 필요하다.
이는 현재 로컬 테스트 문맥이며 로그인 응답의 Access JWT를 Gateway가 검증하는 기능은 없다. 내부 서비스 JWT를 Authorize에 입력하는
방식은 제공하지 않는다. 서비스 쓰기 API의 운영 차단과 모델/저장소 미준비에 따른 오류는
기존 서비스 동작을 따른다. Gateway 본문 제한, 상류 오류·타임아웃, 설정된 IP rate limit도
통합 문서에 반영한다. 이미 서비스가 사용하는 오류 상태 코드는 원본 응답을 유지하고
설명 및 `x-gateway-response`로 추가 Gateway 오류 모양을 기록한다.

`/docs`는 [기존 WebSocket 계약](../ws-gateway/README.md)의 저장소 링크만 제공한다.
WebSocket 이벤트 병합은 범위에 포함하지 않는다. 컨테이너에서 문서를 사용하려면
생성 파일을 `DOCS_FILE` 위치로 read-only 마운트하고 `DOCS_ENABLED=true`를 주입한다.
이미지에 개발 문서를 포함하지 않는다.
