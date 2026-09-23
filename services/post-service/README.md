# WGO Post Service

NestJS와 MongoDB 기반의 Post Service다. 생성 API는 MongoDB 트랜잭션에
도메인 데이터와 Outbox 이벤트를 함께 기록한다. Outbox Worker는 Redis Streams의
`post:events`에 이벤트를 발행한다.

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

두 번째 Compose 명령이 MongoDB 8 단일 노드 Replica Set(`rs0`)을 초기화하고
Primary 선출을 기다린다. 재실행해도 기존 설정을 유지한다. 개발용
`MONGODB_URI`는 호스트에서 실행하는 Post Service를 대상으로 한다. MongoDB
트랜잭션을 사용하려면 Replica Set이 정상 초기화되어야 한다.

애플리케이션은 기본적으로 `http://localhost:3002`에서 실행된다.

로컬·테스트 환경의 생성 API는 `X-User-Id` 헤더에 양의 정수 사용자 ID를 요구한다.
운영 환경은 실제 인증 연동 전까지 생성 요청을 거부한다. 참여 허가는 로컬·테스트에서만
개발용 대역으로 허용하고, 운영에서는 Map Service 연동 전까지 거부한다.

```bash
curl -X POST http://localhost:3002/api/v1/posts \
  -H 'Content-Type: application/json' -H 'X-User-Id: 123' \
  -d '{"title":"무슨 일인가요?","content":"현장 상황을 공유합니다.","category":"INCIDENT","latitude":37.4979,"longitude":127.0276,"radiusM":250}'
```

응답의 `postId`를 사용해 `/api/v1/posts/{postId}/comments` (`{"content":"..."}`),
`/reactions` (`{"type":"LIKE"}`), `/participants` (`{}`)에 POST할 수 있다.
새 게시물의 `expiresAt`은 `null`이며 Moderation 연동 후 설정된다. Redis Stream은
`docker compose exec redis redis-cli XRANGE post:events - +`로 확인한다.

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
