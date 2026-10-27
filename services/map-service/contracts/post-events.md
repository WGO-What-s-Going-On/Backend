# Post Service → Map Service 이벤트 계약

`PostCreated`의 JSON 본문은 [post-created.schema.json](./post-created.schema.json)에 정의한다. Map이 소비할 `PostExpired`와 `PostDeleted` 버전 1 본문은 [post-status.schema.json](./post-status.schema.json)에 정의한다. Post Service는 Redis Stream `post:events`에 `eventId`, `eventType`, `data` 세 필드를 기록한다. `data`는 JSON 문자열이며 `eventId`와 `eventType`은 Stream 필드와 일치해야 한다. 상태 이벤트는 envelope의 `aggregateId`를 게시물 ID, `occurredAt`을 전이 시각으로 사용한다.

Map은 필수 인덱스 필드와 식별자 일치를 검증한다. `PostCreated`의 `correlationId`와 `occurredAt`은 생산자 계약의 일부지만 현재 위치 저장 필드는 아니다. 상태는 Cassandra에 별도로 기록하며 `ACTIVE → EXPIRED/DELETED`, `EXPIRED → DELETED`만 허용한다. 중복·역순 도착은 조건부 갱신으로 처리한다. 이벤트 스키마에 새 필드를 추가할 때 기존 필드의 의미를 유지해야 한다.

생성 처리는 상태 초기화와 위치 원본 저장 후 ACTIVE·미만료 게시물만 Cell·GEO에 기록한다. 기록 후 상태를 재확인하여 동시 종료와의 경합을 보상한다. 상태 이벤트는 `post_status` 조건부 갱신 → 현재·재구축 Redis GEO 제거 → `post_locations`의 cell·shard로 `posts_by_cell` 해당 행 삭제 → `XACK` 순서다. 위치 원본과 상태 행은 유지한다. 종료가 생성보다 먼저 도착해 위치가 없으면 Cell 삭제를 건너뛰며, 늦은 생성 처리가 정리한다. 두 저장소 사이의 원자적 트랜잭션은 아니므로 중간 실패는 재처리로 복구한다. 같은 `eventId`가 다시 전달되어도 동일한 게시물 ID에 같은 값을 기록한다. 저장 실패 시 Pending을 유지하고 `XAUTOCLAIM`으로 회수한다. 5회 실패하면 Dead Letter Stream `map:post:dead`에 아래 필드를 성공적으로 기록한 뒤 ACK한다. 형식이 잘못된 이벤트는 즉시 같은 경로로 보낸다.

| Dead Letter 필드 | 의미 |
| --- | --- |
| `streamId` | 원본 `post:events` Stream ID |
| `eventId` | 원본 Stream의 이벤트 ID. 없는 경우 빈 문자열 |
| `error` | 실패 사유 문자열 |
| `data` | 원본 JSON 문자열. 없는 경우 빈 문자열 |

Dead Letter 기록이 실패하면 원본을 ACK하지 않는다. Map이 이벤트를 소비하기 전에 `post:events` 데이터 자체가 유실된 경우에는 Post Service 원본 대조와 별도 재발행이 필요하다.
