# WGO Moderation Service

Post 이벤트를 소비해 댓글을 검사하고 게시판 Lifecycle을 판단하는 NestJS 서비스입니다. Node.js 24 / pnpm 10을 사용합니다. 변경 범위는 이 서비스로 제한합니다.

## 실행

```bash
cp .env.example .env
pnpm install
pnpm dev
```

HTTP 기본값은 `http://localhost:3005`, liveness는 `GET /health/live`입니다. `REDIS_URL`이 없으면 Post Consumer는 시작하지 않습니다.

## 입력 계약과 실제 처리

현재 기준은 `origin/dev` `326b7c4`, [Post 이벤트 계약](../post-service/contracts/post-events.md)과 실제 `post-event-envelope.ts`/Outbox producer입니다. Stream은 `post:events`, group은 `post-moderation`입니다.

```text
XADD post:events * eventId <id> eventType <type> data <full JSON envelope>
```

`schemaVersion: 1`, `producer: post-service`, 식별자, UTC 시각, 양의 정수 버전/사용자 ID, aggregateId와 도메인 postId의 일치 및 처리에 필요한 payload를 검증합니다. `post`, `comment`, `reaction`, `participant`는 envelope 최상위에 있습니다. 과거 v1 생성의 추가 문맥/버전 누락은 허용하고 활동 버전은 1로 해석합니다. schemaVersion은 상태 버전으로 사용하지 않습니다.

| 이벤트 | 실제 처리 |
| --- | --- |
| PostCreated | Lifecycle을 한 번 초기화. 기존 projection/tombstone 유지. 본문 AI 검사는 미연결 |
| PostCommentCreated | 삭제/중복 버전 확인 → OpenAI → 결과 저장·검사 Stream 발행 → 댓글 상태와 meaningful activity CAS |
| PostReactionCreated | CURIOUS / STILL_HAPPENING / HELPFUL은 meaningful activity. ENDED는 조기 종료 집계. LIKE는 ACK만 수행 |
| PostParticipantJoined | 인식·ACK. meaningful activity나 알림 동의로 해석하지 않음 |
| PostReactionRemoved | 관계별 activityVersion tombstone 갱신, ENDED 조건 재확인. 새로운 활동으로 처리하지 않음 |
| PostCommentDeleted | 댓글 ID별 삭제 버전 기록. 이후 도착한 이전 생성 무시. 과거 활동 시각을 소급 취소하지 않음 |
| PostDeleted | CLOSED + DELETED tombstone, postVersion 반영, scan 제외·반응/댓글 상태 정리 |
| PostParticipantLeft | 인식·ACK. 활동 시각 변경 없음 |
| PostExpired | CLOSED + EXPIRED tombstone, postVersion 반영, scan 제외·후속 부활 차단 |

댓글/게시물 삭제의 USER 또는 MODERATION actor와 reason을 검증합니다. Post에서 이미 확정한 삭제·만료는 새 `BOARD_CLOSED` 판단으로 재발행하지 않습니다. 종료가 생성보다 먼저 도착해도 tombstone을 만듭니다. 생성보다 먼저 도착한 일반 활동은 projection을 추측해 만들지 않고 pending/retry 대상으로 둡니다.

## Lifecycle 정책

일반 비활성 정책은 `now-createdAt >= 1시간` AND `now-lastMeaningfulActivityAt >= 30분`이면 STALE, 이후 의미 있는 활동 없이 10분이면 CLOSED입니다. 조기 ENDED 전이를 제외하면 최초 1시간 ACTIVE를 유지합니다. 기존 STALE projection에서 reason이 없으면 일반 비활성 정책을 적용합니다.

Meaningful activity는 새 댓글과 CURIOUS / STILL_HAPPENING / HELPFUL 생성입니다. 실제 이벤트 occurredAt을 사용하고 저장된 활동 시각을 과거로 되돌리지 않습니다. STALE 진입 시각 이후의 새 활동이면 ACTIVE로 복귀하고 staleAt/현재 스냅샷을 정리하며 `BOARD_REACTIVATED`를 한 번 발행합니다. 이전 시각에 발생하고 늦게 도착한 활동은 새 유예 중 활동으로 해석하지 않습니다. CLOSED는 terminal입니다.

### ENDED 조기 종료 — 확정된 스냅샷 정책

