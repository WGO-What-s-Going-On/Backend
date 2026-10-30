# User 활동·칭호·보상 계약

기준: 2026-10-31. User PostgreSQL이 보상 원본이다. Redis는 Post 입력 및 User 출력 전달에 사용한다. 크레딧 지급은 기본 OFF, 확정 칭호는 기본 ON이다.

## 계약 근거

- [Post PR #72](https://github.com/WGO-What-s-Going-On/Backend/pull/72): 조사 시 open/unmerged. 확인 SHA `70f35ac2142da954a07417a4355d2a2106880200`.
- [고정 SHA의 Post 이벤트 계약](https://github.com/WGO-What-s-Going-On/Backend/blob/70f35ac2142da954a07417a4355d2a2106880200/services/post-service/contracts/post-events.md).
- [Notion 칭호·투표 기획](https://app.notion.com/p/40733f226af7814a8059f453675ae05a?pvs=204): 소식통·리포터·특파원·천리안, 천리안은 순위 기반이라는 방향을 확인. 최근 수정일만으로 정책 승인으로 취급하지 않는다.
- [Notion 기존 칭호 조회 API](https://app.notion.com/p/3e133f226af781ad8721cd4f180600d9?pvs=204)의 오래된 `BABY_REPORTER` 예시와 최근 명칭은 다르다. 신규 카탈로그는 최근 네 명칭을 사용하지만 기존 배지·지급 데이터는 지우거나 바꾸지 않는다.
- [이전 PRD](https://app.notion.com/p/33d33f226af7838d86c501f9e67d68dd?pvs=204)의 해결사·탐정 등 과거 제안은 승인된 최신 수치 정책으로 사용하지 않았다.

## 처리 경계와 저장소

`post:events` → 검증 → PostgreSQL transaction(Inbox + Projection + Ledger + Growth + 칭호/이력 + Outbox) → commit → XACK.

Consumer Group은 기존 `post-user-rewards`, 격리는 기존 `user:post:dead`다. 그룹 생성 시작 위치는 0이며 기존 그룹은 유지한다. 원본 이벤트·그룹을 삭제하거나 trim하지 않는다. 확정 칭호의 유효 실적은 자연 만료를 유지하고 명시적 삭제를 제외한다. `XAUTOCLAIM`으로 Pending을 회수한다. User는 Post DB에 접근하지 않고 본문·좌표를 저장하지 않는다.

| 저장소 | 역할 |
| --- | --- |
| reward_inbox | eventId 중복 처리 차단, 실패 시 receipt도 rollback |
| reward_posts | 최신 postVersion의 ACTIVE/DELETED/EXPIRED 상태 |
| user_activities | 활동 고유 키, actor/beneficiary, 최신 version, 상태 및 comment_id/result_id/occurred_at |
| reward_policies | 사용한 정책 JSON. 동일 version의 내용 변경 거부 |
| credit_ledger | append-only 증감 원장. activity/event/policy 유니크 |
| user_growth | 원장 합계와 일치하는 bigint credits/growth, 현재 저장 레벨 |
| reward_entitlements | 최초 지급 정책·금액, 누적 양수 지급 횟수. 취소해도 삭제하지 않음 |
| reward_daily_usage | 사용자별 실제 지급일의 양수 지급 합계. 회수해도 한도 복원하지 않음 |
| user_level_history | 최초 설정/상승/하락 이력 |
| badges/user_badges/user_badge_history | 기존 카탈로그·현재 지급 상태와 획득/회수 이력 |
| outbox_events | 보상 결과와 같은 트랜잭션에서 저장하는 User 이벤트 |

게시물 advisory lock, 정렬된 사용자 row lock으로 동시 처리를 보호한다. 순위형 칭호가 설정된 경우 추가 global advisory lock을 사용하고 기존 순위 칭호 보유자도 같은 트랜잭션에서 갱신한다. 이는 정확성을 위한 직렬화 비용이 있으므로 운영 규모 성능 검증이 필요하다.

## Post 입력 이벤트

Redis fields는 `eventId`, `eventType`, `data`. `data`는 중첩 payload가 없는 Post envelope JSON이다. `schemaVersion:1`, `producer:post-service`, `aggregateId:post_UUID`, `eventId:evt_UUID`, `correlationId`, `occurredAt`를 검증한다. userId는 Post의 positive safe integer를 경계에서 문자열로 변환한다.

| 이벤트 | 생산자 / 스트림 | 저장·보상 대상 | 처리·지급·회수 조건 |
| --- | --- | --- | --- |
| PostCreated | Post / post:events | 작성자 활동 | 게시물 상태 기록, 작성 자체 크레딧 없음 |
| PostDeleted | Post / post:events | 해당 게시물의 모든 수혜 활동 | 최신 postVersion 적용, 최초 지급 정책 revokeOnPostDeletion에 따라 회수 |
| PostExpired | Post / post:events | 해당 게시물의 모든 수혜 활동 | 자연 만료 별도 상태, 최초 지급 정책 revokeOnExpiry에 따라 유지/회수 |
| PostCommentCreated | Post / post:events | 댓글 작성자 활동 | commentId 보존, 작성 자체 크레딧 없음 |
| PostCommentDeleted | Post / post:events | 같은 postId/commentId의 댓글 공감·투표 보상 | 댓글 비활성 projection, revokeOnCommentDeletion에 따라 회수; 옛 정책은 revokeOnPostDeletion을 fallback |
| PostReactionCreated | Post / post:events | postAuthorId | 정책에 지정한 공감만 지급, 자기 공감 제외 |
| PostReactionRemoved | Post / post:events | postAuthorId | 관계 activityVersion 적용, 최초 지급 정책 revokeOnRemoval에 따라 회수 |
| PostParticipantJoined | Post / post:events | 참여자 활동 | 참여 자체 크레딧 없음, 칭호 참여 조건 집계 |
| PostParticipantLeft | Post / post:events | 참여자 활동 | 최신 관계 버전으로 참여 비활성, 칭호 조건 재평가 |
| PostCommentReactionCreated | Post PR #72 / post:events | commentAuthorId | HELPFUL/AGREE/DIFFERENT별 명시적 정책 금액, 자기 공감 제외 |
| PostCommentReactionRemoved | Post PR #72 / post:events | commentAuthorId | removedAt 검증, 최신 관계 버전 및 최초 지급 회수 정책 |
| PostVoteWon | Post PR #72 / post:events | vote.winnerAuthorId | resultId=postId, votes>0, activityVersion=1. 댓글 작성자가 수혜자 |
| PostUpdated | Post PR #72 / post:events | 없음 | postId/authorId/category/postVersion/closedAt 검증 후 명시적으로 무시·ACK. 투표 마감/재개를 삭제나 신규 보상으로 취급하지 않음 |

댓글 공감 키는 `commentId:reaction:userId:type`, 투표 키는 `vote:resultId`다. 관계 버전 1 생성→2 취소→3 재생성을 보존한다. 새 eventId여도 같은 확정 상태는 재지급하지 않는다. 상충하는 승리자/댓글/관계 신원 또는 같은 버전의 반대 상태는 `ACTIVITY_CONFLICT`로 격리한다. 높은 버전이 이미 저장되면 늦은 낮은 버전은 상태를 덮어쓰지 못한다. 동일 버전에서 누락된 beneficiary/comment/result 문맥만 안전하게 보충할 수 있다.

기존 9종과 신규 3종은 같은 Consumer/Projection/원장을 사용한다. PostUpdated의 명시적 무시 외에 알 수 없는 타입을 성공으로 삼키지 않는다.

| DLQ reason | 의미 / 복구 |
| --- | --- |
| INVALID_EVENT | 공통 또는 해당 타입의 payload 검증 실패. 생산자 수정 후 원본 확인 |
| ACTIVITY_CONFLICT | 기존 활동 신원/버전과 충돌. 운영자가 원본 확인 후 판단, 승리자 임의 덮어쓰기 금지 |
| UNSUPPORTED_EVENT | 유효한 공통 envelope의 미지원 타입. 계약 검토 후 adapter 추가 또는 명시적 ignore 결정 |
| RETRY_EXHAUSTED | 일시 장애 재시도 한도 소진. 장애 해결 후 동일 원본 envelope/eventId로 재발행 |

DLQ는 streamId/eventId/raw data/reason을 보관한다. 성공한 Inbox를 삭제하지 않는다. DLQ 항목을 지우지 않고 원본 data의 eventId/eventType을 동일하게 `post:events`에 재발행하면 미처리 건만 반영된다. 검증을 우회한 payload 강제 반영은 제공하지 않는다. Redis 단일 인스턴스에서 격리 XADD와 ACK를 기존 Lua로 처리한다; Cluster를 지원한다고 검증하지 않았다.

## 확정 칭호와 크레딧 정책 분리

2026-10-31 최종 사용자 지시를 반영하여 칭호는 `wgo-titles-v1`의 실제 활동 조건으로 기본 활성화한다.
크레딧 정책 OFF가 공식 칭호를 끄지 않는다. 공식 네 칭호에 옛 점수 임계값 badge 규칙을 사용할 수 없다.
행정동별 최근 30일 천리안은 User 계산·저장·수신부를 구현했으나 실제 Post 지역 생산 계약이 없어 기본 준비 상태가 CONTRACT_UNAVAILABLE이다.

전체 확정 조건·스위치·자연 만료 유지·지역 계약 제안·마이그레이션·API·Notification 필드는 [WGO_TITLE_POLICY.md](WGO_TITLE_POLICY.md)를 따른다.

크레딧/성장 점수의 기존 1:1 증감·최초 지급 금액/회수 정책·gross 일일 한도·활동당 재지급 제한은 유지한다.
`USER_REWARD_POLICY_JSON`이 없으면 크레딧 지급은 계속 OFF다. 지급 수치가 승인되었다고 주장하지 않는다.
개발 JSON의 지급량·한도·levels는 재현용이며 production 승인 검증을 통과하지 않는다.

## Migration, Seed, 재평가

기존 `1792190000000-AddActivityRewards`는 유지한다. 신규 `1793360000000-CompleteActivityRewards`는 comment_id/result_id/occurred_at과 인덱스, entitlements/daily_usage를 추가한다. 기존 ledger의 최초 양수 지급 정책·금액과 횟수, 실제 지급일 합계를 backfill한다. 기존 사용자·원장·칭호·Outbox는 수정/삭제하지 않는다. `synchronize:false`를 유지한다.

과거 내부 fixture 투표 키 `vote:resultId:winnerId`도 result_id로 조회하여 기존 키·원장을 유지한다. 같은 결과의 여러 승리자가 이미 있으면 유니크 인덱스가 migration을 실패시켜 자동 병합/삭제하지 않는다. 과거 투표의 commentId는 원장에서 추론할 수 없다. 운영에 해당 데이터가 있다면 원본 문맥을 확인하여 **같은 결과의 새 eventId envelope**를 replay해 context를 보충해야 한다. 이미 처리된 같은 eventId는 Inbox에서 걸러지므로 문맥 보충이 되지 않는다.

배포 전 DB backup 및 과거 충돌/누락 조사 → migration → seed → 정책 OFF 상태로 소비 확인 → fixture를 통한 격리 검증 → 승인 정책 적용 순서다. down은 새 테이블과 컬럼을 제거하므로 신규 데이터 생성 이후 운영 down은 보조 이력 손실을 일으킨다. 단순 코드 rollback만으로 새 migration을 되돌리지 말고 backup/복구 계획에 따라 결정한다.

```sh
pnpm migration:show
pnpm migration:run
pnpm seed:badges
pnpm seed:badges
pnpm rewards:reconcile --user 123
pnpm rewards:reconcile --user 123 --apply --operation-id approved-replay-001
```

Seed는 code 유니크로 네 칭호를 insert-if-absent한다. 기존 이름/active/imageKey/부여 상태를 덮어쓰지 않는다. 이미지 asset은 미정으로 NULL이다. 정책의 모든 code가 카탈로그에 있어야 지급 트랜잭션이 진행된다.

reconcile 기본값은 원장-잔액 read-only 비교다. apply는 stable operation-id가 필수이며 게시물별 트랜잭션으로 현재 projection을 재평가한다. Inbox/원장 삭제, 기존 금액 재가격화, 임의 잔액 강제 덮어쓰기를 하지 않는다. 중간 실패 시 같은 operation-id로 이어 실행할 수 있다. 다른 상태 변화 이후 같은 operation-id를 다시 써서 원장 유니크 충돌이 나면 안전하게 rollback하므로 새 승인 작업에는 새 ID를 사용한다. 소스 이벤트가 전혀 없거나 trim되어 User projection에도 없으면 이 도구가 복원할 수 없다.

## API와 인증

| GET 경로 | 의미 |
| --- | --- |
| /api/v1/users/me/credits | 잔액·성장 score·레벨·진행 임계값 |
| /api/v1/users/me/growth | 기존 성장 조회 alias, 동일 응답 |
| /api/v1/users/me/credits/history | credit/growth 증감 원장 |
| /api/v1/users/me/badges | 기존 현재 유효 칭호 목록 재사용 |
| /api/v1/users/me/badges/history | 획득/회수 이력, code/name/정책/시각 |

이력 limit 기본20, 1..100 정수. before는 양의 bigint ID 커서, ID DESC, limit+1로 nextCursor 결정한다. credit/growth/id는 bigint 문자열이다. 기존 credit growth level은 0-based이며 크레딧 정책 비활성/미구성 시 null이다. 새 titles.currentStage/highestAchievedStage는 별도 0..4 단계다. summary policyVersion은 저장 잔액/레벨에 마지막 반영된 버전이며 현재 실행 설정과 항상 같지는 않다. 정책 버전별 실제 정의는 reward_policies와 원장에 남는다.

최신 Gateway 사용자 HS256 Access JWT → Gateway 검증/외부 identity header 제거 → 30초 ES256 서비스 JWT + 검증된 사용자 헤더 → User GatewayAuthGuard 경계를 유지한다. 보상 경로는 양쪽 허용 목록의 user-only GET이다. 직접 x-user-id만 보내면 401이다. 다른 사용자의 ID를 선택하는 보상 API는 없다.

User `/docs/openapi.json`은 내부 service-jwt와 신뢰된 문맥을 설명한다. Gateway 통합 문서는 내부 헤더를 제거하고 사용자 Bearer 인증으로 변환한다. Gateway 문서 수집 artifact는 배포 시 실제 User 문서로 재생성해야 한다. 이번 작업에서 공유 artifact를 배포/게시하지 않았다.

Post `/api/v1/posts/me/level`은 Post의 참여/공감/투표 집계에서 1-based 등급을 즉석 계산한다. User는 영속 원장과 승인 정책의 0-based 성장 레벨·독립 배지를 제공하므로 결과가 다를 수 있다. 프런트의 사용자 성장/칭호 표시는 User API를 단일 기준으로 정하고, Post의 기존 API는 Post 활동 지표로 별도 표기하거나 후속 Post 작업에서 deprecate해야 한다. 이번에는 Post 코드를 바꾸지 않았다.

## Notification 담당자용 출력 계약

Stream `user:events`; Redis fields `eventId`, `eventType`, `data`. **기존 User envelope는 `type`/`version`/`payload`이며 Post의 `eventType`/`schemaVersion` 형식으로 바꾸지 않는다.**

```json
{
  "eventId": "00000000-0000-4000-8000-000000000001",
  "type": "USER_CREDIT_CHANGED",
  "target": {"type":"USER","id":"123"},
  "occurredAt": "2026-10-31T00:00:00.000Z",
  "version": 1,
  "producer": "user-service",
  "correlationId": "request-or-reconciliation-id",
  "payload": {
    "userId":"123",
    "sourceEventId":"evt_00000000-0000-4000-8000-000000000002",
    "ledgerId":"456","delta":"10","credits":"20","growthScore":"20","policyVersion":"approved-version"
  }
}
```

| type | 같은 transaction에서 생성되는 조건 | payload 추가 필드 |
| --- | --- | --- |
| USER_CREDIT_CHANGED | 양/음 원장 entry가 실제 생성될 때 | ledgerId, delta, credits, growthScore, policyVersion |
| USER_LEVEL_CHANGED | 최초 저장 레벨 설정 또는 현재 레벨 변경 | previousLevel, level, growthScore, policyVersion, **changeType: INITIAL/UP/DOWN** |
| USER_BADGE_GRANTED | 부재/회수 상태에서 지급 상태로 실제 전환 | badgeId, policyVersion |
| USER_BADGE_REVOKED | 현재 지급 상태에서 실제 회수로 전환 | badgeId, policyVersion |

공통 payload.userId/sourceEventId와 기존 envelope/eventId/version은 유지했다. changeType만 호환 가능한 추가 필드다. sourceEventId는 보통 Post eventId이고 maintenance/CLI에서는 `reward-title:...` 또는 `reward-reconcile:...`이므로 UUID 전용 검증을 하지 않는다. badgeId는 문자열이며 code/name은 현재 출력 payload에 추가하지 않았다. Notification이 표시 문구가 필요하면 합의한 배지 카탈로그 매핑을 사용해야 한다.

기존 OutboxWorker가 저장된 envelope를 그대로 발행한다. Redis 실패 시 PENDING 유지·재시도, DB rollback 시 원장과 Outbox 동시 rollback. XADD 성공 후 DB commit/응답이 실패하면 **같은 eventId가 Redis에 여러 번 나타날 수 있는 at-least-once**다. Notification은 자체 별도 group(예: `user-notification`)을 만들고 eventId Inbox dedup + 알림 저장 transaction commit 후 XACK, XAUTOCLAIM 및 DLQ를 구현해야 한다. 최초 레벨 생성/강등을 level-up 알림으로 잘못 보내지 않도록 changeType을 확인한다. 원장/칭호별 상태와 시각을 기준으로 하며, User Outbox가 모든 사용자의 이벤트 전역 순서를 보장한다고 가정하지 않는다.

이번 작업은 User 생산자까지 검증한다. Notification Consumer/FCM, 실제 PR #72 Post 프로세스, 운영 Redis/Aurora 장애 복구는 별도 검증 대상이다.
