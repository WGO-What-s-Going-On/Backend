# Post Service 비동기 이벤트 계약

기준일: 2026-10-06. Post Service가 Redis Streams로 발행하는 활동 이벤트와
Notification·User Service 연동을 위한 확장안을 기록한다.

**현재 계약**은 코드에서 실제 발행하는 9개 이벤트와 Post의 상태 변경·Outbox 복구다.
**확장 제안**은 대댓글 등 선택 기능과 Notification·User의 후속 구현을 의미한다.
Post는 소비자의 알림·경험치·칭호 처리를 구현하지 않는다.

## 1. 책임과 이벤트 흐름

- Post: 게시물·댓글·공감·영속 참여의 원본을 관리하고, 완료된 변경 사실을 발행한다.
- Notification: 수신자·사용자 설정·차단 정책을 확인하고 알림 저장, 묶음 처리,
  전송 및 중복 방지를 담당한다.
- User: 활동 집계, 경험치, 레벨, 칭호·배지 및 보상 이력을 소유한다.
  레벨·칭호 변경 결과는 User의 Outbox를 통해 다시 발행한다.
- Moderation: 정책 위반 여부와 조치를 결정한다. Post 데이터의 삭제 이벤트는
  Post가 그 결정을 실제 적용한 뒤 발행한다.

```text
Post MongoDB 트랜잭션: 활동 데이터 + 카운터 + Outbox
  → Outbox Worker → post:events
                     ├─ Notification: 댓글·공감 등 활동 알림
                     ├─ User: 활동 집계 → 경험치·레벨·칭호 반영
                     │                     → User Outbox → user:events
                     │                                      → Notification: 성장 알림
                     └─ 기존 Map / Realtime / Semantic 소비자
```

Post 이벤트에는 경험치 지급량, 달성 레벨, 칭호 판정 결과를 넣지 않는다.
같은 활동 이벤트를 각 서비스가 자기 규칙으로 처리한다. 다른 서비스의 DB를
직접 조회하거나 수정하지 않는다. 기준 아키텍처는
[ARCHITECTURE.md](../../../ARCHITECTURE.md)를 따른다.

## 2. 현재 전송 계약

### Redis Streams

Stream key는 `post:events`이며, 한 메시지의 필드는 모두 문자열이다.

```text
XADD post:events *
  eventId   <eventId>
  eventType <eventType>
  data      <JSON으로 직렬화한 전체 envelope>
```

외부 필드 `eventId`, `eventType`은 `data` 내부 값과 일치해야 한다.
Redis Stream ID는 전달 위치이며, 도메인 이벤트 식별자인 `eventId`와 다르다.
같은 이벤트를 재발행하면 Stream ID는 달라질 수 있지만 `eventId`는 유지된다.

### 공통 envelope

| 필드 | 현재 타입·값 | 의미 |
| --- | --- | --- |
| `eventId` | string, `evt_<UUID>` | 이벤트 고유 ID. 발행 재시도에서 유지 |
| `eventType` | string | 아래 아홉 가지 현재 이벤트 중 하나 |
| `schemaVersion` | number, `1` | 이벤트 스키마 버전. 도메인 상태의 변경 순서가 아님 |
| `producer` | string, `post-service` | 생산 서비스 |
| `aggregateId` | string, `post_<UUID>` | 생성·취소·삭제·만료 이벤트 모두 게시물 ID |
| `correlationId` | string, `req_<UUID>` | 현재 이벤트 생성 시 새로 생성. 요청의 ID 전파는 미구현 |
| `occurredAt` | string, ISO-8601 UTC | 해당 command에서 생성한 사건 시각. Redis 발행·소비·DB 커밋 시각이 아님 |
| `post` / `comment` / `reaction` / `participant` | object | 이벤트별 데이터. 해당 이벤트의 객체 하나 포함 |

**Outbox 내부의 `payload`와 Redis wire format을 구분한다.** Outbox에는
`payload: { comment: ... }`처럼 저장하지만 Worker는 이를 envelope 최상위에
펼친다. 소비자는 `data.comment`를 읽으며 `data.payload.comment`를 읽지 않는다.
도메인 데이터가 공통 envelope 필드를 덮어쓰지 않도록 확장 필드를 정의한다.

현재 사용자 ID는 양의 안전 정수인 JSON number다. User의 DB·일부 API에서 쓰는
10진수 문자열 ID와 경계에서 명시적으로 변환한다. 기존 이벤트의 ID 타입을
문자열로 바꾸는 것은 호환되지 않는 변경이다. 아래 명세의 `?`만 선택 필드이며,
`null`을 허용한 필드는 생략과 구분한다. 시각 필드는 전송 시 ISO-8601 문자열이다.

### 현재 생산·소비 상태