1. ACTIVE에서 현재 활성 공감의 createdAt이 `(now-10분, now]`인 고유 사용자를 집계합니다. 취소된 관계와 legacy LIKE는 제외합니다.
2. ENDED 사용자가 5명 이상이고 전체 최근 공감 사용자 중 70% 이상이면 생성 후 1시간 이전에도 STALE로 전이합니다. 분모 0은 불충족이며 정수 교차 곱으로 70% 경계를 비교합니다.
3. `staleReason: ENDED`, staleAt, `endedSnapshot`을 CAS로 저장합니다. 스냅샷에는 진입 시각, 고정 windowStart, 초기 분자/분모·비율, 임계값, 확실성, 사용자별 종류·관계 버전·생성 시각을 남깁니다.
4. STALE의 10분 유예 동안 windowStart를 고정합니다. 기존 공감이 단순 시간 경과로 빠지지 않습니다. 이후 생성·취소·재등록은 최신 관계 상태에 반영하며 신규 ENDED도 집계에 포함하되 활동 시각이나 staleAt을 갱신하지 않습니다. 최초 스냅샷은 수정하지 않습니다.
5. 취소·변경으로 조건이 무효화되면 ACTIVE로 복귀합니다. 새 의미 있는 활동도 ACTIVE로 복귀합니다. 10분 경계에서 조건이 무효이면 복귀 판단을 CLOSED보다 우선합니다.
6. 조건이 유지되고 의미 있는 활동이 없으면 CLOSED로 전이하고 마지막 판단 집계를 `endedAssessment`에 저장합니다. 종료 전이는 CAS로 한 번만 발행합니다.

공감은 `(postId, userId, reactionType)`별 최신 activityVersion과 활성 여부를 저장합니다. 제거 v2 후 생성 v1은 무시하며 생성 v3 재등록은 허용합니다. 다른 종류의 버전끼리는 비교하지 않습니다. 한 사용자에게 여러 종류가 활성으로 보이면 취소 이벤트가 아직 도착하지 않았을 수 있으므로 조기 종료를 보류하고 ENDED STALE은 ACTIVE로 되돌립니다. 새 긍정 공감은 보수적으로 meaningful activity로 반영합니다.

새 PostCreated projection은 생성부터 이력을 추적합니다. 과거 구현의 projection은 공감 이력이 없으므로 첫 신규 공감 수신 후 10분간 조기 종료를 보류하고, 새 window가 확보된 이후부터 판단합니다. 운영 전환에서 정확한 전체 이력이 필요하면 원본 Stream의 충분한 보존·재생 또는 Post의 인가된 현재 공감 snapshot 계약이 필요합니다.

Scheduler는 주입 가능한 Clock과 1초 polling을 사용하며 sorted set에서 예정 ID를 최대 100개씩 선점합니다. 60초 복구 lease와 CAS가 Worker 경합을 보호합니다. 기존 projection에는 due 인덱스 백필이 필요합니다. 공감 수신 시에도 ENDED 조건을 즉시 확인합니다. 복귀 이후 일반 비활성 규칙은 독립적으로 계속 적용됩니다.

## Redis 정합성과 복구

- JSON projection `moderation:lifecycle:{postId}`에 관계 버전, 취소/삭제 tombstone, 스냅샷을 함께 보관합니다.
- `moderation:lifecycle:posts`는 scan 집합입니다. CLOSED 전이 시 같은 Lua에서 제외합니다. 기존 CLOSED 행이 남아 있어도 terminal 판정으로 새 전이를 만들지 않습니다.
- projection.version CAS와 `moderation:events` XADD를 하나의 Lua에서 처리합니다. `BOARD_STALE`, `BOARD_REACTIVATED`, `BOARD_CLOSED`의 기존 v1 envelope/payload 계약은 유지합니다. ENDED reason/근거는 내부 projection에 저장합니다.
- Lua 런타임 오류는 앞선 write를 rollback하지 않습니다. 출력 Stream과 scan index의 TYPE을 쓰기 전에 검사해 WRONGTYPE에 의한 부분 commit을 방지합니다.
- Consumer는 eventId별 30초 owner lease를 10초마다 갱신합니다. 완료·해제는 소유권을 Lua로 확인합니다. 만료 후 새 worker가 획득한 lease를 이전 worker가 변경하거나 ACK하지 않습니다. 완료 marker는 7일입니다.
- 성공한 영속 반영 뒤 ACK, 일반 실패는 pending 유지, `XAUTOCLAIM` 기본 idle 30초입니다. busy 입력은 ACK/DLQ로 넘기지 않습니다. malformed 및 5회 실패 입력은 `moderation:post:dead`에 저장한 뒤 ACK합니다. DLQ 저장이 실패하면 pending이 남습니다.
- 종료 시 진행 중인 처리·저장·ACK를 기다린 뒤 연결을 닫습니다. 아직 시작하지 않은 batch 입력은 pending으로 남겨 다음 worker가 복구합니다.

