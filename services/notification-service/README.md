# WGO Notification Service

Post Redis Streams 이벤트를 사용자 알림으로 변환하고 DynamoDB 원본, 읽음 상태, FCM 구독 및 전달 상태를 관리합니다. Node.js 24 / pnpm 10을 사용합니다.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
docker info
docker compose --profile redis --profile dynamodb up -d
docker compose exec -T redis redis-cli PING
pnpm db:local
pnpm dev
```

- HTTP: `http://localhost:3004`, liveness: `GET /health/live`
- 전용 Redis: `redis://localhost:6382`
- 전용 DynamoDB Local: `http://127.0.0.1:8002` (in-memory, 컨테이너 재생성 시 데이터 소실)
- `db:local`은 loopback endpoint만 허용하며 고정된 가짜 Local credential을 사용합니다. 운영 AWS나 AWS 자격 증명 체인을 사용하지 않습니다.
- `REDIS_URL`이 없으면 Post consumer와 Push 복구 worker를 시작하지 않습니다. Redis, DynamoDB가 없어도 liveness는 응답합니다.

## 현재 기능

| 기능 | 상태 |
| --- | --- |
| F01 게시판 댓글 | 최상위 postAuthorId 수신, 자기 행동 제외, commentId 포함 |
| F04 게시판 공감 | CURIOUS / STILL_HAPPENING / HELPFUL / ENDED 및 과거 LIKE 재전송 |
| F06 2분 묶음 | 같은 사용자·게시물·유형. 첫 이벤트 즉시 저장·Push, 후속은 count만 증가 |
| F11 목록·읽음 | 사용자 격리, 최신순 cursor/limit, 멱등 읽음, 30일 TTL, unread 원본 검증 |
| F12 Push token | 다중 디바이스, upsert·갱신·삭제, 전역 token 소유권 보호, invalid 정리 |

F01의 알림 원본과 FCM data에 `commentId`를 포함합니다. `actionPath`는 기존 `/posts/{postId}`를 유지하며 댓글 위치 표시 UX는 클라이언트가 commentId로 적용해야 합니다. 공감 알림은 `POST_REACTED`, 댓글은 `POST_COMMENTED`입니다. 기존 저장 데이터의 `POST_LIKED`는 조회 가능하며 새 이벤트에 사용하지 않습니다.

## Post 이벤트 계약

기준 코드는 `origin/dev`의 `07769a2`와 `services/post-service/contracts/post-events.md`, `comment-vote.md`, 실제 Outbox producer입니다.

Stream은 `post:events`, group은 `post-notification`, DLQ는 `notification:post:dead`입니다. Stream의 `eventId/eventType/data`와 data 내부 식별자를 대조합니다. schemaVersion 1, producer post-service, UTC 시각, correlationId, 도메인 객체 및 사용자 ID(양의 안전 정수인 JSON number)를 검증합니다. 도메인 객체는 `data.comment` 등 최상위에 위치합니다.

| 이벤트 | 처리 |
| --- | --- |
| PostCreated | 작성자 projection 저장. 주변 조회·동의 계약이 없어 Push 없음 |
| PostCommentCreated | 작성자 댓글 알림과 묶음 처리 |
| PostReactionCreated | 4종 공감·legacy LIKE 알림과 묶음 처리. ENDED로 게시물 종료하지 않음 |
| PostParticipantJoined | 인식·ACK. 참여를 알림 구독 동의로 해석하지 않음 |
| PostReactionRemoved | activityVersion 기반 기여 제거, 역순·중복·재등록 처리 |
| PostCommentDeleted | 기여 제거·숨김·미전송 취소. USER/MODERATION 및 reason 감사 기록 |
| PostDeleted | terminal postVersion 반영, 후속 활동·미전송 Push 차단 |
| PostParticipantLeft | 인식·ACK. 참여 알림 없음 |
| PostExpired | 만료 tombstone과 후속 전송 차단. BOARD_CLOSED로 해석하지 않음 |