| 서비스 | 확인된 상태 |
| --- | --- |
| Post | 생성 4종과 취소·삭제·이탈·만료 5종을 MongoDB Outbox에 저장하고 `post:events`로 발행 |
| Map | `post-map` 그룹에서 `PostCreated` 소비. `PostExpired`, `PostDeleted`로 비활성 상태 적용 |
| Realtime Gateway | `post-realtime` 그룹에서 네 현재 이벤트를 소비하고 연결된 보드에 전파 |
| Post Semantic Worker | 설정된 독립 그룹에서 `PostCreated` 소비. `PostExpired`, `PostDeleted`도 원본 재확인 후 처리 |
| Notification | Post 이벤트 소비·알림 비즈니스 로직 미구현 |
| User | Post 이벤트 소비·활동 기반 보상 미구현. 기존 배지 저장·조회와 User Outbox는 존재 |

Realtime은 새 취소·삭제 이벤트의 클라이언트 전파를 아직 구현하지 않았다.
Semantic 그룹 및 복구 규칙은 [semantic-search.md](./semantic-search.md)를 참고한다.

## 3. 생성·참여 이벤트

아래 JSON은 이해를 위한 예시다. 3.1은 전체 `data`이고, 3.2–3.4는 공통
envelope를 제외한 이벤트별 최상위 객체만 표시한다. 객체의 각 필드는 현재 필수다.

### 3.1 `PostCreated`

게시물과 Outbox 저장이 커밋되면 발행한다. 생성 전 위치 인가 실패 또는
트랜잭션 롤백에는 발행하지 않는다. 현재 게시물 생성 요청 자체에 대한
idempotency key는 없으므로 별도 생성 요청은 별도 게시물이 될 수 있다.

```json
{
  "eventId": "evt_11111111-1111-4111-8111-111111111111",
  "eventType": "PostCreated",
  "schemaVersion": 1,
  "producer": "post-service",
  "aggregateId": "post_22222222-2222-4222-8222-222222222222",
  "correlationId": "req_33333333-3333-4333-8333-333333333333",
  "occurredAt": "2026-10-06T03:00:00.000Z",
  "post": {
    "postId": "post_22222222-2222-4222-8222-222222222222",
    "authorId": 123,
    "latitude": 37.4979,
    "longitude": 127.0276,
    "radiusM": 250,
    "category": "INCIDENT",
    "expiresAt": null
  },
  "postVersion": 1
}
```

`postId: string`, `authorId: number`, `latitude/longitude/radiusM: number`,
`category: string`, `expiresAt: null`이 현재 생산 형태다. 새 게시물은 ACTIVE이며
`expiresAt`은 항상 null로 시작한다. `title`, `content`, `status`, `createdAt`은
이 이벤트의 `post`에 포함되지 않는다. `post.postId = aggregateId`다.
신규 생산자는 envelope 최상위에 `postVersion: 1`도 발행한다.

- Notification 활용 제안: 주변·구독 대상의 신규 게시물 알림. 좌표만으로 수신자
  목록이 결정되는 것은 아니며, 위치·구독 조회 경로와 동의 정책을 별도로 정한다.
- User 활용 제안: 작성 수, 카테고리별 작성 수, 첫 게시물 칭호, 작성 경험치.

### 3.2 `PostCommentCreated`

ACTIVE 게시물에 댓글을 저장하고 카운터·Outbox를 함께 커밋하면 발행한다.
`mutationId`가 제공된 경로는 `(postId, authorId, mutationId)`가 같은 재시도에
기존 댓글을 반환하며 새 이벤트를 만들지 않는다. `mutationId` 없는 요청까지
동일한 재시도 방지가 보장되는 것은 아니다.

```json
{
  "comment": {
    "commentId": "comment_44444444-4444-4444-8444-444444444444",
    "postId": "post_22222222-2222-4222-8222-222222222222",
    "authorId": 456,
    "content": "현장 상황을 추가로 공유합니다.",
    "status": "ACTIVE",
    "createdAt": "2026-10-06T03:01:00.000Z",
    "updatedAt": null
  },
  "postAuthorId": 123,
  "postCategory": "INCIDENT",
  "activityVersion": 1
}
```

`commentId/postId/content: string`, `authorId: number`, `status: "ACTIVE"`,
`createdAt: string`, `updatedAt: null`이 현재 생성 이벤트의 형태다.
`comment.postId = aggregateId`이며 작성자는 댓글 작성자다.
게시물 작성자·카테고리·버전은 최상위 문맥으로 추가한다. 대댓글 부모·멘션은 없다.
`mutationId`, MongoDB `_id`, `bucketId`도 wire format에 포함되지 않는다.

- Notification 활용 제안: 게시물 작성자·댓글 알림 구독자에게 알림.
- User 활용 제안: 댓글 작성 수, 소통 활동 경험치 및 칭호.

### 3.3 `PostReactionCreated`

