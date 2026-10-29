# 사용자 차단 계약

POST /api/v1/users/me/blocks 본문은 `{ "blockedUserId":"123" }`, 성공은 204/본문 없음이다. GET 같은 경로는 200 `{ items:[{ userId,nickname,profileImageKey,blockedAt }], nextCursor }`다. DELETE /api/v1/users/me/blocks/{blockedUserId}는 204/본문 없음이다.

기존 user_blocks의 복합 PK·FK·자기차단 CHECK와 Outbox를 재사용한다. 스키마 변경/migration은 없다. 사용자 ID는 기존 규약의 1..9007199254740991 decimal 문자열이며 숫자/leading zero는 거부한다. 생성/해제 요청자는 ACTIVE여야 한다(403). ACTIVE/SUSPENDED 대상은 차단 가능하며 신규 미존재/WITHDRAWAL_PENDING/WITHDRAWN 대상은 404다. 자기 자신은 400이다. 기존 관계의 생성 재시도는 대상이 이후 탈퇴해도 no-op이다. 해제는 미존재·탈퇴 대상에도 멱등이다.

사용자 행을 ID 오름차순 FOR UPDATE로 잠가 없는 관계의 생성/해제와 양방향 동시 차단을 직렬화한다. 상태 변경과 Outbox insert는 같은 트랜잭션이다. 실제 전이가 없는 중복 생성/해제에는 이벤트가 없다.

목록은 인증된 소유자만 조회한다. limit 기본30/최대100, blockedUserId DESC keyset이다. cursor는 소유자와 마지막 ID를 담은 base64url JSON이고 타인 cursor는 400이다. 여러 페이지는 snapshot이 아니므로 추가·삭제 중 새 항목을 확인하려면 첫 페이지부터 조회한다. 생성 시각 정렬이 아니다. 이후 탈퇴 대상도 목록에 남고 익명화는 User lifecycle을 따른다.

서비스 수신은 기존 Gateway ES256 서비스 인증(aud wgo-user-service), Gateway 생성 X-User-Id가 필수다. /docs, /docs/openapi.json과 DELETE 인증을 포함한다. 공개 클라이언트는 사용자 Access JWT만 Gateway에 보내며 내부 헤더/서비스 키를 직접 넣지 않는다.

## 이벤트

생산자 user-service, Stream user:events, XADD 필드는 eventId/eventType/data다. data는 아래 전체 envelope의 JSON 문자열이다. 기존 컨벤션을 따라 envelope는 **type/version/payload**를 사용한다.

```json
{
  "eventId":"123e4567-e89b-42d3-a456-426614174000",
  "type":"USER_BLOCK_CREATED",
  "target":{"type":"USER","id":"100"},
  "occurredAt":"2026-10-29T03:00:00.000Z",
  "version":1,
  "producer":"user-service",
  "correlationId":"123e4567-e89b-42d3-a456-426614174001",
  "payload":{"blockerUserId":"100","blockedUserId":"123"}
}
```

해제는 type/Redis eventType=USER_BLOCK_REMOVED이며 다른 필드는 동일하다. eventId는 UUID, target.id/사용자 ID는 문자열이다. Outbox aggregate_id는 차단자다. nickname/이미지/본문은 포함하지 않는다. user-block-events.schema.json에도 필드 계약을 제공한다.

기존 Worker가 pending 잠금/skip locked → XADD → PUBLISHED로 처리한다. 실패는 같은 eventId로 다음 poll에 재시도한다. XADD 성공 후 DB commit 실패는 중복 발행할 수 있다(at-least-once). 소비자는 eventId와 부작용을 함께 영속 저장하고 XACK한다. 여러 Worker 전달 순서는 보장하지 않는다. 도착 순서대로 관계를 덮어쓰지 말고 원본 재동기화/버전 계약을 먼저 합의한다.

생산자는 무기한 retry하며 영구 실패를 자동 폐기하지 않는다. PENDING/attempts·기존 경고 로그를 감시한다. 소비 Group(예: post-user-blocks-v1)은 제안이며 현재 생성하지 않는다. 각 소비자가 Pending reclaim/backoff/최대 재시도/DLQ를 구현해야 한다. Notification/Post/Map 신규 소비는 미구현이다.

두 사용자 ID도 개인정보이므로 보존/접근 정책을 확정해야 한다. TTL/자동 trim/Outbox 삭제는 추가하지 않았다. Redis 유실은 승인된 감사 후 필요한 Outbox PUBLISHED를 PENDING으로 복구하여 같은 eventId로 재발행한다. 운영 재처리는 멱등 소비자가 전제다.

[Gateway 후속 요청](../../moderation-service/contracts/gateway-handoff.md)의 allowlist/동적 DELETE 및 통합 Swagger 작업이 필요하다. 이번 작업은 Gateway/CloudFront 반영을 포함하지 않는다.

## dev 병합 호환 경로

기존 PUT /api/v1/users/me/blocks와 DELETE 같은 경로의 `{userId:"123"}` 본문도 지원한다. 둘 다 신규 changeBlock 트랜잭션을 호출하므로 POST/경로 DELETE와 섞어 재시도해도 실제 상태 전이당 이벤트1개만 생성한다. GET에는 기존 createdAt을 blockedAt과 같은 시각의 호환 별칭으로 추가했다.

기존 숫자 cursor는 오름차순 continuation으로 해석하고 다음 opaque cursor에 direction=ASC를 보존한다. 새로운 첫 페이지는 내림차순이며 다음 cursor에 DESC를 기록한다. limit 기본30/최대100, 관계 조회는 항상 현재 소유자 조건을 적용한다.

최신 Gateway는 GET/PUT/본문 DELETE를 이미 허용한다. 신규 POST/경로 DELETE의 allowlist·문서 노출은 [최신 후속 요청](../../moderation-service/contracts/gateway-handoff.md)을 따른다.