과거 생성 v1의 postAuthorId/activityVersion/postVersion 누락을 허용합니다. 수신자는 이벤트의 postAuthorId, 또는 실제 소비한 PostCreated 등에서 저장한 작성자 projection으로만 결정합니다. 둘 다 없으면 보류하여 pending/retry 후 DLQ에 원본과 사유를 남깁니다. 인가되지 않은 Post API를 호출하거나 수신자를 추측하지 않습니다. 재처리는 작성자 projection 확보 후 운영자가 DLQ 원본의 동일 eventId를 재발행하는 방식으로 가능합니다.

활동 버전은 댓글 ID, 또는 `(postId, userId, reactionType)`별로 비교합니다. 과거 생성은 version 1로 취급하고, 삭제/취소 tombstone보다 오래된 생성은 집계하지 않습니다. 댓글 삭제는 terminal, 공감은 version 3 이상의 재등록을 허용합니다. 게시물 삭제·만료는 늦은 PostCreated로 복구하지 않습니다. occurredAt은 상태 버전의 대체값으로 사용하지 않습니다.

## 확정된 취소·삭제 정책

- 해당 활동을 알림 count에서 한 번만 제외하며 음수를 허용하지 않습니다.
- count 0은 목록과 unread에서 제외합니다. 과거 행은 TTL까지 남을 수 있습니다.
- 미전송 Push는 현재 count와 post terminal 상태를 확인하여 취소합니다.
- 이미 전송된 Push는 회수하지 않습니다. 전송 중인 외부 요청과 삭제가 겹치면 그 Push가 도착할 수 있습니다.
- 게시물 삭제·만료는 후속 전송을 중단하며 과거 알림을 종료 알림으로 바꾸지 않습니다.

## 멱등성 및 장애 복구

Redis는 unread snapshot을 저장합니다. Redis만으로 영속 exactly-once를 보장하지 않습니다. 기존 Redis dedup/window key가 남아 있어도 영속 처리를 생략하지 않습니다.

DynamoDB transaction 하나에 다음을 함께 반영합니다.

1. post별 revision CAS와 영속 eventId 처리 기록
2. 활동별 최신 version 및 기여한 notificationId
3. recipient/post/type별 2분 window
4. Notification 생성 또는 count 증감
5. 첫 알림의 durable Push delivery 작업

DB transaction 실패 시 전부 롤백됩니다. 응답을 잃어도 같은 eventId 재처리에서 marker를 확인하므로 알림·count가 중복되지 않습니다. 2분 window는 첫 영속 반영 시각부터 시작하고 후속 이벤트로 연장하지 않습니다. Redis window가 DB보다 먼저 갱신된 과거 상태도 영속 window를 기준으로 복구합니다.

Push는 별도 PENDING → SENDING(60초 lease) → SENT/FAILED 상태입니다. 전송 중인 다른 worker의 작업은 busy로 보고 입력 이벤트를 ACK하거나 DLQ로 보내지 않습니다. 만료 lease는 재획득합니다. consumer 재처리 외에도 앱 시작 및 30초 간격 worker가 영속 미완료 작업을 복구합니다. 일시 실패는 지수 backoff(최대 5분), 영구 실패는 FAILED로 보존합니다.

FCM은 최대 500 token씩 요청합니다. 부분 응답에서 성공한 token은 제외하고 일시 실패 token만 영속 재시도하며 invalid token은 구독에서 제거합니다. invalid 정리 실패도 성공 token을 재발송하지 않습니다. 응답 유실 또는 Push 성공 후 delivery receipt 저장 실패에서는 동일 notificationId로 재전송될 수 있습니다. 외부 Push의 exactly-once는 보장하지 않으며 클라이언트도 notificationId로 중복 표시를 억제해야 합니다. token이 없는 알림은 저장 후 전달할 대상 없이 완료됩니다.

처리 성공 후 XACK, 일반 실패는 pending 유지, malformed/잘못된 지원 payload·producer·schema는 즉시 DLQ, 일반 poison event는 5회 전달 실패 후 DLQ입니다. DLQ 저장 성공 이후에만 ACK합니다. pending은 XAUTOCLAIM(기본 idle 30초)으로 복구합니다. input이 DLQ로 이동해도 이미 저장된 Push 작업은 별도 복구 대상입니다.

