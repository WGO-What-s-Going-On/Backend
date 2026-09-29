# Post Service → Map Service 이벤트 계약

`PostCreated`의 JSON 본문은 [post-created.schema.json](./post-created.schema.json)에 정의한다. Post Service는 Redis Stream `post:events`에 `eventId`, `eventType`, `data` 세 필드를 기록한다. `data`는 JSON 문자열이며 `eventId`와 `eventType`은 Stream 필드와 일치해야 한다. `aggregateId`는 `post.postId`와 같다. Map Consumer는 현재 버전 1의 `PostCreated`만 처리하고 다른 이벤트 타입은 ACK한다.

Map은 필수 인덱스 필드와 식별자 일치를 검증한다. `correlationId`와 `occurredAt`은 생산자 계약의 일부이지만 현재 소비자의 저장 필드는 아니다. 이벤트 스키마에 새 필드를 추가할 때 기존 필드의 의미를 유지해야 한다.

처리 순서는 Cassandra `post_locations` → `posts_by_cell` → Redis GEO → `XACK`이다. 같은 `eventId`가 다시 전달되어도 동일한 게시물 ID에 같은 값을 기록한다. 저장 실패 시 Pending을 유지하고 `XAUTOCLAIM`으로 회수한다. 5회 실패하면 Dead Letter Stream `map:post:dead`에 아래 필드를 성공적으로 기록한 뒤 ACK한다. 형식이 잘못된 이벤트는 즉시 같은 경로로 보낸다.

| Dead Letter 필드 | 의미 |
| --- | --- |
| `streamId` | 원본 `post:events` Stream ID |
| `eventId` | 원본 Stream의 이벤트 ID. 없는 경우 빈 문자열 |
| `error` | 실패 사유 문자열 |
| `data` | 원본 JSON 문자열. 없는 경우 빈 문자열 |

Dead Letter 기록이 실패하면 원본을 ACK하지 않는다. Map이 이벤트를 소비하기 전에 `post:events` 데이터 자체가 유실된 경우에는 Post Service 원본 대조와 별도 재발행이 필요하다.
