# Post 팀 인계: 게시글·댓글 HIDE 결정 소비

2026-11-11. 현재 최신 dev는 이미 PostCreated/PostUpdated의 제목·본문·postVersion과
Moderation 게시글·댓글 검사를 제공한다. 이전 문서의 **본문 추가 요청은 완료되어 대체한다.**
이번 변경은 Moderation 내부만 포함하며 Post 소비자·DB·실제 숨김·FE는 수정하지 않았다.

## 이미 구현된 생산자

- PostCreated/PostUpdated: 전달된 제목+본문 snapshot을 검사하고 POST 평가 사실을 발행한다.
- PostCommentCreated/PostCommentUpdated: 댓글과 activityVersion을 검사하고 COMMENT 평가 사실을 발행한다.
- 새 결정 생산자: 기능 ON + canonical flagged=true일 때만 별도 stream에 decision=HIDE를 발행한다.
- 정상 콘텐츠는 평가 사실만 남기며 결정이나 복원 명령을 발행하지 않는다.
- 결정 기능은 기본 OFF이며 실제 적용 성공이라고 보고하지 않는다.

정확한 필드·ID 산식·복구 규칙은 [Redis 결정 계약](content-enforcement-events.md)을 따른다.

## Post 담당 구현 요청

1. moderation:content-decisions를 별도 consumer group으로 소비한다.
2. POST의 postVersion / COMMENT의 activityVersion을 **현재 원본과 같은 트랜잭션에서** 대조한다.
3. HIDE 상태의 저장·조회 비노출·답글/미디어/검색/실시간/카운터/투표·복구 정책을 정의한다.
   기존 moderatePost/moderateComment는 삭제 함수이므로 별도 합의 없이 HIDE에 연결하지 않는다.
4. decision receipt와 숨김 적용, 결과 Outbox를 원자적으로 저장하고 성공 후 ACK한다.
   sourceEventId/moderationDecisionId를 보존해 중복·역순·수정/삭제 경합을 추적한다.
5. 적용/중복/stale/이미 삭제/미존재와 일시 장애·영구 오류를 구분한다.
   pending 회수·재시도·DLQ와 정책 허용 목록도 구현한다.
6. 실제 적용·거부·실패를 되돌려줄 피드백 wire를 합의한다. 결정 발행은 적용 성공이 아니다.

Post 소비자와 policyVersion/fingerprint 허용 목록을 검토한 뒤 staging에서
실제 Moderation 결정 → Post 숨김 → 조회/실시간 비노출 → 피드백 E2E를 수행해야 한다.

## FE·Notification 경계

FE의 숨김 표시·접근 시 안내·수정 후 재검사 UX는 Post 가시성 계약 뒤 진행한다.
flagged나 결정만으로 삭제 완료를 표시하지 않는다. Notification도 실제 Post 적용 결과를
확인해야 한다. 이번 변경에는 FE/Notification 계약·코드 변경이 없다.
