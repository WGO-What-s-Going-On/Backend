# Post 팀 계약 요청: 게시글 본문 검열과 숨김 적용

2026-11-09 / QA 이슈 8. **아래는 합의 요청이며 Post에 적용한 계약 변경이 아니다.**

## 현재 확인한 범위

- 댓글 생성·수정: 본문과 activityVersion이 전달되어 기존 OpenAI 검사 가능.
  수정 입력에는 activityVersion과 comment.updatedAt이 필수다.
- PostCreated: 현재 검사할 게시글 본문이 없다. PostUpdated도 본문 검사 요청 계약이 아니다.
- Post 상세 내부 조회는 임의 호출하거나 WS Gateway 신원을 재사용하지 않는다.
- Post의 기존 운영자 `moderateComment`는 검토한 activityVersion을 트랜잭션 안에서
  대조하고 MODERATION 삭제를 발행한다. 모델 flagged만 받는 자동 소비자는 없다.

## 1. 게시글 검사 입력: 다음 두 방법 중 합의 필요

| 방안 | 요청 |
| --- | --- |
| PostCreated / PostUpdated additive 확장 | `post.content` 또는 별도 검사 대상 본문, 불변 `contentVersion`, 수정 시 새 이벤트 발행 |
| 별도 검사 요청 이벤트 | POST/COMMENT targetType, 대상 ID, content 또는 인가된 reference, contentVersion, sourceEventId/correlationId |

요구하는 버전·본문 의미:

1. 어떤 필드(제목/본문)를 검사할지와 실제 검사한 텍스트의 조립 규칙을 명시한다.
2. contentVersion은 본문 변경 시 단조 증가하며 조회수·카운터 증가와 구분한다.
   기존 postVersion을 재사용한다면 본문 변경과의 관계를 먼저 확정한다.
3. 생성/수정/삭제와 원본 Outbox를 같은 트랜잭션에 넣고 실제 본문 버전을 보존한다.
4. 원문 이벤트 노출 범위, Stream ACL·보존, 길이 제한, 과거 v1 필드 누락의 skip/backfill
   기준을 합의한다. Moderation이 과거 본문·버전을 추측하지 않는다.
5. 수정 시 재검사하고, 이전 본문 결과가 늦게 와도 현재 본문에 적용하지 않는다.
6. 인증된 reference 방식을 택하면 moderation-service의 ES256 권한, 대상 경로,
   contentVersion 응답, 삭제/만료·403/404/일시 실패와 timeout을 별도로 합의한다.

현재 Moderation의 PostCreated는 기존 Lifecycle 초기화만 수행한다. 본문 입력 계약과
검증을 받기 전에는 게시글 검사·자동 조치를 활성화하지 않는다.

## 2. 댓글 숨김 결정 소비

[콘텐츠 결정 wire와 소비자 요구](content-enforcement-events.md)를 검토해 달라.
Moderation 생산자는 준비됐지만 `MODERATION_CONTENT_ENFORCEMENT_ENABLED=false`다.
Post 팀에서 아래를 확정해야 한다.

- `HIDE_COMMENT`의 저장 상태/조회·카운터·답글·미디어·투표 가시성 및 복구 규칙.
- 기존 삭제 기능으로 대체할지 여부. 별도 승인 없이 숨김을 삭제로 바꾸지 않는다.
- 현재 댓글 버전 CAS와 영속 decision receipt/Outbox의 원자성, 중복·역순·삭제 경합 처리.
- 승인된 policyVersion/fingerprint 허용 목록 및 정책 교체/롤백 시 동작.
- 적용·stale 거부·이미 삭제·미존재·영구 실패를 추적할 피드백 wire와 재시도/DLQ 운영.

Post 소비자·정책·피드백·FE 표시 합의 전에 활성화하지 않는다. 합의 후 실제
OpenAI → Moderation 결정 → Post 숨김 → 조회에서 비노출 → 결과 피드백 E2E를 함께 수행한다.

## 3. FE 전달

지금은 기존 HTTP·실시간 계약을 변경하지 않았다. Post가 실제 숨김 상태를 구현하면
댓글 목록/상세/실시간 화면의 비노출 또는 안내 문구, 수정 후 재검사 중 UX,
차단 적용 지연 동안의 표시를 합의해야 한다. `flagged`나 결정 발행만으로 FE가
독자적으로 삭제 완료를 표시하지 않는다.
