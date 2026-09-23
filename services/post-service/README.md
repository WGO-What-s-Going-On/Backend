# WGO Post Service

NestJS와 MongoDB 기반의 Post Service 초기 프로젝트다. 현재는 애플리케이션 기동,
MongoDB 연결, liveness endpoint와 Vitest 설정만 포함한다. 게시물 API와 Outbox
Worker는 [상세 설계](./PostService_Architecture.md)에 따라 이후 구현한다.

## 준비 사항

- Node.js 24
- pnpm 10
- Docker와 Docker Compose

## 로컬 실행

```bash
cp .env.example .env
docker compose up -d mongo
docker compose run --rm mongo-init
pnpm install
pnpm dev
```

두 번째 Compose 명령이 MongoDB 8 단일 노드 Replica Set(`rs0`)을 초기화하고
Primary 선출을 기다린다. 재실행해도 기존 설정을 유지한다. 개발용
`MONGODB_URI`는 호스트에서 실행하는 Post Service를 대상으로 한다. MongoDB
트랜잭션을 사용하려면 Replica Set이 정상 초기화되어야 한다.

애플리케이션은 기본적으로 `http://localhost:3002`에서 실행된다.

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

테스트를 개발 중 계속 실행하려면 `pnpm test:watch`를 사용한다. 현재 테스트는
DB 없이 liveness endpoint를 확인한다.
