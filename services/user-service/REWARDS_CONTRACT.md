# User 활동·보상 계약

기준: 2026-10-17, Issue #35. 지급 정책의 기준은 이 작업 요청서다. Issue 본문의 과거
작성·참여 보상 제안은 적용하지 않는다. Post/Moderation/Gateway/Notification 코드는 변경하지 않는다.

## 상태와 트랜잭션

`post:events` → 검증 → `ActivityService.record` → 활동 projection → `RewardEngine.evaluate`
→ 원장·성장·칭호·User Outbox → DB commit → XACK 순서다. 정책이 없으면 projection만 저장한다.
엔진은 Redis나 Post DB를 조회하지 않는다. Post 본문·댓글 본문·좌표는 User DB에 저장하지 않는다.

Migration `1792190000000-AddActivityRewards`는 다음 테이블을 추가한다. 기존 테이블을 삭제·재작성하지 않는다.

| 테이블             | 역할 및 제약                                                                           |
| ------------------ | -------------------------------------------------------------------------------------- |
| reward_inbox       | event_id PK, 성공한 처리 이력; transaction rollback이면 receipt도 rollback             |
| reward_posts       | post_id PK, 최신 postVersion 및 ACTIVE/DELETED/EXPIRED                                 |
| user_activities    | activity_key PK, 최소 식별 정보·actor/beneficiary·버전·활성 상태·지급 가능 상태        |
| reward_policies    | version PK, 실제 사용 정책 JSON; 동일 version의 정의 변경 거부                         |
| user_growth        | user_id PK/FK, bigint 크레딧·성장 점수, nullable level 및 policy version               |
| credit_ledger      | 증가/감소 원장, (activity_key,event_id,policy_version) UNIQUE, user/activity/policy FK |
| user_level_history | 승급·강등·최초 산정 이력                                                               |
| user_badge_history | 기존 user_badges의 지급/회수 이력                                                      |

`UserActivityEntity`, `UserGrowthEntity`, `CreditLedgerEntity`를 등록한다. 조건부 upsert와 잠금은
EntityManager의 parameterized SQL을 사용한다. `synchronize`는 계속 false다.
원장과 성장 점수는 BIGINT/string으로 계산·반환하여 JS 안전 정수 밖에서도 정밀도를 유지한다.
source userId는 기존 계약대로 1..9007199254740991의 canonical decimal string이다.

한 게시글의 처리에는 PostgreSQL transaction advisory lock을 사용한다. 지급 대상 User row는
ID 오름차순으로 잠근다. 여러 게시글이 같은 사용자에게 지급해도 balance update가 유실되지 않는다.
같은 activity version은 상태를 덮어쓰지 않으며, 식별 정보/동일 버전 상태가 충돌하면 격리한다.
Post terminal 상태는 별도 버전으로 보존하므로 삭제·만료보다 늦게 도착한 하위 활동에도 적용된다.
User별 actor 활동 실적은 `activityCounts`가 projection에서 집계하며 terminal Post의 하위 활동은
유효 active 수에서 제외한다. 지급 대상별 실적은 beneficiary_id 인덱스로 조회할 수 있다.

## 실제 Post 입력

Stream field는 `eventId`, `eventType`, `data`이며 data는 다음과 같은 **평탄한 JSON**이다.
User가 발행하는 중첩 payload envelope와 다르다.

```json
{
  "eventId": "evt_00000000-0000-4000-8000-000000000001",
  "eventType": "PostReactionCreated",
  "schemaVersion": 1,
  "producer": "post-service",
  "aggregateId": "post_00000000-0000-4000-8000-000000000002",
  "correlationId": "request-id",
  "occurredAt": "2026-10-17T00:00:00.000Z",
  "reaction": {
    "postId": "post_00000000-0000-4000-8000-000000000002",
    "userId": 2,
    "type": "HELPFUL",
    "createdAt": "2026-10-17T00:00:00.000Z"
  },
  "postAuthorId": 1,
  "postCategory": "GENERAL",
  "activityVersion": 1
}
```