Redis 저장이 유지되는 범위에서 수신한 관계 버전/중복 이벤트의 결과가 일관됩니다. 아직 도착하지 않은 이벤트를 알아내는 watermark/현재 상태 조회 계약은 없습니다. CLOSED 뒤 도착한 과거 취소가 이미 확정된 종료를 되돌린다는 보장은 하지 않습니다. 전역 event-time 완결성이 필요하면 [외부 계약 요청](contracts/integration-gaps.md)의 snapshot/watermark가 선행되어야 합니다.

현재 구현은 기존 Redis repository를 확장합니다. root 아키텍처의 Moderation PostgreSQL 목표와는 차이가 있으며 DB 전환은 이번 변경에 포함하지 않습니다. 개발 Compose는 AOF/영속 volume을 설정하지 않습니다. 운영은 Redis의 내구성·복구 및 Stream replay 보존을 별도로 보장해야 합니다. Redis 데이터 전체 유실 후 원본 없이 정합성을 복구할 수 없습니다. tombstone/projection은 자동 TTL로 먼저 지우지 않으며 compaction은 replay 범위와 함께 정해야 합니다.

## OpenAI 처리

공식 SDK의 standalone Moderation endpoint와 `omni-moderation-latest`를 유지합니다. `flagged`, `categories`, `category_scores`, `model`을 매핑합니다. [공식 OpenAI Moderation 문서](https://developers.openai.com/api/docs/guides/moderation)에 따른 필드를 사용합니다. timeout 10초, SDK retry 최대 2회이며 API 실패/빈 결과를 정상 결정으로 저장하지 않습니다.

결과는 `moderation:content:{eventId}`에 30일간 불변 저장하고 moderation:content-events에 검사 사실을 발행합니다. Lua의 준비된 결과/발행 receipt로 XADD 실패와 응답 유실을 복구하며, 반복 발행은 같은 eventId를 유지합니다. 댓글 생성의 관계 버전도 별도로 멱등 처리합니다. API 호출 전에 삭제된 댓글은 검사하지 않습니다. 호출 중 삭제되면 완료 결과는 감사 근거로 남지만 댓글 생성의 CAS에서 삭제 버전을 확인해 활동으로 반영하지 않습니다. 게시물 삭제/만료 중 API가 완료되는 경우도 부활하지 않습니다. flagged만으로 Post/댓글을 자동 삭제하지 않습니다.

게시글 본문 검사, 확정 제재 workflow, Post 적용 피드백, Notification 종료 알림은 미연결입니다. 기존 lifecycle BOARD_CLOSED → Post EXPIRED 적용은 opt-in Consumer로 이미 구현되어 있습니다. 조사 근거와 필요한 계약은 [integration-gaps.md](contracts/integration-gaps.md)에 있습니다.

## 환경변수

| 이름 | 용도 |
| --- | --- |
| NODE_ENV / PORT | 환경 / HTTP 포트 (기본 3005) |
| REDIS_URL | 입력 Stream, projection, dedup, 결과·출력 Stream |
| POST_EVENT_STREAM | 기본 post:events |
| MODERATION_EVENT_STREAM | 기본 moderation:events (Lifecycle 전용) |
| MODERATION_CONTENT_EVENT_STREAM | 기본 moderation:content-events (검사 사실 전용) |
| MODERATION_CONSUMER_GROUP | 기본 post-moderation |
| OPENAI_API_KEY | OpenAI credential |

## 검증

```bash
pnpm test
pnpm typecheck
pnpm build
docker compose --profile redis up -d
pnpm test:integration
```

전용 Redis `localhost:6383`의 빈 DB 15를 사용합니다. `MODERATION_TEST_REDIS_URL`로 다른 빈 테스트 DB를 지정할 수 있습니다. 기존 key가 있으면 보존하고 실패하며 테스트 소유 key만 정리합니다. FLUSHDB/FLUSHALL은 사용하지 않습니다. integration/smoke/재시작 검증은 같은 DB에서 동시에 실행하지 않습니다. unit의 SDK 대역과 integration의 provider 대역은 실제 모델 정확도 검증과 구분합니다.

실제 wire → Consumer Group/XREADGROUP → ACK/Pending/XAUTOCLAIM/DLQ, Lua CAS 경합, 시간 경계, 고정 스냅샷, 중복·역순·재등록, 삭제와 검사 경합, 소유권 상실 및 graceful shutdown을 검증합니다. 테스트 Clock으로 시간을 이동하며 실제 10분을 기다리지 않습니다. XCLAIM IDLE로 PEL 나이를 조절하고 production idle 기본값은 유지합니다.

### 전용 Redis 실제 재시작 검증 (선택 실행)

다른 DB까지 비어 있는 전용 로컬 Compose Redis에서만 실행합니다. 이 테스트만 컨테이너를 재시작합니다.

```bash
MODERATION_REDIS_RESTART_TEST=1 pnpm test:integration redis-restart
```

PowerShell에서는 `$env:MODERATION_REDIS_RESTART_TEST='1'`을 설정하고 실행 후 제거합니다. 고정 주소 `redis://localhost:6383/15`와 다른 DB의 key 부재를 검사한 뒤 SAVE → 해당 Compose Redis restart → snapshot/dedup/PEL 복구 → CLOSED 단일 발행을 확인합니다. 정리 후 빈 상태도 SAVE합니다. checkpoint 뒤의 정상 재시작 검증이며 crash/AOF, 컨테이너 재생성이나 운영 장애 내구성 검증을 대신하지 않습니다. 평소 통합 실행에서는 skip합니다.

### 실제 OpenAI smoke

```bash
pnpm test:openai-smoke
```

현재 프로세스의 `OPENAI_API_KEY`가 있을 때만 실행하고 없으면 skip합니다. `.env`를 자동 검색하지 않습니다. 안전한 문장과 위협 문장을 각각 한 번 검사하고, 실제 Redis 댓글 → OpenAI → 결과 → 활동 → ACK 경로를 한 번 검사하므로 정상 실행은 API 요청 3회입니다. categories/scores/model 파싱을 확인하며 광범위한 분류 정확도 평가는 아닙니다. key와 SDK 오류 상세는 출력하지 않습니다.

## Completion update (2026-10-27)

`/health/ready`는 Redis consumer, output type, due/active 인덱스와 OpenAI key 설정을
검사합니다. 원격 OpenAI 호출 성공까지 의미하지 않습니다. 결과는 제재 결정이 아닙니다.
종료 시 관계 상태를 압축하고, Lifecycle XADD 실패 시 pendingPublication과 같은 ID로
복구합니다. 활성 projection의 이력 증가는 아직 후속 개선 대상입니다.

- [콘텐츠 검사 결과 wire·멱등성·보존](contracts/content-moderation-events.md)
- [인덱스 마이그레이션·복구·관측·성능](contracts/operations.md)
- [완성도 및 실제 검증 보고서](MODERATION_SERVICE_COMPLETION_REPORT.md)

기존 운영 데이터에는 백업 및 쓰기 중지 후 due 인덱스 백필이 필요합니다.
`pnpm lifecycle:migrate-due --cursor=0`으로 페이지 dry-run, `--apply`로 적용하고
보고된 nextCursor를 이어갑니다. 결과 재발행은 build 후 `pnpm content:republish <sourceEventId>`를
사용하며, REDIS_URL을 명시하고 원래 ID를 유지합니다. 자동 제재·Push는 수행하지 않습니다.

통합 로컬 실행에서는 Post 발행자와 Moderation/Notification 소비자가 같은 Redis endpoint/DB를 사용해야 합니다. 이번 로컬 .env는 localhost:6383으로 맞췄습니다. 서비스별 compose의 서로 다른 기본 포트는 자동으로 이벤트를 복제하지 않습니다. 실제 OpenAI smoke는 제공된 로컬 키로 통과했으며, 키가 없으면 외부 호출 전에 미설정 오류를 반환합니다.
