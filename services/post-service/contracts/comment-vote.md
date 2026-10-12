# 댓글 후보 투표 v1

Post Service의 MongoDB가 투표의 원본이다. 새 게시물은 생성 트랜잭션에서 `voteAt = createdAt + 30분`과 `PENDING` 상태를 기록한다. 이전 게시물에는 투표를 소급 적용하지 않으며 조회 시 `NONE`이다. 투표 이벤트는 발행하지 않는다.

워커는 `voteAt` 이후 처음 처리하는 시점의 활성 댓글을 `HELPFUL + AGREE` 내림차순, 작성 시각 오름차순, `commentId` 오름차순으로 정렬한다. 상위 두 댓글의 ID, 본문, 선정 당시 점수와 시각을 고정한다. 활성 댓글이 둘 미만이면 `NONE`이다. 워커 장애 뒤에는 복구 후 첫 처리 시점의 점수를 사용한다.

`GET /api/v1/posts/{postId}/vote`는 `{ status, candidates, selectedAt, closedAt, winner, mySelection }`을 반환한다. `status`는 `PENDING`, `OPEN`, `CLOSED`, `CANCELLED`, `NONE` 중 하나다. 후보는 `{ commentId, content, scoreAtSelection, votes }` 형태다. `winner`는 확정된 후보 스냅샷 또는 `null`이다. 종료·삭제 후에도 이 조회는 공개된다. 로컬·테스트에서 `X-User-Id`를 주면 해당 사용자의 선택을 반환한다.

`PUT /api/v1/posts/{postId}/vote` 본문은 `{ "commentId": "comment_..." }`이다. 후보 선택과 표 이동 시 Map Service의 게시물 참여 위치 검증을 받는다. 같은 선택은 멱등이다. `DELETE /api/v1/posts/{postId}/vote`는 본인 표를 취소하며 새 위치 확인이 없다. 두 변경 API는 갱신된 조회 형태를 반환한다. 운영 인증 연동 전에는 변경 API가 503을 반환한다.

투표는 게시물이 만료·삭제되면 닫힌다. 득표가 1표 이상인 단독 최다 후보만 승자이며, 0표와 동률은 `winner: null`이다. 투표 중 후보 댓글이 삭제되면 `CANCELLED`로 닫고 승자를 만들지 않는다. 이미 확정된 승자 스냅샷은 댓글 삭제 뒤에도 유지된다. 후보 선정 전 종료된 게시물은 `NONE`이다.