| 발행 중인 이벤트                           | projection key / 버전                              | 보상                           |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------ |
| PostCreated                                | postId / postVersion(구 v1 누락 시 1)              | 작성 보상 없음                 |
| PostDeleted, PostExpired                   | postId / 필수 postVersion                          | 하위 활동에 정책별 회수 판단   |
| PostCommentCreated, PostCommentDeleted     | commentId / activityVersion                        | 작성 보상 없음                 |
| PostReactionCreated, PostReactionRemoved   | postId + actorId + reaction type / activityVersion | 반응한 사람이 아닌 작성자 후보 |
| PostParticipantJoined, PostParticipantLeft | postId + actorId / activityVersion                 | 참여 보상 없음                 |

Post 타입은 CURIOUS/STILL_HAPPENING/HELPFUL/ENDED이며 과거 LIKE의 취소·재생도 허용한다.
어느 종류가 긍정적 보상 대상인지는 정책 map만 결정한다. 자기 공감은 지급하지 않는다.
구 v1 create의 optional activityVersion은 1로 해석한다. postAuthorId가 없으면
PENDING_CONTEXT로 저장한다. 후속 상위 버전에서 알려진 beneficiary를 보완할 수 있다.
remove의 버전·postAuthorId·postCategory 및 deletion의 actor/reason을 검증한다.
동일 activity의 actor/beneficiary/type/post 변경은 허용하지 않는다.

## Worker 및 장애 복구

- Consumer group `post-user-rewards`, 최초 group 생성 시작점 `0`, replica마다 UUID consumer 이름.
- XREADGROUP으로 새 항목을 최대 20개 읽고 XAUTOCLAIM으로 idle pending을 회수한다.
  XAUTOCLAIM cursor를 유지하여 큰 PEL에서도 뒤쪽 pending을 검사한다.
- `REWARDS_POLL_INTERVAL_MS=1000`, `REWARDS_PENDING_IDLE_MS=30000`, `REWARDS_MAX_ATTEMPTS=5`.
  모두 양의 정수. pending idle은 정상 DB 처리 시간보다 길게 설정한다.
- dedicated ioredis connection, 2초 connect/command timeout, offline queue/명령 자동 재전송 비활성화.
  DB/Redis 장애를 polling에서 재시도한다. 종료 시 현재 poll을 기다린 후 연결을 닫는다.
- 유효하지 않은 입력은 즉시 `user:post:dead`에 격리한다. 처리 실패는 PEL에 남기고 Redis
  delivery counter가 maxAttempts에 도달하면 격리한다. DB 장애도 재시도 한도 적용 대상이다.
- DLQ에는 streamId/eventId/data/reason(INVALID_EVENT 또는 RETRY_EXHAUSTED)을 보관한다.
  원본 payload를 로그로 출력하지 않는다. Lua로 DLQ XADD와 XACK을 원자 처리한다.
- DB commit 후 ACK 오류는 실패 횟수 소진 경로로 보내지 않는다. 다음 delivery에서 inbox를
  확인해 재지급 없이 ACK한다. DLQ 쓰기 실패 시 ACK하지 않는다.
- Redis 6.2 이상의 XAUTOCLAIM이 필요하다. 현재 Lua는 두 Stream을 함께 사용하므로
  **단일 Redis endpoint용**이다. Redis Cluster에는 hash-tag key 설계 변경이 필요하다.

복구 절차: DB/Redis 정상화 → poll/Pending 지표 확인 → DLQ 원인 수정 → 동일 eventId와
동일 envelope로 `post:events`에 재등록 → inbox/원장 정합성 확인. 이미 성공한 receipt는
지우지 않는다. producer가 잘못된 내용을 수정한다면 기존 ID를 재활용하지 말고 정정 계약을
먼저 정의한다. group/consumer를 임의 삭제하거나 기존 DB를 초기화하지 않는다.

## 정책 인터페이스

기본값은 `DISABLED_POLICY`: 지급 0, 임계값/칭호 없음, level null.
`.env`의 `USER_REWARD_POLICY_JSON`이 비어 있으면 기본값을 사용한다.
설정은 `RewardPolicy` 전체 객체이며 시작 시 검증한다. **다음 수치는 테스트 fixture일 뿐이다.**

```json
{
  "version": "fixture-only-v1",
  "enabled": true,
  "postReactions": { "HELPFUL": 10 },
  "commentReactions": { "HELPFUL": 5 },
  "voteWinner": 20,
  "revokeOnRemoval": true,
  "revokeOnPostDeletion": true,
  "revokeOnExpiry": false,
  "levels": [0, 10, 20],
  "badges": [{ "code": "TEST_TITLE", "minimumScore": 10, "revokeBelow": true }]
}
```

