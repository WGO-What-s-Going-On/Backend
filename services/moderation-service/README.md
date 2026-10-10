# WGO Moderation Service

Post 이벤트를 소비해 댓글 콘텐츠를 검사하고 게시판 Lifecycle을 판단하는 NestJS 서비스입니다.

## 실행

Node.js 24와 pnpm 10을 사용합니다.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

기본 HTTP 주소는 `http://localhost:3005`이며 liveness endpoint는 `GET /health/live`입니다. `REDIS_URL`이 없으면 Post Stream consumer는 시작하지 않습니다.

## 구현된 기능

- `post:events`의 `post-moderation` Consumer Group
- `XREADGROUP`, `XAUTOCLAIM`, eventId dedup, graceful shutdown
- schemaVersion 1, `post-service` producer와 Stream field/envelope 식별자 검증
- malformed event와 5회 실패 poison event의 `moderation:post:dead` 처리
- `PostCreated`로 Redis Lifecycle projection을 멱등 초기화
- `PostCommentCreated.comment.content`를 OpenAI `omni-moderation-latest`로 검사
- moderation 결과의 flagged, categories, category scores, model을 내부 타입으로 변환하고 30일간 멱등 저장
- 댓글을 meaningful activity로 반영
- `PostReactionCreated`, `PostParticipantJoined` 인식 후 Lifecycle 변경 없이 ACK
- ACTIVE → STALE → CLOSED 및 STALE → ACTIVE 정책
- 10분 주기 Lifecycle scan과 주입 가능한 Clock
- projection CAS와 lifecycle event 발행을 하나의 Redis Lua 연산으로 처리
- `moderation:events`에 `BOARD_STALE`, `BOARD_REACTIVATED`, `BOARD_CLOSED` 발행

Lifecycle projection key는 `moderation:lifecycle:{postId}`이며 전체 scan용 post ID 집합은 `moderation:lifecycle:posts`입니다. Lifecycle event는 Post envelope와 같은 식별 필드를 사용하고 producer는 `moderation-service`입니다.

## Lifecycle 정책

- 생성 후 최초 1시간은 ACTIVE를 보장합니다.
- 생성 후 1시간이 지났고 마지막 meaningful activity 후 30분이 지나면 STALE이 됩니다.
- STALE 진입 후 10분 동안 댓글이 없으면 CLOSED가 됩니다.
- STALE 상태에서 댓글이 생성되면 ACTIVE로 복귀합니다.
- CLOSED는 terminal state입니다.
- 현재 meaningful activity는 댓글뿐입니다. LIKE와 참여 이벤트는 사용하지 않습니다.

Scheduler는 10분 polling이므로 전이 감지에는 최대 약 10분의 지연이 생길 수 있습니다.

## OpenAI 처리

공식 OpenAI SDK의 standalone Moderation endpoint와 `omni-moderation-latest`를 사용합니다. timeout은 10초, SDK retry는 최대 2회입니다. API 실패를 정상 결과로 저장하지 않으며, 처리 실패 이벤트는 ACK하지 않습니다.

댓글 moderation 결과는 `moderation:content:{eventId}`에 저장됩니다. downstream 콘텐츠 제재 event contract가 아직 없으므로 결과를 다른 서비스가 소비한다고 가정하지 않습니다.

## 현재 blocker

### 게시글 Moderation

현재 `PostCreated`에는 게시판 `content`가 없습니다. 향후 payload에 `content`가 추가되어야 게시글 moderation을 연결할 수 있습니다. WGO 게시판에는 title이 없으며 title은 필요한 계약이 아닙니다.

### Reaction Lifecycle과 조기 종료

현재 Post reaction은 LIKE뿐입니다. 실제 공감 type과 reaction 생성·변경·취소 Event Contract가 확정된 후 조기 종료 정책을 구현해야 합니다. 이번 구현은 reaction 비율이나 종료 신호를 추측하지 않습니다.

### Downstream 적용

- Post Service가 `moderation:events`의 Lifecycle event를 소비해 실제 Post 상태를 변경하는 계약과 consumer가 필요합니다.
- Notification Service가 Lifecycle event를 소비하는 계약과 consumer가 필요합니다.
- flagged 콘텐츠를 숨김·삭제·검토 대상으로 전달할 downstream Content Moderation Event Contract가 필요합니다.

Moderation Service는 Post DB를 직접 수정하거나 Notification Service를 직접 호출하지 않습니다.

## 환경변수

| 이름 | 용도 |
| --- | --- |
| `NODE_ENV` | 실행 환경 |
| `PORT` | HTTP 포트, 기본값 `3005` |
| `REDIS_URL` | Post Stream, projection, processing state와 output stream에 사용할 Redis |
| `POST_EVENT_STREAM` | 입력 Stream, 기본값 `post:events` |
| `MODERATION_EVENT_STREAM` | Lifecycle 출력 Stream, 기본값 `moderation:events` |
| `MODERATION_CONSUMER_GROUP` | Consumer Group, 기본값 `post-moderation` |
| `OPENAI_API_KEY` | OpenAI API key |

## 검증

```bash
pnpm test
pnpm typecheck
pnpm build
```

단위 테스트는 실제 OpenAI credential 없이 SDK client와 Redis repository port를 대역으로 실행합니다.

### 실제 Redis 통합 검증

```bash
docker compose --profile redis up -d
docker compose exec -T redis redis-cli PING
pnpm test:integration
```

Compose 전용 Redis(`localhost:6383`)의 DB 15를 기본으로 사용합니다. `MODERATION_TEST_REDIS_URL`로 별도의 빈 테스트 DB를 지정할 수 있습니다. 기존 key가 있으면 데이터를 보존하고 테스트를 실패시킵니다. 테스트가 만든 key만 정리하며 FLUSHDB/FLUSHALL은 사용하지 않습니다. 같은 테스트 DB를 사용하는 integration과 smoke 명령은 순서대로 실행하세요.

`dev` Post Service의 `application/commands.ts` payload와 `infrastructure/outbox.worker.ts` envelope/Stream fields를 사용합니다. 실제 consumer, result repository, Lifecycle Lua CAS, scheduler와 출력 Stream을 검증하며 OpenAI만 대역을 사용합니다. Pending recovery는 Redis XCLAIM의 IDLE 옵션으로 PEL 나이를 준비한 뒤 production XAUTOCLAIM을 실행하므로 production retry/idle 기본값을 변경하지 않습니다.

### 실제 OpenAI smoke 검증

```bash
pnpm test:openai-smoke
```

`OPENAI_API_KEY`가 현재 프로세스 환경에 있을 때만 실행합니다. Key가 없으면 `OpenAI smoke test skipped: OPENAI_API_KEY unavailable`을 출력하고 건너뜁니다. `.env`를 자동으로 읽거나 key를 찾지 않습니다.

Production adapter의 `omni-moderation-latest`로 안전한 문장과 짧은 위협 문장을 각 1회 요청하여 flagged/categories/category scores/model을 확인합니다. 두 요청이 성공하면 실제 Redis 댓글 처리→OpenAI→결과 저장→Lifecycle activity→ACK를 1회 검증합니다. 실제 분류 결과의 기대값은 smoke 확인용이며 모델 정확도 평가가 아닙니다. SDK 예외 상세와 credential은 출력하지 않습니다.