ACTIVE 게시물에 LIKE가 처음 저장되면 발행한다. 같은 `(postId, userId, type)`의
공감이 이미 있으면 기존 결과를 반환하며 카운터와 이벤트를 추가하지 않는다.
현재 공감 종류는 LIKE만 지원한다. 취소된 기록은 재등록 시 활성화하며 버전을 증가시킨다.

```json
{
  "reaction": {
    "postId": "post_22222222-2222-4222-8222-222222222222",
    "userId": 456,
    "type": "LIKE",
    "createdAt": "2026-10-06T03:02:00.000Z"
  },
  "postAuthorId": 123,
  "postCategory": "INCIDENT",
  "activityVersion": 1
}
```

`postId: string`, `userId: number`, `type: "LIKE"`, `createdAt: string`이다.
`reaction.postId = aggregateId`이고 `userId`는 공감을 누른 사용자다.
게시물 작성자는 최상위 `postAuthorId`다. 별도 `reactionId` 없이
`(postId, userId, type)`가 공감 관계의 식별자다.

- Notification 활용 제안: 게시물 작성자에게 개별 또는 묶음 공감 알림.
- User 활용 제안: 누른 공감 수와 받은 공감 수를 별도 집계한다. 양쪽 모두에게
  경험치를 지급할지는 User 정책이며, Post가 판단하지 않는다.

### 3.4 `PostParticipantJoined`

위치 인가 후 ACTIVE 게시물의 영속적인 참여 상태가 생성되거나 복구되면 발행한다.
이미 참여 중이면 이벤트가 없다. `leftAt`이 있는 기록으로 재참여하면 기존 행을
복구하고 새 `eventId`의 참여 이벤트를 발행한다. 이탈 command도 구현되어 있다.

```json
{
  "participant": {
    "postId": "post_22222222-2222-4222-8222-222222222222",
    "userId": 456,
    "joinedAt": "2026-10-06T03:03:00.000Z",
    "lastSeenAt": "2026-10-06T03:03:00.000Z",
    "leftAt": null
  },
  "postAuthorId": 123,
  "postCategory": "INCIDENT",
  "activityVersion": 1
}
```

`postId: string`, `userId: number`, `joinedAt/lastSeenAt: string`, `leftAt: null`이다.
`participant.postId = aggregateId`다. 최초 참여·재참여 모두 같은 형태이며
재참여하면 `joinedAt`이 갱신된다. 현재 최초 여부 필드는 없다.

- Notification 활용 제안: 참여 기반 알림 대상의 상태 갱신. 참여 자체를 알림
  구독 동의로 볼지는 별도 제품 정책이다.
- User 활용 제안: 서로 다른 게시물 참여 수와 참여 칭호. 권장 보상 기준은
  `(userId, postId)`별 최초 한 번이다.

이 이벤트는 WebSocket Room 입장·재연결 또는 단순 조회를 의미하지 않는다.
여기서 다루는 참여는 현재 Post가 저장하는 participant 기록이다. Map이 소유하는
별도 공간 참여 계약이나 아키텍처의 `BoardJoined`와 동일한 이벤트로 간주하지 않는다.

## 4. 작성자 문맥과 상태 버전

기존 중첩 객체를 유지하고 다음 필드를 envelope 최상위에 추가한다.
Realtime은 현재 `comment` 객체를 클라이언트에 그대로 전달하므로 내부 문맥을
`comment` 객체에 넣지 않는다. 생성 command의 HTTP 응답에도 내부 버전을 추가하지 않는다.

| 적용 이벤트 | 필드 | 현재 의미 |
| --- | --- | --- |
| 댓글·공감·참여 생성 및 취소·삭제·이탈 | `postAuthorId` | number. 게시물 작성자. 알림 수신 및 받은 공감 귀속에 사용 |
| 위 활동 이벤트 | `postCategory` | string. 사건 당시 게시물 카테고리 |
| 공감 생성·취소 | `activityVersion` | `(postId, userId, type)`별 양의 정수 상태 버전 |
| 참여·이탈 | `activityVersion` | `(postId, userId)`별 양의 정수 상태 버전 |
| 댓글 생성·삭제 | `activityVersion` | `commentId`별 양의 정수 상태 버전 |
| 게시물 생성·삭제·만료 | `postVersion` | `postId`별 양의 정수 상태 버전 |

새 기록의 버전은 1이다. 실제 상태 전이에서만 증가한다. 공감은 생성 1 → 취소 2
→ 재등록 3, 참여는 참여 1 → 이탈 2 → 재참여 3이다. 취소 기록을 물리적으로
삭제하지 않아 재등록 이후에도 버전이 이어진다. 게시물은 생성 1 → 만료 2 →
삭제 3이 가능하며, 삭제 후 복구는 없다. 만료 기한 예약만 바꿀 때는 상태 버전이
증가하거나 별도 이벤트가 발행되지 않는다.