levels는 0부터 시작하는 엄격한 오름차순 성장 점수 임계값이다. 배열 index가 level이다.
운영에서 1부터 표시할지는 Frontend 정책 결정 사항이다. 배열이 비면 level은 null이다.
badge code는 기존 활성 badges row가 있어야 한다. 누락 시 전체 처리를 rollback하여
잘못된 설정으로 원장만 지급되는 일을 막는다. 운영 badge seed는 추가하지 않는다.

회수 시 credits와 growthScore를 같은 delta로 감소시킨다. 취소·삭제·만료 조건은 각각 별도
설정이다. 하나라도 회수 조건이면 원래 지급 net을 0으로 맞춘다. 회수하지 않는 설정이면
삭제/취소가 먼저 도착해도 원본 활동이 존재했다는 상태를 근거로 동일 보상을 유지한다.
재활성화는 회수된 entitlement를 복원할 수 있다. 설정에서 제외된 reaction은 새로 지급하지
않으며 이미 지급한 금액은 정책 버전 변경만으로 재평가·재가격 책정하지 않는다.
`credit_ledger`의 activity별 net과 desired entitlement 차이만 추가하여 중복 차감을 방지한다.

비활성/탈퇴 계정은 PENDING_ACCOUNT로 보류한다. 계정 제재에 따른 소급 무효화 규칙은 없다.
운영 활성화는 지급량뿐 아니라 일일 한도·반복 보상·제재·성장 점수 회수 방식까지 승인한 뒤
진행해야 한다. 현재 일일/반복 cap과 정책 일괄 재평가 job은 구현하지 않았다.
PENDING_POLICY/PENDING_ACCOUNT는 같은 Post에 후속 이벤트가 오면 재평가되지만,
변화가 없는 Post 전체를 자동 backfill하지 않는다.

## REST 계약

기존과 동일하게 신뢰된 Gateway의 `x-user-id`를 사용한다. User Service의 헤더 형식 검사는
JWT 인증을 대체하지 않는다. Gateway JWT 검증·헤더 덮어쓰기 및 내부 네트워크 제한 전에는
외부 공개 운영할 수 없다. 클라이언트가 직접 x-user-id를 지정하도록 구현하지 않는다.

| 메서드/경로                                              | 응답                                      |
| -------------------------------------------------------- | ----------------------------------------- |
| GET /api/v1/users/me/credits                             | GrowthResponse                            |
| GET /api/v1/users/me/growth                              | 동일 GrowthResponse, 성장 진행도 포함     |
| GET /api/v1/users/me/credits/history?limit=20&before=123 | items, nextCursor                         |
| GET /api/v1/users/me/badges                              | 기존 badges 배열, 미회수·활성 칭호만 반환 |

```json
{
  "credits": "0",
  "growthScore": "0",
  "level": null,
  "policyVersion": null,
  "rewardsEnabled": false,
  "levelFloor": null,
  "nextLevelScore": null
}
```

progress는 growthScore와 levelFloor/nextLevelScore로 계산한다. 최고 레벨의 nextLevelScore는
null이다. 비활성화 후에도 실제 저장된 credits/growthScore를 반환하되 level은 null이다.
policyVersion은 마지막 balance 갱신 정책이며 현재 설정 version과 다를 수 있다.
이력 item: id(string), activityKey, eventId, policyVersion, delta(string; 회수는 음수),
growthDelta(string), createdAt(ISO-8601). limit 기본20/최대100, before는 양의 bigint decimal.
id DESC keyset pagination으로 nextCursor는 다음 요청의 before 값이며 끝이면 null이다.
오류는 기존 Nest `{statusCode,message,error}`: 인증 헤더 누락·잘못된 ID 401,
사용자 없음 404, 잘못된 limit/cursor 400, DB 오류 500. Gateway는 기존 upstream 오류를 처리한다.

## User 성장 결과 이벤트

기존 Outbox worker가 `user:events`에 eventId/eventType/data로 발행한다.
data는 `{eventId,type,target:{type:'USER',id},occurredAt,version:1,producer:'user-service',
correlationId,payload}`다. payload 공통 필드는 userId(string), sourceEventId이다.

