# WGO Moderation Service

게시물과 댓글의 콘텐츠 검사, 게시판 Lifecycle 판단을 담당할 서비스의 기본 프로젝트입니다. 이번 초기 세팅에는 실행 가능한 NestJS 앱, 환경설정, `GET /health/live`만 포함합니다. Redis와 OpenAI API에는 연결하지 않습니다.

## 구조

```text
src/
  app.module.ts
  main.ts
  config/configuration.ts
  health/health.controller.ts
  health/health.module.ts
test/
  configuration.test.ts
  health.test.ts
```

## 로컬 실행

Node.js 24와 pnpm 10을 사용합니다.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

기본 주소는 `http://localhost:3005`입니다. Redis 서버나 OpenAI API 키가 없어도 앱이 실행됩니다.

```bash
curl http://localhost:3005/health/live
```

응답은 `{ "service": "moderation-service", "status": "ok" }`입니다. 이 endpoint는 외부 인프라의 상태를 검사하지 않습니다.

Redis를 별도로 시험할 때만 `docker compose --profile redis up -d`로 로컬 Redis를 실행합니다. 호스트 포트 6383은 다른 서비스의 로컬 Redis 포트와 겹치지 않습니다. 향후 Post 이벤트를 실제로 소비할 때는 `REDIS_URL`을 Post Service와 같은 Redis 인스턴스로 설정해야 합니다. 현재 앱은 Redis에 연결하지 않습니다.

## 환경변수

| 이름                        | 용도                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                  | 실행 환경; 기본값 `development`                                |
| `PORT`                      | HTTP 포트; 기본값 3005, 양의 정수가 아니면 시작 실패           |
| `REDIS_URL`                 | 향후 Redis Streams에 사용할 주소                               |
| `POST_EVENT_STREAM`         | 향후 소비할 Post Stream; 기본값 `post:events`                  |
| `MODERATION_EVENT_STREAM`   | 향후 발행할 Moderation Stream 이름; 기본값 `moderation:events` |
| `MODERATION_CONSUMER_GROUP` | 향후 Post Stream 소비자 그룹; 기본값 `post-moderation`         |
| `OPENAI_API_KEY`            | 향후 Moderation API 키; 실제 값은 저장소에 커밋하지 않음       |

Stream 이름은 현재 설정 자리이며, Event DTO와 발행 계약은 후속 PR에서 확정합니다. 값을 설정해도 Consumer, Producer, OpenAI client가 시작되지는 않습니다.

## 검증

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Future Work

- Post Redis Stream Consumer
- Event idempotency / dedup
- OpenAI Moderation API 연동
- Post/Comment 콘텐츠 검사
- Moderation 결과 Event 발행
- Lifecycle projection 저장
- ACTIVE / STALE / CLOSED 판단
- 10분 Lifecycle Scheduler
- Reaction 기반 조기 종료 판단
- `moderation:events` 발행
- Notification/Post 등 downstream service 연동

데이터 저장소와 Persistence 방식은 별도 설계 후 결정합니다.