기존 버전 없는 원본 기록은 1로 읽고 첫 변경에서 2를 저장한다. 생성 4종의
과거 v1 Outbox에는 문맥과 버전이 없을 수 있으므로 소비자는 누락을 허용해야 한다.
기존 필드·타입·중첩 위치를 변경하지 않아 schemaVersion은 1을 유지한다.
새 취소·삭제·이탈·만료 이벤트는 아래 필수 문맥을 포함한다.

`postAuthorId` 없는 과거 이벤트는 소비자 매핑 또는 인가된 Post API로 보완한다.
삭제로 조회가 불가능하면 작성자를 추정해 지급·전송하지 않고 보류·대조한다.
`occurredAt`이나 `schemaVersion`으로 도메인 상태 버전을 대체하지 않는다.

## 5. 취소·삭제·만료 이벤트

공통 envelope에 아래 객체·문맥을 포함한다. 모든 `postId`는 `aggregateId`와 같다.
`?`만 선택 필드다. 모든 사용자 ID는 number, 콘텐츠·결정 ID는 string,
시각 필드는 null이 아닌 ISO-8601 문자열이다.

| 이벤트 | 실제 전이 | 필수 도메인 객체 및 최상위 문맥 | 소비 목적 |
| --- | --- | --- | --- |
| `PostReactionRemoved` | 활성 공감 → 취소 | `reaction: {postId, userId, type: "LIKE", createdAt, removedAt}`, `postAuthorId`, `postCategory`, `activityVersion` | 현재 공감 수 보정, 보상 회수 판정, 대기 알림 제외 |
| `PostCommentDeleted` | ACTIVE 댓글 → DELETED | `comment: {commentId, postId, authorId, deletedAt}`, `postAuthorId`, `postCategory`, `actor`, `reason`, `activityVersion`, `moderationDecisionId?` | 유효 댓글 수·보상 보정, 알림 노출 갱신 |
| `PostDeleted` | ACTIVE 또는 EXPIRED 게시물 → DELETED | `post: {postId, authorId, category, deletedAt}`, `actor`, `reason`, `postVersion`, `moderationDecisionId?` | 관련 활동 무효화 판단, 예약 알림 정리, 공간·검색 인덱스 제거 |
| `PostParticipantLeft` | 참여 중 → 이탈 | `participant: {postId, userId, joinedAt, leftAt}`, `postAuthorId`, `postCategory`, `activityVersion` | 현재 참여 상태·참여 기반 알림 대상 갱신 |
| `PostExpired` | 기한이 지난 ACTIVE 게시물 → EXPIRED | `post: {postId, authorId, category, expiresAt, expiredAt}`, `postVersion` | 후속 알림 종료, 필요 시 만료 안내, 공간·검색 인덱스 제거 |

공감의 `createdAt`과 이탈의 `joinedAt`은 종료되는 활성 구간의 시작 시각이다.
삭제 이벤트는 삭제된 본문 전체를 복제하지 않는다. 삭제 사유 계약은 다음 두 가지다.

| 실행 경로 | `actor` | `reason` | 추가 필드 |
| --- | --- | --- | --- |
| 작성자 본인의 HTTP 삭제 | `{type: "USER", userId: number}` | `USER_REQUEST` | 없음 |
| 운영 CLI에서 검토 결정 적용 | `{type: "MODERATION", userId: null}` | `MODERATION_VIOLATION` | `moderationDecisionId`: 공백 아닌 1–128자 string |

Moderation Service의 네트워크 소비·인증 연동은 별도 범위다. 운영 CLI는 이미
확인된 결정을 Post에 적용하는 경로다. SYSTEM, 계정 탈퇴 등의 사유는 아직 지원하지 않는다.

반복 취소·삭제·이탈 요청에는 이벤트와 카운터 변경이 없다. 소유권 검사는
반복 삭제에서도 생략하지 않는다. 공감·참여 취소는 해당 관계가 없어도 성공한다.
댓글·게시물 자체가 없으면 404다. 게시물이 비활성 상태여도 본인의 댓글 삭제,
공감 취소, 참여 이탈은 허용하며 신규 활동은 거부한다.

게시물 삭제 시 하위 활동을 물리적으로 일괄 삭제하거나 가짜 취소 이벤트를
생성하지 않는다. User는 `postId`로 관련 보상을 무효화할 수 있도록 활동 이력을
보존하고, 이후 하위 삭제 이벤트가 와도 이중 차감하지 않아야 한다.
자연 만료만으로 정상적인 과거 활동을 무효화하지 않는 것을 권장한다.

### HTTP 상태 변경 계약

모두 본문 없는 DELETE이며 성공은 응답 본문 없는 204다. 로컬·테스트에서는
기존 `X-User-Id` 양의 안전 정수를 사용한다. 운영은 기존 생성 API와 동일하게
사용자 인증 연동 전 503이다. 잘못된 경로 ID는 400, 사용자 ID 오류·소유권 불일치는
403, 없는 게시물 또는 댓글은 404다.

