# CONTENT_MODERATION_DECIDED — Post 소비 계약 v1

2026-11-11. 최신 dev의 게시글·댓글 검사와 CONTENT_MODERATION_EVALUATED를 재사용한다.
이 문서는 이전 작업 브랜치의 카테고리 규칙/HIDE_COMMENT/NO_ACTION 초안을 대체한다.
그 초안은 운영 비활성·미배포 상태였으며 Post 결정 소비자는 #132에서 추가했다.

Moderation은 **숨김 결정 발행까지만** 수행한다. Post DB·소비자·실제 가시성·FE는 변경하지 않는다.

## 발행 정책과 설정

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| MODERATION_CONTENT_ENFORCEMENT_ENABLED | false | true/false만 허용. OFF면 결정용 Redis 상태 관측·발행도 하지 않음 |
| MODERATION_CONTENT_ENFORCEMENT_POLICY_VERSION | openai-flagged-hide-v1 | 적용 정책 버전. 변경·롤백 시 Post 허용 정책과 함께 관리 |
| MODERATION_CONTENT_DECISION_STREAM | moderation:content-decisions | 아래 기존 stream과 구분되는 결정 출력 |
| REDIS_URL | 기존 설정 | 검사 결과·입력 dedup·결정 상태가 같은 단일 Redis primary/DB 사용 |

기능 ON이고 **canonical OpenAI 결과의 flagged=true**인 경우에만 HIDE를 발행한다.
flagged=false는 검사 사실만 발행하며 NO_ACTION·복원·차단 해제 이벤트는 발행하지 않는다.
추가 카테고리 목록이나 score 임계값은 사용하지 않는다. 이전 POLICY_JSON 설정은 사용하지 않는다.
Post 적용 계약 확인 전에는 기본 OFF를 유지한다.

검사 결과는 moderation:content-events의 CONTENT_MODERATION_EVALUATED로 그대로 유지된다.
결정 stream은 post:events, moderation:events, moderation:content-events,
moderation:report-events 및 각 환경의 실제 설정값과 같을 수 없다.
이름 충돌·잘못된 enabled·잘못된 정책 버전·활성화 시 Redis URL 누락은 시작 단계에서 거부한다.

## Redis wire

Redis fields: `eventId`, `eventType`, `data`. data는 아래의 flat JSON이다.

```json
{
  "eventId": "evt_decision_<sha256>",
  "eventType": "CONTENT_MODERATION_DECIDED",
  "schemaVersion": 1,
  "producer": "moderation-service",
  "moderationDecisionId": "decision_<same-sha256>",
  "targetType": "POST",
  "postId": "post_<uuid>",
  "sourceEventId": "evt_<original-post-event-uuid>",
  "evaluationEventId": "evt_content_<sha256-of-sourceEventId>",
  "postVersion": 3,
  "decision": "HIDE",
  "reason": "OPENAI_MODERATION_FLAGGED",
  "policyVersion": "openai-flagged-hide-v1",
  "policyFingerprint": "<sha256-of-fixed-policy-definition>",
  "occurredAt": "2026-11-11T00:00:00.000Z",
  "correlationId": "original-correlation-id"
}
```

위 ID는 형식 설명용이며 실제로는 완전한 lowercase SHA-256을 사용한다.
COMMENT는 targetType=COMMENT, commentId와 activityVersion이 필수이며 postVersion은 포함하지 않는다.
POST는 postVersion이 필수이며 commentId/activityVersion은 포함하지 않는다.
버전은 원래 검사 대상의 양의 safe integer다. 버전이 누락된 과거 결과를 추측으로 보완하지 않는다.
본문·제목·API Key·sourceHash·SDK 오류 상세·사용자 위치는 결정 wire와 로그에 포함하지 않는다.

eventId suffix는 UTF-8 `JSON.stringify([evaluationEventId, policyVersion])`의 SHA-256이다.
moderationDecisionId도 같은 suffix를 사용한다. stream ID는 전송 cursor이며 도메인 ID가 아니다.
occurredAt은 canonical 검사 완료 시각으로 재시도에도 불변이다. Post 적용 시각이 아니다.
correlationId는 원래 검사 값이며 과거 결과에서 누락된 경우 sourceEventId로 fallback한다.
reason은 모델 flagged에 따른 결정이라는 의미이며 적용 성공·실제 삭제를 뜻하지 않는다.
policyFingerprint는 버전과 고정 규칙(flagged=true → HIDE, reason)의 SHA-256이다.

## 저장·발행·입력 ACK

1. PostCommentCreated/Updated 또는 PostCreated/Updated의 원래 버전을 API 호출 전에 관측한다.
2. 기존 검사 결과의 canonical 저장·CONTENT_MODERATION_EVALUATED 발행을 완료한다.
3. 저장된 canonical 결과로 결정한다. 경쟁 worker의 폐기된 모델 응답을 사용하지 않는다.
4. 결정 준비 데이터, 정책 fingerprint, XADD, 발행 receipt를 Lua로 처리한다.
5. 활성화된 결정 발행까지 성공하거나 stale/삭제로 안전하게 제외된 뒤에만 기존 입력 처리를 완료한다.

