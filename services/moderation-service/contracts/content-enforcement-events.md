# 콘텐츠 숨김 결정 계약 — QA 이슈 8

2026-11-09. **Moderation 생산자만 구현했으며 기본 비활성이다.** Post 소비자와
실제 숨김 저장 모델, 적용 결과 피드백은 팀 합의·구현 전이다. 이 문서는 Post에
전달할 소비 계약이며 운영 활성화 승인이 아니다. Post Service는 이번에 수정하지 않았다.

## 책임과 활성화 조건

| 단계 | 사실·명령 | 소유자 / 현재 상태 |
| --- | --- | --- |
| 탐지 | `CONTENT_MODERATION_EVALUATED` | 기존 댓글 생성·수정 검사, 모델 flagged/categories/scores 기록 |
| 제재 결정 | `CONTENT_MODERATION_DECIDED` | 승인된 정책을 명시적으로 설정한 경우에만 생산, 기본 OFF |
| 차단 적용 | 현재 댓글 버전 대조 후 숨김 커밋 | Post 담당, 미구현 |
| 적용 결과 | 적용·거부·실패와 원인 결정 연결 | Post 담당과 피드백 계약 합의 필요, 미구현 |

`flagged=true`는 삭제 승인이 아니다. OpenAI의 카테고리는 욕설 사전과 다르며,
안전 안내 문장도 violence로 탐지될 수 있다. 임의 점수 임계값, 금칙어 목록,
기본 차단 카테고리를 추가하지 않았다. Lifecycle/신고 판단은 이 정책의 입력이 아니다.

다음 설정을 **모두** 검토한 뒤에만 활성화한다.

- `MODERATION_CONTENT_ENFORCEMENT_ENABLED=false`가 기본값. `true`/`false`만 허용.
- `MODERATION_CONTENT_ENFORCEMENT_POLICY_JSON`: 아래 구조의 명시적인 승인 정책.
- `REDIS_URL`: 기존 검사 원본과 같은 Redis endpoint/DB.
- `MODERATION_CONTENT_DECISION_STREAM`: 기본 `moderation:content-decisions`.
  Post 입력·Lifecycle 출력·검사 결과·신고 출력과 같은 이름은 활성화 시 거부한다.

정책 구조(운영용 정책 예시가 아니라 필드 정의):

```ts
type ApprovedPolicy = {
  policyVersion: string; // 1~128자 식별자. 규칙 변경 시 반드시 새 버전
  approvedBy: string; // 팀의 승인 기록 식별자. 사용자 본문이나 비밀값 금지
  approvedAt: string; // UTC ISO timestamp
  rules: Array<{
    ruleId: string;
    category: string; // 아래의 지원 카테고리 중 팀이 명시적으로 승인한 값
  }>;
};
```

승인된 규칙 중 하나라도 해당 카테고리의 boolean이 true이면 `HIDE_COMMENT`,
모두 false이면 `NO_ACTION`이다. 전체 flagged나 score는 이 규칙을 대신하지 않는다.
지원 카테고리는 harassment, harassment/threatening, hate, hate/threatening,
illicit, illicit/violent, self-harm, self-harm/intent, self-harm/instructions,
sexual, sexual/minors, violence, violence/graphic이다.
중복 ruleId, 알 수 없는 카테고리/필드/임계값 문법, 빈 규칙은 거부한다.
모델 결과에 설정한 카테고리가 없으면 정상 콘텐츠로 간주하지 않고 실패·재시도한다.
정책 JSON의 승인 필드는 운영자의 승인 근거이지 인증·전자서명 검증이 아니다.
환경변수 변경 권한과 실제 팀 승인 절차는 배포 시스템에서 통제해야 한다.

승인 정책이 없으므로 저장소에는 실행 가능한 운영 차단 규칙을 싣지 않았다.
테스트의 `qa8-test-v1`은 합성 fixture 전용이다. 현재 설정을 켜거나 운영에 복사하지 않는다.