| 경로 | 대상·권한 |
| --- | --- |
| `/api/v1/posts/{postId}` | 게시물 작성자만 삭제 |
| `/api/v1/posts/{postId}/comments/{commentId}` | 해당 게시물에 속한 댓글의 작성자만 삭제 |
| `/api/v1/posts/{postId}/reactions` | 인증된 사용자 자신의 LIKE 취소 |
| `/api/v1/posts/{postId}/participants` | 인증된 사용자 자신의 참여 종료 |

삭제된 댓글의 기존 `mutationId`로 작성 재시도하면 해당 DELETED 댓글을 반환하며
새 댓글·이벤트를 생성하지 않는다. 대댓글·게시물 수정·숨김·복구 API는 없다.
OpenAPI `/docs`에도 위 네 DELETE 경로와 응답을 기록한다.

### 트랜잭션과 만료 처리

활동 데이터, bucket 카운터 증감, 상태 버전, Outbox는 같은 MongoDB 트랜잭션으로
커밋·롤백한다. 댓글·공감은 저장된 bucket을 사용하고 레거시의 없는 bucket은 0이다.
기존 `posts.counters` 기준값은 보존하고 `post_counters`에 증감분만 기록한다.
따라서 레거시 기준값을 상쇄하는 음수 증감분은 정상이며 기준값을 복사하지 않는다.

삭제·만료·만료 기한 예약은 모든 bucket의 세 활동 카운터에 `lifecycleFence`를
증가시킨다. 새 활동이 사용하는 카운터와 쓰기 충돌을 만들어 이전 ACTIVE
스냅샷의 활동이 상태 변경 뒤 커밋되는 것을 막는다. 레거시에서 카운터가 없으면
count 0으로 생성하며, 첫 생성의 유일 키 충돌은 제한적으로 전체 트랜잭션을 재시도한다.
일반 활동마다 공통 Post 문서를 쓰지 않아 기존 bucket 분산을 유지한다.

새 게시물의 `expiresAt`은 계속 null이다. 운영 CLI로 기한을 예약할 수 있고
Expiration Worker가 기본 1초마다 최대 `OUTBOX_BATCH_SIZE`개를 조회한다.
트랜잭션 안에서 기한·상태를 다시 검사하므로 여러 Worker의 중복 스캔에도
`PostExpired`는 한 번 생성된다. Worker 종료는 진행 중인 처리를 기다린다.
스캔 지연 중에도 기한이 지난 게시물의 신규 활동·공개 상세·댓글·batch 조회는 거부한다.
내부 meta/status는 저장된 상태와 expiresAt을 반환하므로 상태 반영까지 짧은 지연이 있다.

기한 변경은 아직 ACTIVE이고 기존 기한이 지나지 않은 게시물에만 허용한다.
같은 기한 재요청은 변경하지 않는다. 과거 시각을 처음 예약하면 다음 poll에서 만료한다.
Map에는 기한 예약 이벤트를 보내지 않으며, 실제 `PostExpired`를 소비하면 제거된다.

## 6. 기능 도입 시 검토할 이벤트

| 기능 | 이벤트·계약 제안 | 도입 조건 |
| --- | --- | --- |
| 대댓글 | `PostCommentCreated`에 부모 댓글 문맥 추가 | 답글 저장·조회·알림 기능 도입 시. 별도 생성 이벤트로 중복 발행하지 않음 |
| 댓글 공감 | `PostCommentReactionCreated`, `PostCommentReactionRemoved` | `commentId`, 댓글 작성자, 공감 사용자·종류·상태 버전 필요 |
| 수정 | `PostUpdated`, `PostCommentUpdated` | 변경 대상 ID, 작성자, 변경 시각·버전 및 소비자에게 필요한 변경 값. 단순 수정에 반복 경험치 지급은 비추천 |
| 숨김·복구 | `PostHidden`, `PostRestored`, 필요 시 댓글 대응 이벤트 | 상태 모델 및 Moderation 연동 확정 후. 현재 Post 상태에는 HIDDEN이 없음 |
| 멘션 | 댓글의 멘션 대상 필드 또는 별도 멘션 이벤트 | 수정으로 추가·제거되는 멘션까지 알릴지 결정 후 계약 확정 |
| 조회 | 초기 보상 범위에서 제외 | 유효 조회·반복 조회·익명 조회 기준을 먼저 정의 |

## 7. User의 성장 결과 이벤트 제안 — 미구현

다음 이벤트의 생산자는 Post가 아니라 User다. `user:events`로 발행하며,
User 데이터 변경·처리 이벤트 기록·User Outbox를 같은 로컬 트랜잭션으로 저장한다.

