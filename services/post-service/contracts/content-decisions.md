# 콘텐츠 숨김 결정 소비 (#132)

## 입력과 적용

[Moderation DECIDED v1](../../moderation-service/contracts/content-enforcement-events.md)의
`moderation:content-decisions`를 `post-content-enforcement` 그룹이 처음(`0`)부터 소비한다.
각 replica는 별도 consumer 이름을 쓴다. EVALUATED는 숨김 명령이 아니며 이 stream에 넣지 않는다.
허용 정책은 `openai-flagged-hide-v1` 및 고정 규칙 fingerprint뿐이다. source/evaluation/decision
ID 관계, producer, schema, 대상별 필수 버전, HIDE/reason을 검증한다. 정책 변경은 배포 변경을 요구한다.

MongoDB 트랜잭션에서 원본 버전을 다시 읽고 receipt, HIDDEN 상태, 카운터·투표 변경,
가시성 이벤트 및 결과 Outbox를 함께 저장한다. 수정·삭제와 경합하면 새 스냅샷에서 재검증한다.
동일 eventId 재전달은 최초 결과를 반환하고 부작용을 반복하지 않는다. 현재 상태가 ACTIVE이고
만료 전이며 검토 버전과 일치할 때만 적용한다. 작성자 종료(closedAt)는 콘텐츠 숨김을 막지 않는다.
숨김은 본문·첨부의 영구 삭제가 아니다. 기존 운영 삭제 명령으로 대체하지 않는다.

## 조회와 투표

- 게시글 HIDDEN: 상세·댓글 목록·미디어·투표 조회 404, 주변/활동/검색 목록에서 제외, 쓰기·참여 거부.
- 댓글 HIDDEN: 목록·미디어 제외, 같은 mutationId 재전송도 본문 반환 거부, 새 답글 생성 거부.
  기존 답글은 별도 콘텐츠이므로 공개 상태를 유지한다. 숨겨진 부모의 본문은 반환하지 않는다.
- 댓글 카운터는 한 번 감소한다. 이후 명시적 삭제는 다시 차감하지 않는다.
- 게시글 숨김은 투표를 취소하고 승리 보상을 발행하지 않는다. 댓글 숨김은 후보 스냅샷의 본문도
  제거하며 진행 중인 해당 후보 투표를 취소한다. 이미 발행된 보상의 소급 회수는 하지 않는다.
- 원본·첨부는 보존하고 자동 복원은 제공하지 않는다. 향후 복원에는 새 버전과 별도 계약이 필요하다.
  기존에 발급한 GCS 서명 URL은 만료까지 유효하다(기본 300초). 새 URL 발급은 차단한다.

## 출력 계약

기존 `post:events` flat v1 envelope에 다음 이벤트를 추가한다. 본문·정밀 위치는 포함하지 않는다.

| eventType | payload | 소비자 |
| --- | --- | --- |
| PostHidden | post: {postId, authorId, category, hiddenAt}, postVersion, moderationDecisionId | Map, Semantic, WS |
| PostCommentHidden | comment: {postId, commentId, authorId, hiddenAt}, activityVersion, postAuthorId, moderationDecisionId | WS |
| ContentModerationApplied | decision: {moderationDecisionId, sourceEventId, targetType, postId, commentId?(COMMENT), reviewedVersion, outcome, processedAt} | 감사/향후 피드백 소비자 |

`ContentModerationApplied`의 sourceEventId는 수신한 DECIDED eventId이며 outcome이 실제 결과다.
이름과 무관하게 APPLIED 외 결과도 포함한다: STALE, NOT_FOUND, ALREADY_HIDDEN, TERMINAL.
중복 전달에 새 결과 이벤트를 발행하지 않는다. 원래 검사 시각과 적용 시각(processedAt)을 구분한다.
Moderation/Notification의 피드백 처리·사용자 알림은 이 PR에서 추가하지 않는다.

Map은 HIDDEN을 파생 인덱스의 DELETED tombstone으로 변환해 제거한다. Post 원본은 HIDDEN으로 남는다.
Semantic은 원본을 다시 확인하고 문서를 제거한다. WS는 `post.hidden`/`comment.hidden` v1을 전달한다.
기존 envelope, postVersion/activityVersion과 hiddenAt을 전달하되 본문·정책·작성자는 공개하지 않는다.
post.hidden은 해당 Room을 닫고, comment.hidden은 댓글 tombstone으로 늦은 생성/수정을 막는다.
클라이언트는 두 메시지에서 해당 콘텐츠를 제거하고 재연결 시 원본을 재조회해야 한다.

## 배포·복구

1. Post/Map/WS와 클라이언트 숨김 이벤트 처리를 먼저 배포한다.
2. Post의 `MODERATION_REDIS_URL`을 Moderation과 같은 endpoint/DB로 설정하고
   `POST_CONTENT_DECISION_CONSUMER_ENABLED=true`로 설정한다(기본 false).
3. `MODERATION_CONTENT_DECISION_STREAM`은 기본 moderation:content-decisions이며 다른 stream과 구분한다.
4. 정책 fingerprint·retained stream 범위를 확인하고 Moderation 결정 발행을 활성화한다.

30초 idle PEL을 XAUTOCLAIM으로 회수하며 cursor를 유지한다. DB 장애는 pending에 남기고 최대 5회
실패 후 `post-content-enforcement:dead`에 원문을 저장한 뒤 ACK한다. 잘못된 계약은 즉시 DLQ로 보낸다.
DLQ 쓰기 실패·ACK 실패는 pending을 유지한다. ACK 재시도는 업무 재시도 실패로 계산하지 않는다.
DB 복구 후 원본 eventId로 재전달하면 receipt가 중복을 막는다. 종료 시 in-flight 처리를 기다린다.
Redis ACL/TLS/사설망으로 결정 stream 쓰기 권한을 제한한다. producer 문자열은 인증 수단이 아니다.
DLQ 접근 권한과 보존 기간, receipt·숨김 원본 보존 정책은 운영에서 관리한다. receipt 자동 TTL은 없다.
기존 /health/ready는 MongoDB readiness이며 소비자 lag를 보장하지 않는다. consumerGroup별
pending/oldest idle/DLQ와 moderation_event_retry, moderation_event_ack_failed 로그를 모니터링한다.