## DynamoDB 테이블

| 환경변수 | 기본 이름 | Partition / Sort key |
| --- | --- | --- |
| DYNAMODB_NOTIFICATIONS_TABLE | notifications | userId / notificationId |
| DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE | push-subscriptions | userId / token |
| DYNAMODB_EVENT_STATE_TABLE | notification-event-state | postId / key |

Notification ID는 저장 시각 ISO 문자열로 시작하며 사용자 partition에서 역순 조회합니다. `expiresAt`은 생성 후 30일의 epoch seconds TTL입니다. TTL 물리 삭제 전에도 만료·count 0을 조회와 unread에서 제외합니다. 읽음은 소유 사용자 key만 변경하며 이미 읽은 알림도 안전하게 반환합니다.

Redis snapshot 유실·DB commit 직후 중단·캐시 무효화 실패를 견디기 위해 unread 응답은 매번 DynamoDB의 strongly consistent count로 검증하고 Redis에 snapshot을 저장합니다. 따라서 이 구현의 unread 캐시는 DB 조회를 줄이는 용도로 사용하지 않습니다.

Push subscription의 `userId=__TOKEN_OWNER__`, `token=SHA256(token)` 행이 전역 소유권을 예약합니다. 사용자 행과 예약을 transaction으로 갱신·삭제하므로 다른 사용자가 token을 중복 소유하거나 삭제할 수 없습니다. 소유권 행이 없는 과거 데이터는 최초 upsert 전 다른 사용자 행을 대조합니다. 기존에 이미 여러 사용자에게 중복 저장된 token은 배포 전에 대조·정리해야 합니다.

Event-state의 key는 `meta`, `event#...`, `activity#...`, `window#...`, `delivery#...`입니다. event marker와 version/tombstone은 Redis 보존 기간보다 먼저 사라지면 안 되므로 자동 TTL을 설정하지 않습니다. 운영 보존·compaction 정책은 Stream replay 범위와 함께 정해야 합니다. 최초 구현의 복구 worker는 paginated Scan을 사용하므로 대량 운영 데이터에서는 delivery GSI/별도 worker가 필요합니다. FAILED 작업의 재개는 원인 해결 후 별도 운영 절차가 필요합니다.

## HTTP API와 인증 경계

| Method | Path | 기능 |
| --- | --- | --- |
| GET | /api/v1/notifications | 내 목록 (limit 1–100, cursor) |
| GET | /api/v1/notifications/unread-count | 미확인 수 |
| PATCH | /api/v1/notifications/{notificationId}/read | 내 알림 읽음 |
| PUT | /api/v1/notifications/push-subscriptions | token/platform upsert |
| DELETE | /api/v1/notifications/push-subscriptions | token 삭제 |

개발·테스트는 양의 10진수 `X-User-Id`를 사용합니다. body/query의 userId는 수신자로 사용하지 않습니다. HTTP Gateway의 proxy 경로는 존재하지만 인증된 사용자 문맥 전달 계약은 없으므로 NODE_ENV=production에서는 이 API를 503으로 차단합니다. 운영 공개는 Gateway 인증 및 서비스 간 검증 계약 반영 후 가능합니다.

## 외부 계약 blocker 및 구현하지 않은 기능

| 기능 | 실제 코드 확인 결과 / 필요한 계약 |
| --- | --- |
| F02 답글 | parentCommentId/부모 작성자 및 reply 이벤트 없음 |
| F03 댓글 공감 | 댓글 공감 HTTP/저장은 있지만 생성·취소 이벤트를 발행하지 않음 |
| F05 주변 150m | Map은 주변 게시물 ID 조회만 제공. 사용자 ID·알림 동의 범위를 반환하는 인가된 계약 필요 |
| F07 종료 예정 | 확정된 예정 시각·Lifecycle 상태 버전과 작성자/동의한 수신자 계약 필요 |
| F08 종료 | Post가 상태를 실제 적용한 뒤의 확정 종료 이벤트 필요. PostExpired와 동일시하지 않음 |
| 실시간 인앱 | Realtime Gateway의 사용자별 Notification 전달·인증 계약 없음 |
| Gateway 인증 | 검증된 사용자 신원 전달 및 외부 위조 헤더 차단/내부 검증 계약 필요 |

