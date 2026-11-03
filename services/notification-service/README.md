# WGO Notification Service

Post·User·Moderation Redis Streams 이벤트를 사용자 알림으로 변환하고 PostgreSQL 원본, 읽음 상태, FCM 구독 및 전달 상태를 관리합니다. Node.js 24 / pnpm 10을 사용합니다. 전체 정책은 [이벤트 계약](EVENT_CONTRACTS.md), [기능 매트릭스](NOTIFICATION_MATRIX.md), [운영 절차](OPERATIONS.md)를 참조합니다.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
docker info
docker compose --profile redis --profile postgres up -d
docker compose exec -T redis redis-cli PING
pnpm build
pnpm db:migrate
pnpm dev
```

- HTTP: `http://localhost:3004`, liveness: `GET /health/live`, readiness: `GET /health/ready`
- 전용 Redis: `redis://localhost:6382`
- PostgreSQL은 `127.0.0.1:5432/wgo_notification`이며 Compose named volume에 데이터를 보존합니다. 이미 5432를 사용 중이면 같은 서버에 전용 DB를 만들거나 포트를 변경합니다.
- `db:migrate`는 스키마를 멱등하게 초기화합니다. 앱 시작과 분리된 배포 Job으로 실행하며 실패하면 배포를 중단합니다. 앱은 실행 중 자동 DDL을 수행하지 않습니다.
- `REDIS_URL`이 없으면 Post consumer와 Push 복구 worker를 시작하지 않습니다. Redis, PostgreSQL이 없어도 liveness는 응답합니다.

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

PostgreSQL transaction 하나에 다음을 함께 반영합니다.

1. post 행 잠금과 영속 eventId 처리 기록
2. 활동별 최신 version 및 기여한 notificationId
3. recipient/post/type별 2분 window
4. Notification 생성 또는 count 증감
5. 첫 알림의 durable Push delivery 작업

DB transaction 실패 시 전부 롤백됩니다. 응답을 잃어도 같은 eventId 재처리에서 marker를 확인하므로 알림·count가 중복되지 않습니다. 2분 window는 첫 영속 반영 시각부터 시작하고 후속 이벤트로 연장하지 않습니다. Redis window가 DB보다 먼저 갱신된 과거 상태도 영속 window를 기준으로 복구합니다.

Push는 별도 PENDING → SENDING(60초 lease) → SENT/FAILED 상태입니다. 전송 중인 다른 worker의 작업은 busy로 보고 입력 이벤트를 ACK하거나 DLQ로 보내지 않습니다. 만료 lease는 재획득합니다. consumer 재처리 외에도 앱 시작 및 30초 간격 worker가 영속 미완료 작업을 복구합니다. 일시 실패는 지수 backoff(최대 5분), 영구 실패는 FAILED로 보존합니다.

FCM은 최대 500 token씩 요청합니다. 부분 응답에서 성공한 token은 제외하고 일시 실패 token만 영속 재시도하며 invalid token은 구독에서 제거합니다. invalid 정리 실패도 성공 token을 재발송하지 않습니다. 응답 유실 또는 Push 성공 후 delivery receipt 저장 실패에서는 동일 notificationId로 재전송될 수 있습니다. 외부 Push의 exactly-once는 보장하지 않으며 클라이언트도 notificationId로 중복 표시를 억제해야 합니다. token이 없는 알림은 저장 후 전달할 대상 없이 완료됩니다.

처리 성공 후 XACK, 일반 실패는 pending 유지, malformed/잘못된 지원 payload·producer·schema는 즉시 DLQ, 일반 poison event는 5회 전달 실패 후 DLQ입니다. DLQ 저장 성공 이후에만 ACK합니다. pending은 XAUTOCLAIM(기본 idle 30초)으로 복구합니다. input이 DLQ로 이동해도 이미 저장된 Push 작업은 별도 복구 대상입니다.

## PostgreSQL 저장소

Notification 전용 DB와 계정을 사용합니다. User DB를 직접 조회하지 않습니다.