## Redis wire v1

Stream은 `moderation:content-decisions`, 필드는 기존과 같이 `eventId`, `eventType`,
`data`이며 data는 아래 필드의 flat JSON이다. 검사 이벤트와 stream을 혼합하지 않는다.

| 필드 | 형식 / 의미 |
| --- | --- |
| eventId | `evt_decision_` + identity의 lowercase SHA-256 |
| moderationDecisionId | `decision_` + 같은 identity |
| eventType | `CONTENT_MODERATION_DECIDED` |
| schemaVersion / producer | `1` / `moderation-service` |
| correlationId | 검사 결과의 원래 correlationId. 과거 결과는 sourceEventId fallback |
| occurredAt / evaluatedAt | 원래 canonical 검사 완료 UTC 시각. 재시도 시 변경하지 않음 |
| sourceEventId | 원래 PostCommentCreated / PostCommentUpdated의 eventId |
| evaluationEventId | 기존 `evt_content_<sha256(sourceEventId)>` |
| targetType | `COMMENT`만 지원 |
| postId / commentId | 검사를 수행한 원래 대상 ID |
| activityVersion | 검사한 댓글 본문 버전, 양의 safe integer 필수 |
| action | `HIDE_COMMENT` 또는 `NO_ACTION` |
| policyVersion / policyFingerprint | 승인 정책 버전과 정규화 정책 SHA-256 |
| matchedRuleIds | 정렬된 적용 규칙 식별자 배열. NO_ACTION은 빈 배열 |

identity 입력은 `JSON.stringify([evaluationEventId, policyVersion])`의 UTF-8이다.
같은 검사·정책 버전은 같은 결정 ID를 사용한다. 서로 다른 정책 버전의 결정 사이에
시간/사전순 우선순위를 추정하지 않는다. Post는 승인한 policyVersion/fingerprint만
소비해야 하며 정책 교체·롤백 시 허용 집합은 팀이 정한다.

occurredAt은 전송 시각이나 Post의 적용 시각이 아니다. 이미 완료한 입력을 새 정책으로
자동 재검사/재결정하지 않는다. 정책 변경 후 소급 재처리는 별도 승인된 작업이다.
원문 본문, sourceHash, API 키, reviewer 상세정보를 결정 wire와 로그에 넣지 않는다.

## 중복·역순·수정·삭제 경합

1. OpenAI 호출 전에 댓글별 최신 activityVersion을 별도 원자적 상태에 관측한다.
   이전 응답이 돌아왔을 때 최신 관측 버전과 다르면 검사 사실만 남기고 결정은 발행하지 않는다.
2. 댓글 삭제 tombstone은 terminal이며 이후 생성/수정 재전송으로 해제하지 않는다.
   PostDeleted/PostExpired 관측 시 해당 게시물의 후속 결정도 막는다.
3. 결정 준비 데이터 + output XADD + 발행 receipt를 Lua로 처리한다. 같은 정책 버전에
   다른 규칙/승인 정보를 재사용하면 거부한다. 발행 실패는 입력 완료가 아니므로 pending 유지.
4. Lua 런타임 오류에는 rollback이 없다. 키 TYPE을 쓰기 전에 검사하며 XADD 실패 시
   준비된 결정이 남을 수 있다. 재시도는 같은 데이터/ID를 재사용한다.
5. XADD 성공 뒤 receipt/응답 유실 시 같은 ID의 재발행 가능성이 있다. 전송은
   at-least-once이며 Post가 영속 멱등 처리를 해야 한다. input ACK 유실도 같은 방식으로 복구한다.

Moderation은 아직 도착하지 않은 Post 수정·삭제를 알 수 없다. **이미 발행된 이전 버전
결정은 회수하지 않는다.** 따라서 아래 Post 버전 검증은 필수이며 생산자 fencing을
원본 상태 검증의 대체로 사용하지 않는다.

## Post 소비자가 지켜야 할 적용 경계 — 합의·구현 요청