현재 Notion 상세 설계의 Kafka, PK/SK+GSI, PWA 전용 표현과 root 아키텍처의 Notification PostgreSQL은 기존 코드의 Redis Streams, userId/notificationId 및 DynamoDB 설계와 다릅니다. 이번 작업은 Issue #30과 실제 코드/요청 범위에 따라 DynamoDB를 유지합니다. Post/Map/Gateway/Moderation 코드나 루트 아키텍처는 수정하지 않습니다. 참여를 동의로 보거나 ENDED를 종료로 판단하지 않습니다.

Issue #30 전체는 미완료이며 외부 계약이 충족되기 전 PR을 열거나 Issue를 닫지 않습니다.

## 환경변수

`.env.example`은 로컬용입니다. 운영 환경에서는 Local endpoint를 제거하고 서비스 전용 AWS 권한/region/table을 설정해야 합니다.

| 이름 | 용도 |
| --- | --- |
| NODE_ENV / PORT | 환경 / HTTP 포트 (3004) |
| REDIS_URL | Post 입력 Stream 및 unread snapshot |
| AWS_REGION | 운영 DynamoDB region |
| DYNAMODB_ENDPOINT | DynamoDB Local endpoint. 지정 시 가짜 Local credential 사용 |
| DYNAMODB_NOTIFICATIONS_TABLE | 알림 원본 테이블 |
| DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE | 구독·token 소유권 테이블 |
| DYNAMODB_EVENT_STATE_TABLE | 이벤트·버전·window·delivery 테이블 (배포 전 생성 필수) |
| FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY | FCM service account. private key의 리터럴 \\n은 실제 줄바꿈으로 변환 |

## 검증

```bash
pnpm test
pnpm test:integration
pnpm typecheck
pnpm build
```

통합 검증은 실제 Redis, 실제 DynamoDB Local, mock FCM을 사용합니다. `NOTIFICATION_TEST_REDIS_URL` 기본값은 전용 Redis DB 15이며 비어 있지 않으면 기존 데이터를 보존하고 실패합니다. `NOTIFICATION_TEST_DYNAMODB_ENDPOINT` 기본값은 localhost:8002이며 loopback만 허용합니다. 테스트마다 UUID 테이블을 생성·삭제하고 자신이 만든 Redis key만 지웁니다. FLUSHALL/FLUSHDB는 사용하지 않습니다. 같은 DB를 사용하는 테스트 명령은 동시에 실행하지 않습니다.

이벤트 형태와 수신자 판단은 후속 PR에서 확정합니다.


## HTTP OpenAPI / Swagger

`http://localhost:3004/docs`에서 Swagger UI,
`http://localhost:3004/docs/openapi.json`에서 OpenAPI 3.0 문서를 제공한다.
Post와 같은 Nest Swagger 방식으로 첫 요청 때 생성하며 현재 구현된
`GET /health/live`만 포함한다. 알림 조회·읽음·구독·전송 API는 아직 구현되지 않아 생성하지 않는다.

Gateway의 `pnpm docs:generate`는 기존 `NOTIFICATION_SERVICE_URL`의 문서를
수집·검증한다. health는 공개 API가 아니므로 통합 paths에서는 제외하고
`x-services-without-public-operations: ["notification"]`로 구분한다.
문서 수집 실패는 전체 갱신 실패이며 기존 파일을 보존한다.
Gateway `/docs`의 안내에서도 현재 공개 HTTP operation이 없음을 표시한다.
Notification은 외부 저장소 없이 실행 가능하며 검증은 `pnpm test`를 사용한다.