| 이벤트 이름 제안 | domain payload 제안 | Notification 활용 |
| --- | --- | --- |
| `USER_LEVEL_CHANGED` | `userId`, `previousLevel`, `newLevel`, `reason`, `sourceEventId` | 상승한 경우 레벨업 안내. 하락 알림은 정책 결정 |
| `USER_BADGE_GRANTED` | `userId`, `badgeId`, `badgeCode`, `grantedAt`, `sourceEventId` | 칭호·배지 획득 안내 |
| `USER_BADGE_REVOKED` | `userId`, `badgeId`, `badgeCode`, `revokedAt`, `reason`, `sourceEventId` | 필요 시 회수 안내 |

이 표는 연동 요구사항이며 최종 User 계약은 User Service에서 관리한다.
User의 현재 envelope는 `type/version/target/payload`를 사용하므로 Post의
`eventType/schemaVersion/aggregateId` 및 최상위 도메인 객체와 동일하지 않다.
양쪽 Stream의 parser를 무조건 공유하지 않는다.
`sourceEventId`는 원인이 된 Post 이벤트 ID이며 새 User 이벤트의 `eventId`와 다르다.
일괄 재계산으로 변경된 결과의 원인 표현은 별도 확정한다.

칭호가 기존 User 배지와 같은 개념이면 기존 저장 모델을 활용한다. 별개 개념이면
칭호·배지 관계와 이벤트 이름부터 확정한다. 아직 경험치 지급량, 레벨 임계값,
칭호 조건이 결정된 것은 아니다.

## 8. 전달·멱등성·순서·복구 규칙

### Outbox 실패 복구 구현

- MongoDB에 활동 데이터·카운터·Outbox를 함께 커밋하고, 커밋 후 Worker를 깨운다.
  누락된 wake는 주기적 polling으로 복구한다.
- Redis 발행과 MongoDB의 PUBLISHED 변경은 하나의 트랜잭션이 아니다.
  발행 후 중단·응답 유실·저장 실패에는 같은 `eventId`가 재전달될 수 있다.
- Worker는 재시도와 선점 만료 후 회수를 지원한다. 여러 Worker와 재시도 사이에
  같은 게시물의 도메인 변경 순서대로 발행·처리된다고 보장하지 않는다.
- 상태는 `PENDING → PUBLISHING → PUBLISHED`다. 실패하면 지수 백오프
  `min(60초, 1초 × 2^attemptCount)` 후 재시도하고 기본 10회에 도달하면 FAILED로 격리한다.
  손상된 envelope·지원하지 않는 이벤트는 즉시 FAILED다. 실패 원인·시각을 보존한다.
- FAILED 원문은 **MongoDB Outbox 자체**에 보존한다. Redis 장애 중에도 격리할 수
  있도록 생산자 실패를 별도 Redis DLQ로 옮기지 않는다. 소비자 DLQ와는 별개다.
- 매 선점마다 고유 토큰을 만들고 완료·실패 저장에 그 토큰과 PUBLISHING 상태를
  확인한다. 오래된 Worker의 저장은 새 소유자를 덮지 않는다. 마지막 시도 중
  중단된 기록도 선점 만료 후 회수하여 예산 소진 상태로 격리한다.
- Redis 연결·XADD 각각 기본 2초 timeout을 적용하고 실패 연결을 닫는다.
  offline queue·자동 재접속은 끈다. 연결 단절·timeout은 발행 결과가 불명확할 수 있다.
- Redis 발행 성공 후 MongoDB 완료 저장 실패에도 같은 ID로 재시도한다. 실패 상태
  저장까지 실패하면 기존 PUBLISHING 선점이 만료된 뒤 회수된다. 배치는 기본 100건이다.
- `attemptCount`는 이번 재처리 주기의 선점 횟수, `totalAttempts`는 신규 필드 도입 후
  누적 선점 횟수다. XADD의 정확한 실행 횟수가 아니다. 최종 시도 회수·검증 실패도 센다.
- FAILED만 운영자가 원인 확인 후 재시도할 수 있다. payload를 검증하고 동일 eventId,
  occurredAt, payload를 유지한 채 PENDING으로 바꾼다. attemptCount만 0으로 초기화하고
  replayCount, replayedAt, replayReason을 남긴다. 동시 재시도 요청은 한 건만 적용한다.
- Stream trim·Outbox 삭제 정책과 이미 PUBLISHED인 이벤트의 Redis 장애 후 유실 대조는
  별도 운영 범위다. Redis 수락은 영구 보존 또는 exactly-once 보장이 아니다.

### 신규 Notification·User 소비자에 적용할 규칙

1. 서비스마다 독립 Consumer Group을 둔다. 그룹명 제안은 `post-notification`,
   `post-user-activity`이며 아직 생성되지 않았다. 같은 서비스의 여러 Worker만
   그룹을 공유한다. 생산자와 소비자는 같은 이벤트용 Redis endpoint/DB를 사용한다.
