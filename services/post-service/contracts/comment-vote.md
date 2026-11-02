# 댓글 후보 투표 v1

Post Service의 MongoDB가 투표의 원본이다. 새 게시물은 생성 트랜잭션에서 `voteAt = createdAt + 30분`과 `PENDING` 상태를 기록한다. 이전 게시물에는 투표를 소급 적용하지 않으며 조회 시 `NONE`이다. 단독 승자 최초 확정 시 `PostVoteWon`을 같은 트랜잭션의 Outbox에 저장한다. [이벤트 계약](post-events.md#14-댓글-공감투표-승리-2026-10-30)을 따른다.

워커는 `voteAt` 이후 처음 처리하는 시점의 활성 댓글을 `HELPFUL + AGREE` 내림차순, 작성 시각 오름차순, `commentId` 오름차순으로 정렬한다. 상위 두 댓글의 ID, 본문, 선정 당시 점수와 시각을 고정한다. 활성 댓글이 둘 미만이면 `NONE`이다. 워커 장애 뒤에는 복구 후 첫 처리 시점의 점수를 사용한다.

`GET /api/v1/posts/{postId}/vote`는 `{ status, candidates, selectedAt, closedAt, winner, mySelection }`을 반환한다. `status`는 `PENDING`, `OPEN`, `CLOSED`, `CANCELLED`, `NONE` 중 하나다. 후보는 `{ commentId, content, scoreAtSelection, votes }` 형태다. `winner`는 확정된 후보 스냅샷 또는 `null`이다. 종료·삭제 후에도 이 조회는 공개된다. 로컬·테스트에서 `X-User-Id`를 주면 해당 사용자의 선택을 반환한다.

`PUT /api/v1/posts/{postId}/vote` 본문은 `{ "commentId": "comment_..." }`이다. 후보 선택과 표 이동 시 Map Service의 게시물 참여 위치 검증을 받는다. 같은 선택은 멱등이다. `DELETE /api/v1/posts/{postId}/vote`는 본인 표를 취소하며 새 위치 확인이 없다. 두 변경 API는 갱신된 조회 형태를 반환한다. 운영 인증 연동 전에는 변경 API가 503을 반환한다.

투표는 작성자가 종료하거나 게시물이 만료·삭제되면 닫힌다. 작성자 재개 후에도 이미 확정된 투표는 다시 열리지 않는다. 득표가 1표 이상인 단독 최다 후보만 승자이며, 0표와 동률은 `winner: null`이다. 투표 중 후보 댓글이 삭제되면 `CANCELLED`로 닫고 승자를 만들지 않는다. 이미 확정된 승자 스냅샷은 댓글 삭제 뒤에도 유지된다. 후보 선정 전 종료된 게시물은 `NONE`이다.

## 댓글 본문 수정

`PATCH /api/v1/posts/{postId}/comments/{commentId}`는 인증된 작성자의 본문만
수정한다. 요청은 `{"content":"수정할 본문"}`이며 알 수 없는 필드를 거부한다.
앞뒤 공백 제거 후 1~2000자여야 한다. 성공은 본문 없는 204이고 클라이언트는
댓글 목록을 다시 조회해 `content`, `updatedAt`을 갱신한다.

게시물은 ACTIVE이고 종료·만료 전이어야 하며 댓글도 ACTIVE여야 한다.
작성자 불일치 또는 비활성은 403, 게시물에 속하지 않는 댓글은 404다.
한 번 투표 후보로 선정된 댓글은 투표 종료·취소 뒤에도 본문을 바꿀 수 없으며
409 `COMMENT_EDIT_CONFLICT`를 반환한다. 기존 후보 스냅샷의 의미를 보존한다.

수정은 생성 시각·작성자·첨부·답글 관계·댓글 수·공감 수를 유지한다.
본문이 같으면 추가 변경 없이 204를 반환한다. 실제 수정마다 `activityVersion`을
증가시키고 MongoDB 트랜잭션에서 본문과 `PostCommentUpdated` Outbox를 함께 저장한다.
댓글 삭제·후보 선정·게시물 종료와의 경합은 공통 문서 쓰기로 직렬화한다.

Realtime Gateway는 `PostCommentUpdated`를 `comment.updated`로 보드 구독자에게
전달한다. 메시지는 `comment`와 `activityVersion`을 포함한다. 클라이언트는
같은 댓글의 더 높은 버전만 반영하고 삭제된 댓글을 되살리지 않아야 한다.
목록 캐시를 갱신하거나 HTTP 목록을 다시 조회할 수 있다. Moderation과 Realtime
Gateway를 먼저 배포하고 클라이언트가 새 메시지를 처리한 뒤 Post를 배포한다.