| 테이블 | 소유 데이터와 제약 |
| --- | --- |
| notifications | 사용자별 알림, 읽음, 삭제, 만료와 count. 사용자·알림 ID 복합 PK |
| push_subscriptions | SHA-256 token hash PK로 전역 소유권 보장 |
| notification_preferences, notification_board_preferences | 사용자와 게시물별 수신 설정 |
| notification_posts | post revision, 작성자와 terminal 상태. 이벤트·전송 선점의 잠금 경계 |
| notification_processed_events | post·event ID 복합 PK와 처리 감사 정보 |
| notification_activities | activity version과 삭제 tombstone, 집계 참조 |
| notification_bundle_windows | recipient·post·type의 2분 묶음 |
| notification_deliveries | status, lease, due time, 시도 횟수와 전송 payload |

Notification ID는 저장 시각 ISO 문자열로 시작하며 `C` collation으로 역순 조회합니다. 생성 후 30일의 `expires_at`을 목록과 unread에서 검사합니다. `pnpm db:cleanup`은 실행당 만료 알림 1,000개까지 삭제합니다. 배포 CronJob 또는 운영 스케줄러에서 반복 실행하고 잔여 만료 건수를 감시합니다. 논리 만료는 정리 Job 성공 여부와 무관하게 적용됩니다.

Unread 응답은 PostgreSQL 원본 count로 확인하고 Redis에 snapshot을 저장합니다. Redis snapshot을 권한이나 영속성의 근거로 사용하지 않습니다. Token upsert는 unique constraint와 소유자 조건으로 다른 사용자의 등록과 삭제를 차단합니다.

Event marker와 activity tombstone은 자동 만료시키지 않습니다. Stream replay 범위를 검토한 별도 보존 정책 없이 지우면 중복 집계가 발생할 수 있습니다. 전송 복구는 due index로 최대 100개를 조회합니다. post 행 잠금 뒤 전송 상태를 다시 검사하고 60초 lease를 부여합니다. 완료 갱신은 lease ID가 같은 worker만 수행합니다. FCM 호출은 transaction 밖에서 실행합니다. FAILED 작업은 원인 해결 후 별도 운영 절차로 재개합니다.

## Cloud SQL 연결

개발·데모 GKE에서는 User와 별도 DB·IAM DB 계정을 사용합니다. `DB_CONNECTION_MODE=cloud-sql-proxy`, `DB_HOST=127.0.0.1`, `DB_TLS_MODE=disable`, `DB_USER`에 Notification IAM DB 사용자 이름을 설정하고 `DB_PASSWORD`는 넣지 않습니다. 자동 IAM 인증을 사용하는 Cloud SQL Auth Proxy가 원격 구간의 인증·암호화를 담당합니다. proxy mode에서 원격 DB_HOST는 거부합니다.

직접 운영 연결은 `DB_TLS_MODE=verify-full`과 명시적인 비밀번호가 필요합니다. `DB_TLS_CA_PATH`를 생략하면 system CA를 사용합니다. 실제 Cloud SQL 연결 및 IAM 권한은 GKE 환경에서 별도 검증해야 합니다.

## HTTP API와 인증 경계

| Method | Path | 기능 |
| --- | --- | --- |
| GET | /api/v1/notifications | 내 목록 (limit 1–100, cursor) |
| GET | /api/v1/notifications/unread-count | 미확인 수 |
| PATCH | /api/v1/notifications/{notificationId}/read | 내 알림 읽음 |
| PUT | /api/v1/notifications/push-subscriptions | token/platform upsert |
| DELETE | /api/v1/notifications/push-subscriptions | token 삭제 |

개발·테스트는 양의 10진수 `X-User-Id`를 사용합니다. body/query의 userId는 수신자로 사용하지 않습니다. 운영에서는 HTTP Gateway ES256 service JWT 서명과 사용자 claim을 검증합니다. `NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS`에 해당 Gateway 공개 키를 공급해야 합니다.

## 외부 계약 blocker 및 구현하지 않은 기능

| 기능 | 실제 코드 확인 결과 / 필요한 계약 |
| --- | --- |
| 신고 검토 결과 | REVIEWED 상태만 있고 실제 관리자 검토·결정/조치 완료 생산자는 없음 |
| 주변 150m 활성화 | 구현/로컬 검증, 기본 OFF. 별도 위치 동의 UI·User 차단 조회 서비스 키 설정과 실제 배포 검증 필요 |
| 실시간 인앱 | Realtime Gateway의 사용자별 Notification 전달·인증 계약 없음 |