2. 처리한 `eventId`와 소유 데이터 변경을 같은 DB 트랜잭션에서 기록하고 커밋 뒤
   `XACK`한다. Notification의 개별 알림은 `(sourceEventId, recipientId, notificationType)`
   등의 유일성으로 중복 생성을 막는다. 묶음 알림도 원본 이벤트의 중복 합산을 막는다.
3. User는 이벤트 중복과 보상 중복을 별도로 막는다. 재참여·공감 재등록은 새로운
   eventId이므로 `(사용자, 활동 대상, 보상 종류)`에 대한 지급·회수 이력이 필요하다.
4. 생성·취소 순서 역전은 활동별 버전과 저장된 상태로 처리한다. 현재 수는 최신
   상태 기준으로 계산한다. 누적 활동·과거 보상을 재구성해야 하는 경우에는 단순히
   낮은 버전 이벤트를 버리지 말고 전이 이력이나 순차 처리·누락 복구를 사용한다.
   취소가 먼저 도착했다고 존재하지 않는 보상을 바로 차감하지 않는다.
5. 실패는 Pending에 남기고 `XAUTOCLAIM` 등으로 회수한다. 재시도 한도를 넘거나
   지원 대상의 계약이 손상된 경우 진단 가능한 DLQ에 저장 성공 후 ACK한다.
   비구독 이벤트 유형은 건너뛸 수 있지만 지원 유형의 미지원 버전은 조용히 버리지 않는다.
6. 푸시 발송은 Notification의 영속적인 전송 작업으로 분리한다. 알림 DB 저장과
   외부 푸시 성공을 원자적으로 묶을 수 없으므로 외부 발송까지 exactly-once라고
   가정하지 않는다. 이미 전송된 푸시는 삭제 이벤트로 회수할 수 없다.
7. Stream은 제한된 보존·재생 수단이다. User의 활동·보상 이력은 User DB에 보존한다.
   보존 구간 밖의 누락은 Post가 제공하는 대조·복구 API나 승인된 내보내기로
   복구하며 다른 서비스가 MongoDB에 직접 접근하지 않는다. 이 복구 API는 미구현이다.

## 9. 제품 정책과 도입 순서

### 구현 전 확정할 정책

- 작성·댓글·공감·참여별 경험치, 일일 한도, 자기 글 활동 인정 여부.
- 누른 공감과 받은 공감의 보상 차이 및 취소 후 재등록 시 재지급 기준.
- 누적 작성 수와 현재 유효 작성 수를 구분할지, 삭제·제재 시 지급 이력을 회수할지.
- 권장 기본안: 자연 만료는 정상 보상 유지, 참여는 게시물별 최초 한 번 인정.
  공감 현재 수는 취소 시 감소시키되 경험치·칭호 회수는 별도 규칙으로 결정.
- 게시물 작성자·참여자·구독자 중 댓글 알림 대상, 본인 활동 알림 제외,
  차단·탈퇴·알림 설정 적용, 공감 묶음 시간과 만료 후 알림 처리.
- 과거 이벤트 backfill 시작점. User 집계 복구와 Notification의 과거 푸시 재발송은
  구분하며, 재처리만으로 오래된 알림을 일괄 전송하지 않는다.

### 호환성 및 배포 순서

1. 기존 네 이벤트의 이름, ID 타입, 중첩 위치, envelope와 필수 필드를 유지한다.
   새 문맥은 과거 메시지에서 누락될 수 있다. 필드 제거·타입·의미 변경은 새
   schemaVersion과 소비자 전환 계획이 필요하다. Map·Semantic의 v1 검사를 유지한다.
2. 기존 이벤트 소비자에 대한 추가 필드 호환성을 확인하고, Notification·User의
   취소·삭제 및 중복 처리 규칙을 구현한 뒤 해당 보상·알림 기능을 활성화한다.
3. 새 상태 변경을 사용하기 전에 **모든 Post writer를 새 버전으로 전환**한다.
   구버전은 취소 tombstone·상태 버전을 모르며 삭제와 활동의 경합도 보호하지 않는다.
   취소 기능 사용 후 구버전으로 단순 롤백하지 않는다. 중단·데이터 대조 절차가 필요하다.
4. 기존 기록의 버전 누락은 1, bucket 누락은 기존 규약대로 처리하므로 필수 백필은 없다.
   단, 기존 counters 기준값을 새 카운터에 중복 복사하지 않는다.
5. 배포 전 Outbox의 오래된 PENDING/PUBLISHING attemptCount를 확인한다. 새 상한을
   넘는 기록은 FAILED가 될 수 있다. 격리 원인 확인 후 운영 CLI로 재시도한다.
6. FAILED 건수·오래된 미발행 건·반복 실패 로그·가장 느린 필수 Consumer의 지연을
   감시한다. 보존 기간과 장애 후 복구 지점을 운영 환경에 맞게 정한다.

### 운영 CLI와 설정