- 별도 consumer group(제안: `post-content-enforcement`), 고유 consumer 이름 사용.
- 런타임 wire 검증과 Redis ACL/TLS/사설망으로 발행 주체 제한. producer 문자열은 인증이 아니다.
- HIDE_COMMENT 적용 트랜잭션 안에서 대상 post/comment 상태와
  **현재 activityVersion === 검사한 activityVersion**을 대조한다.
- 결정 receipt, 상태·가시성 변경, 카운터/투표 처리, 적용 결과 Outbox를 한 트랜잭션으로 저장한다.
  수정/삭제 경합으로 트랜잭션 재시도 시 원본 버전도 다시 읽는다.
- NO_ACTION은 현재 내용을 재노출하거나 기존 운영자 삭제·숨김을 취소하는 명령이 아니다.
- stale, 이미 삭제, 미존재, 적용 성공을 구분해 영속 기록한다. 일시 DB 장애는 재시도하며
  검증 실패·poison은 DLQ 영속 저장 후 ACK한다. XAUTOCLAIM cursor/재시도 한도도 필요하다.
- 기존 `moderateComment(postId, commentId, moderationDecisionId, expectedActivityVersion)`는
  검토된 버전의 **삭제** 함수다. HIDE_COMMENT를 자동으로 영구 삭제에 매핑하지 않는다.
  숨김 저장 모델·조회 가시성·복구 정책 또는 삭제 매핑 승인은 Post 팀과 먼저 합의한다.
- 실제 삭제를 선택한다면 Post가 커밋한 `PostCommentDeleted`의 MODERATION actor,
  MODERATION_VIOLATION, moderationDecisionId, 새 activityVersion 계약을 유지한다.
  Notification은 결정만 보고 조치 완료 알림을 발송하면 안 된다.
- 적용/거부 결과의 decision ID, sourceEventId, 대상 버전, 상태·사유·처리 시각을
  되돌릴 피드백 계약을 합의한다. 이 피드백 생산자/소비자는 아직 구현하지 않았다.

따라서 이번 테스트의 E2E 범위는 **Post 입력 wire → 검사 → 결정 → Redis → input ACK**이다.
실제 Post 숨김까지의 E2E는 소비자 합의·구현 뒤 수행한다.

## 운영·복구

기존 post-moderation pending 회수와 5회 실패 후 moderation:post:dead 정책을 그대로 쓴다.
결정 발행은 실패했지만 검사 결과가 저장된 경우 원래 입력 ID 재처리로 복구하며
OpenAI를 다시 호출하지 않는다. 이미 완료된 입력의 dedup marker를 임의 삭제하지 않는다.
기존 `content:republish`는 검사 사실만 재발행하며 숨김 결정 재발행 도구가 아니다.

추가 상태 키는 `moderation:content-target:{postId}:{commentId}`,
`moderation:content-post-terminal:{postId}`, `moderation:content-decision:{decisionId}`,
`moderation:content-decision-published:{decisionId}`, `moderation:content-policy:{policyVersion}`다.
자동 TTL/trim은 없다. replay 범위·보존·삭제·archive 정책 승인 및 용량 감시가 필요하다.
기존 검사 원본은 30일 보존이므로 원본 만료 뒤 자동 재평가로 결정을 복원하지 않는다.
한 Redis primary/DB가 필요하며 untagged multi-key Lua는 Redis Cluster를 지원하지 않는다.
Redis AOF/fsync/복제·백업/noeviction은 별도 운영 작업이다.

`/health/ready`는 활성화된 경우 결정 stream TYPE과 정책 fingerprint도 검사한다.
OpenAI 정확도, Post 소비 성공, 실제 사용자 화면 차단 성공을 뜻하지 않는다.
`content_decision_published` 로그도 Post 적용을 확정하지 않는다. 발행 실패·pending/DLQ,
정책 버전 충돌, Post 적용 피드백을 별도로 감시해야 한다.