답글·댓글 공감·후보/승리·칭호/레벨·버전 있는 STALE/재활성화·Post 실제 종료·신고 접수/취소·확정 삭제 제재를 구현했습니다. PostgreSQL을 알림 원본으로 사용하며 참여를 수신 동의로 보거나 ENDED/AI flagged를 확정 종료/제재로 해석하지 않습니다. 운영 GCP 검증과 로컬 검증을 구분합니다.

## 환경변수

`.env.example`은 로컬용입니다. GKE에서는 전용 IAM DB 계정과 Secret Manager 설정을 사용합니다.

| 이름 | 용도 |
| --- | --- |
| NODE_ENV, PORT | 실행 환경과 HTTP 포트 3004 |
| REDIS_URL | Post 입력 Stream 및 unread snapshot |
| DB_HOST, DB_PORT, DB_NAME, DB_USER | Notification 소유 PostgreSQL 연결 |
| DB_CONNECTION_MODE | direct 또는 cloud-sql-proxy |
| DB_PASSWORD | 직접 연결 비밀번호. IAM proxy에서는 생략 |
| DB_TLS_MODE, DB_TLS_CA_PATH | 직접 연결 서버 인증서 검증 |
| DB_POOL_MAX | Pod당 연결 수. 기본 10 |
| FIREBASE_PROJECT_ID | FCM 대상 프로젝트. GKE에서는 Workload Identity ADC 사용 |
| FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY | 선택적인 명시적 계정 키. 둘 다 설정하거나 둘 다 생략 |
| NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS | HTTP Gateway service JWT 공개 키 |

GKE의 Notification GSA에 FCM 대상 프로젝트의 `roles/firebasecloudmessaging.admin`을 부여합니다. `FIREBASE_PROJECT_ID`만 설정하면 SDK가 Workload Identity의 ADC를 사용합니다. 키 기반 연결이 필요한 경우에만 이메일과 private key를 함께 Secret Manager에서 공급합니다. 한쪽만 설정하면 시작을 거부합니다. [FCM 역할](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)과 [Firebase Admin 초기화](https://firebase.google.com/docs/admin/setup)를 참고합니다.

## 검증

```bash
pnpm test
pnpm test:integration
pnpm typecheck
pnpm build
```

통합 검증은 실제 Redis, 실제 PostgreSQL, mock FCM을 사용합니다. `NOTIFICATION_TEST_REDIS_URL` 기본값은 `redis://localhost:6382/15`이며 비어 있지 않으면 기존 데이터를 보존하고 실패합니다. `NOTIFICATION_TEST_DATABASE_URL` 기본값은 `postgres://wgo:wgo@127.0.0.1:5432/wgo_notification`입니다. 두 endpoint 모두 loopback만 허용합니다. 각 테스트는 UUID PostgreSQL schema를 만들고 자신이 만든 schema와 Redis key만 삭제합니다. FLUSHALL/FLUSHDB는 사용하지 않습니다. 같은 Redis DB를 사용하는 테스트 명령은 동시에 실행하지 않습니다.

## HTTP OpenAPI / Swagger

`http://localhost:3004/docs`에서 Swagger UI,
`http://localhost:3004/docs/openapi.json`에서 OpenAPI 3.0 문서를 제공한다.
Post와 같은 Nest Swagger 방식으로 첫 요청 때 생성하며 현재 구현된
`GET /health/live`, 알림 목록·미읽음 개수 조회, 읽음 처리, 푸시 구독 등록·삭제 경로를 포함한다.
로컬·테스트에서는 `X-User-Id`를 사용하며, 운영 알림 API는 Gateway service JWT를 검증한다.

Gateway의 `pnpm docs:generate`는 기존 `NOTIFICATION_SERVICE_URL`의 문서를
수집·검증한다. health는 통합 paths에서 제외하고 라우팅되는 알림 API를 포함한다.
문서 수집 실패는 전체 갱신 실패이며 기존 파일을 보존한다.
문서 계약 테스트는 외부 저장소 없이 `pnpm test test/openapi.test.ts`로 실행한다.
실제 알림 처리에 필요한 PostgreSQL·Redis·FCM 설정은 위 실행 절차를 따른다.