서비스 디렉터리에서 `pnpm build` 후 실행한다. CLI는 `.env`를 자동 로드하지
않으므로 `MONGODB_URI` 등 필요한 값을 환경 변수로 주입한다. DB 쓰기 권한을 가진
운영 환경 전용이며 HTTP/WS에 노출하지 않는다. CLI 자체는 Redis·모델·서버를 시작하지
않는다. 커밋한 이벤트는 실행 중인 서비스의 Outbox Worker가 발행한다.

```bash
pnpm post:operations outbox-failed
pnpm post:operations outbox-retry evt_<UUID> "Redis 복구 확인"
pnpm post:operations schedule-expiration post_<UUID> 2026-10-07T03:00:00.000Z
pnpm post:operations expire post_<UUID>
pnpm post:operations moderate-post post_<UUID> decision-123
pnpm post:operations moderate-comment post_<UUID> comment_<UUID> decision-456
```

`<UUID>`는 실제 식별자로 바꾼다. `outbox-failed`는 최대 100건의 식별자·실패 정보를
반환하며 본문 payload는 출력하지 않는다. `expire`는 기한이 되지 않으면 아무것도
바꾸지 않는다. `outbox-retry`는 PUBLISHED/PENDING 기록을 임의 재발행하지 않는다.
CLI 성공은 도메인 처리 또는 재시도 예약 완료이며 Redis 전달 완료를 뜻하지 않는다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `OUTBOX_POLL_INTERVAL_MS` | 1000 | 발행 polling 간격 |
| `OUTBOX_BATCH_SIZE` | 100 | 발행 및 만료 스캔당 최대 건수 |
| `OUTBOX_MAX_ATTEMPTS` | 10 | 한 재처리 주기의 최대 시도 예산 |
| `OUTBOX_REDIS_TIMEOUT_MS` | 2000 | Redis 연결 및 XADD 각각의 제한 |
| `OUTBOX_LEASE_MS` | 30000 | 발행 선점 기간. Redis timeout의 두 배보다 커야 함 |
| `POST_EXPIRATION_POLL_INTERVAL_MS` | 1000 | 만료 polling 간격 |

모두 양의 안전 정수다. 만료 기한 자체를 임의 기본값으로 생성하지 않는다.

### 검증과 남은 소비자 확인 항목

- 실제 Stream의 `eventId/eventType/data`와 envelope·도메인 필드 계약 일치.
- 실패한 인가·트랜잭션에는 이벤트 없음. 반복 command에는 정의된 멱등성 적용.
- XADD 후 장애, ACK 실패, Consumer 재시작에도 활동·보상·알림 중복 없음.
- 공감 취소→재등록, 이탈→재참여, 취소 이벤트 선도착 시 집계·보상 정확성.
- 부모 게시물 삭제와 하위 활동 삭제가 함께 도착해도 이중 차감 없음.
- 자기 활동, 차단·탈퇴 사용자, 삭제 콘텐츠, 만료 및 자연 만료의 보상 처리.
- 구형 필드 누락·신규 선택 필드·미지원 버전·DLQ 및 보존 구간 밖 누락 복구.
- 두 서비스가 서로 다른 그룹으로 같은 이벤트를 각각 처리함.

Post 검증은 `test/post-events.integration.test.ts`, `test/outbox-failure.test.ts`,
기존 `test/post.integration.test.ts`로 수행한다. 새 통합 테스트는 전용 MongoDB
`wgo_post_events_integration` 및 Redis DB 13의 `post:events`를 사용한다.
실제 소비자별 보상·알림·DLQ·backfill 검증은 해당 서비스 구현 시 수행한다.

## 10. 구현 근거

- [상태 변경 command](../src/post/application/lifecycle.ts)
- [만료 Worker](../src/post/infrastructure/expiration.worker.ts)
- [Outbox 격리·재처리](../src/post/infrastructure/outbox-recovery.ts)
- [운영 CLI](../src/post/infrastructure/operations.cli.ts)
- [이벤트 타입과 Outbox 포트](../src/post/application/ports.ts)
- [이벤트 생성](../src/post/application/event.ts)
- [생성·참여 command](../src/post/application/commands.ts)
- [도메인 데이터 형태](../src/post/domain/post.ts)
- [MongoDB 트랜잭션 저장](../src/post/infrastructure/mongoose-post.store.ts)
- [Redis 발행과 wire format](../src/post/infrastructure/outbox.worker.ts)
- [생성·재참여·재발행 통합 테스트](../test/post.integration.test.ts)
- [Map 이벤트 파서](../../map-service/src/post-index.ts)
- [Realtime 이벤트 소비](../../../gateways/ws-gateway/src/realtime/post-events.ts)
- [Semantic 이벤트 파서](../src/post/semantic/index-post.ts)
- [User 이벤트 계약 및 현재 구현](../../user-service/README.md)
- [Notification 현재 구현](../../notification-service/README.md)