| type                | 추가 payload                                               | 의미                                        |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| USER_CREDIT_CHANGED | ledgerId, delta, credits, growthScore, policyVersion       | 원장 1건 반영 후 잔액; 모두 bigint는 문자열 |
| USER_LEVEL_CHANGED  | previousLevel(nullable), level, growthScore, policyVersion | 최초 산정·상승·하락 포함                    |
| USER_BADGE_GRANTED  | badgeId(string), policyVersion                             | 신규 또는 회수 후 재획득                    |
| USER_BADGE_REVOKED  | badgeId(string), policyVersion                             | threshold 미달 회수 설정 적용               |

correlationId는 원본 Post 요청을 이어받는다. occurredAt은 User 판정 시각이다.
At-least-once이며 소비자는 eventId 멱등 처리가 필요하다. 여러 outbox replica의 전역/사용자별
순서는 보장하지 않는다. ledgerId로 credit 이벤트 순서를 확인하거나 REST로 최신 값을 읽는다.
Notification은 현재 이 네 이벤트를 소비하지 않는다. 최초 level 산정이나 강등을 레벨업 알림으로
잘못 처리하지 않도록 previousLevel과 level을 비교해야 한다.

## 아직 발행되지 않는 Post 이벤트 연결 지점

**아래 이벤트는 제안 계약이며 live consumer에 등록하지 않았다.**

- `PostCommentReactionCreated` / `PostCommentReactionRemoved`: 기존 envelope 필드,
  commentReaction{postId,commentId,userId,type,createdAt[,removedAt]}, commentAuthorId,
  activityVersion(동일 commentId+userId+type 기준 단조 증가), postAuthorId, postCategory.
  commentAuthorId가 지급 대상이다. comment deletion과 관계를 연결할 commentId가 필수다.
- `PostVoteResultFinalized`: 기존 envelope 필드, voteId/resultId(불변 보상 식별자),
  resultVersion, postId, finalizedAt, winners[{commentId,authorId}], 확정 조건/동률 처리,
  result 수정·취소 가능 여부. 다중 winner 처리 시 winner별 안정적인 이벤트/보상 key가 필요하다.
- Post의 댓글 공감·투표 결과 변경과 outbox INSERT는 같은 Mongo transaction이어야 한다.
  기존 HTTP API 호출만으로는 User의 자동 보상 입력을 보장할 수 없다.

`parseFutureRewardInput`은 위 계약에서 필요한 최소 **내부 DTO**를 검증한다:
eventId/correlationId/postId/commentId, kind COMMENT_REACTION 또는 VOTE_WIN,
actorId/beneficiaryId(양의 safe integer), version, active,
reactionType 또는 resultId. vote의 actorId는 winning author로 정규화할 수 있다.
승리 key는 resultId+beneficiaryId로 같은 결과의 중복 지급을 막는다.
확정 계약 후 parser adapter → 이 함수 → ActivityService.record를 연결한다.
live parser의 supported 목록도 계약 버전에 맞춰 갱신해야 한다.
댓글 공감 삭제 시 commentId별 무효화 projection과 투표 정정 처리는 아직 없다.
이들은 확정 계약 전 운영 활성화하지 않는다. Post DB 조회나 HTTP polling은 추가하지 않는다.

## 검증 및 운영 준비

```bash
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
# 기존 개발 DB를 초기화하지 말고, 배포 전 백업·migration 검토 후 적용
pnpm migration:run
```

테스트는 매 실행마다 고유 PostgreSQL DB를 CREATE/DROP한다. Redis 보상 테스트는 DB12의
post:events/user:post:dead/user:events만 사용하며 기존 key가 있으면 삭제하지 않고 실행을 거부한다.
기존 최종 탈퇴/gRPC 회귀는 DB13, Outbox 회귀는 DB14, 인증 회귀는 DB15를 사용한다.
**테스트 전용 Redis를 사용하고 DB12/13/14/15에 개발·운영 데이터를 두지 않는다.**
운영 환경을 향해 테스트를 실행하지 않는다. 실제 Kakao 호출은 mock이며 서비스 전체 E2E와 다르다.

`ActivityService.reconcile(userId)`는 balance/growth와 원장 합계를 비교하는 내부 점검 함수다.
자동 수리·관리자 공개 API는 없다. 운영에서는 lag/PEL idle·delivery count/DLQ/DB lock 대기/
PENDING outbox 최장 대기/원장 불일치를 모니터링해야 한다. retention·backfill·정책 승인과
개인정보 처리 기준은 [완성도 보고서](USER_SERVICE_COMPLETION_REPORT.md)를 따른다.