Lua는 격리되지만 런타임 오류를 rollback하지 않는다. TYPE은 쓰기 전에 검사한다.
XADD가 실패하면 준비 데이터가 남을 수 있고 입력은 pending이다. 재시도는 같은 결과/결정 ID와
payload를 재사용하며 OpenAI를 다시 호출하지 않는다. XADD 성공 뒤 receipt/응답 유실에서는
동일 eventId 재발행 가능성이 있으므로 **at-least-once** 계약이다.
정책 버전과 fingerprint가 기존 기록과 다르면 재사용을 거부한다.

기존 post-moderation group, pending 회수/XAUTOCLAIM cursor, lease, 5회 실패 후
moderation:post:dead에 영속 저장 후 ACK 규칙은 유지된다. 복구 후 pending 재처리 또는
DLQ 원본의 동일 sourceEventId 재발행으로 완료한다. 완료 marker를 임의 삭제하지 않는다.
기존 content:republish 명령은 검사 사실만 재발행하며 결정 stream 복구 도구가 아니다.
이미 완료된 입력을 정책 ON 전환이나 버전 변경만으로 자동 재검사/소급 결정하지 않는다.

## 수정·삭제·역순

- POST는 postVersion, COMMENT는 activityVersion별 최신 관측 버전으로 fencing한다.
  새 정상 버전을 관측한 경우에도 이전 유해 응답의 뒤늦은 결정 발행을 막는다.
- 댓글 삭제, 게시물 삭제/만료 tombstone 뒤에는 새 숨김 결정을 발행하지 않는다.
  댓글 tombstone은 이후 수정·생성 replay로 해제되지 않는다.
- 모든 성공한 모델 검사 사실은 유지할 수 있다. 과거 검사 사실의 도착 순서를 최신성으로 해석하지 않는다.
- **이미 발행된 과거 결정은 회수하지 못하며 아직 미도착한 Post 수정/삭제는 알 수 없다.**
  따라서 Post의 현재 버전 CAS가 필수다. NO_ACTION이 없다는 사실도 안전한 콘텐츠라는 증거가 아니다.

## Post 팀 필수 소비 요구사항

1. 별도 group(권장 이름 post-content-enforcement)과 replica별 consumer 이름을 사용한다.
   schema/producer/ID/대상별 버전/decision/reason/허용 policyVersion·fingerprint를 검증한다.
   producer 문자열은 인증이 아니므로 Redis ACL/TLS/사설망으로 쓰기 권한을 제한한다.
2. 적용 트랜잭션에서 현재 postVersion 또는 activityVersion이 검사 버전과 같은지 재확인한다.
   수정·삭제 경합으로 트랜잭션 재시도 시 원본 상태와 버전을 다시 읽는다.
3. moderationDecisionId/eventId receipt, 숨김 상태·가시성 변경, 필요한 카운터/투표 변경,
   적용 결과 Outbox를 같은 트랜잭션으로 저장한다. 그 후에만 XACK한다.
4. 중복은 같은 처리 결과를 반환하고, stale/이미 삭제/이미 숨김/미존재/적용 성공을 구분한다.
   영구 거부는 기록 후 ACK, 일시 DB 장애는 pending 재시도, poison은 DLQ 영속 저장 후 ACK한다.
5. **HIDE를 기존 영구 삭제 함수에 자동 매핑하지 않는다.** 숨김 상태·목록/상세/답글/미디어/검색·
   실시간 가시성과 복구 규칙은 Post가 확정해야 한다. Moderation은 Post DB를 접근하지 않는다.
6. 결정 ID·대상 버전·적용/거부 사유·처리 시각을 추적할 결과 피드백 계약을 합의한다.
   Post 피드백 생산자는 #132에서 추가했으며 Moderation/Notification 피드백 소비자는 미구현이다. Notification은 결정 발행만으로 조치 완료를 알리지 않는다.

## 운영 제약

결정 준비 데이터/발행 receipt/최신 버전/tombstone/정책 fingerprint에는 자동 TTL이 없다.
Stream replay 범위와 함께 보존·삭제·archive·용량 정책을 정해야 한다. 기존 검사 결과는 30일 보존이며,
원본 만료 뒤 새 모델 답으로 과거 결정을 자동 복원하지 않는다.
상태 key prefix는 moderation:content-target:, moderation:content-post-target:,
moderation:content-post-terminal:, moderation:content-decision:,
moderation:content-decision-published:, moderation:content-policy:다.
한 Redis primary/DB와 내구성·AOF/복제/백업/noeviction 설정이 필요하다. untagged multi-key Lua는
Redis Cluster를 지원하지 않는다. 이번 검증은 운영 장애 내구성 보장이 아니다.
readiness는 활성화 시 결정 stream TYPE과 정책 fingerprint도 검사하며 Post 적용 성공을 뜻하지 않는다.

Post 구현·조회·복구 규칙: [콘텐츠 숨김 소비 계약](../../post-service/contracts/content-decisions.md).
