# 신고 HTTP·저장·이벤트 계약

## API와 인증

공개 클라이언트는 사용자 Access JWT만 Gateway에 보낸다. 직접 서비스 호출은 ES256 Gateway 서비스 JWT와 Gateway가 재작성한 X-User-Id가 필수다. issuer=wgo-http-gateway, subject=http-gateway, audience=wgo-moderation-service, typ=wgo-service+jwt, 등록된 kid, iat/exp 최대 60초다. User audience와 혼용하지 않는다. JWT의 서명된 userId가 X-User-Id와 일치해야 한다. MODERATION_HTTP_GATEWAY_TRUSTED_JWKS 미설정이면 개발·운영 모두 신고 경로는 401로 닫힌다. 잘못된 JWKS는 시작을 거부한다.

| API | 요청 | 성공 |
| --- | --- | --- |
| POST /api/v1/moderation/reports | 아래 본문 | 201 ReportResponse |
| DELETE /api/v1/moderation/reports/{reportId} | 본인 신고 ID | 200 ReportResponse |

```json
{"targetType":"POST","postId":"post_123e4567-e89b-42d3-a456-426614174000","reason":"SPAM","description":"광고성 게시글"}
```

댓글은 targetType=COMMENT이며 commentId=comment_<UUID>가 추가로 필요하다. POST에는 commentId를 넣지 않는다. 이유는 SPAM, HARASSMENT, INAPPROPRIATE_CONTENT, FALSE_INFORMATION, OTHER 중 하나다. description은 선택이며 최대 2000 Unicode 문자다. 잘못된 필드/ID/사유·알 수 없는 필드는 400이다. API 사용자 ID는 기존 규약의 decimal 문자열 1..9007199254740991이다.

응답은 `{ reportId: "report_<UUID>", status: "PENDING", createdAt: "ISO8601", withdrawnAt: null }`이다. 취소하면 status=WITHDRAWN, withdrawnAt=최초 취소 시각이다. 타인/미존재 신고는 404로 동일하게 처리한다. 검토 완료 REVIEWED의 취소는 409이며 검토·관리자 API는 이번 범위 밖이다. 단순 신고로 자동 제재하지 않는다.

신고자/대상별 평생 1건이다. PENDING/REVIEWED에 재요청하면 최초 신고를 반환하고 사유·설명을 바꾸지 않는다. WITHDRAWN 이후 재신고는 409다. 중복 취소는 최초 시각을 유지하며 이벤트가 없다. 응답 유실 재시도와 의도적인 재신고를 구분하는 별도 키 계약이 없으므로 이 정책을 택했다. 삭제·만료 대상이라도 기존 신고 재요청/취소는 감사 기록을 기준으로 처리한다.

## Redis 원본과 발행 복구

신고 원본·불변 이벤트 journal·발행 확인을 기존 REDIS_URL의 Redis에 저장한다. PostgreSQL 연결, pg 의존성, SQL migration 및 reports-db Compose profile은 제거했다. User 서비스 DB·Outbox나 다른 서비스 저장소는 변경하지 않는다.

- `moderation:reports:v1:records` HASH: `target:<신고자/targetType/postId/commentId tuple의 SHA-256>`에 `{format:1, stream, report, events}`를 저장하고 `id:<report_UUID>`에 해당 digest를 저장한다. 생성 시 두 필드를 한 HSET으로 기록한다.
- `moderation:reports:v1:pending` SET: 발행 복구 대상 digest. canonical HSET **전에** 등록한다. 그 사이 Lua가 실패하면 미커밋 queue 항목만 남으며 Worker가 제거한다. canonical 상태와 이벤트 journal은 한 값이므로 따로 커밋될 수 없다.
- Lua는 records/pending/stream 타입과 기존 journal을 쓰기 전에 검사한다. 동일 Lua 실행에서 상태 변경 → 기존 XADD → journal의 streamId 확인 순서로 처리한다. 취소 전에 생성 이벤트의 발행 확인을 끝낸다.
- Lua는 실행 중 오류를 롤백하지 않는다. HSET 이후 실패하면 기존 reportId·eventId·발생 시각·payload를 유지한 journal과 pending에서 재시도한다. XADD 이후 확인 HSET이 실패하면 같은 eventId가 중복 발행될 수 있지만 취소보다 뒤에 생성 이벤트를 재발행하지 않는다.
- ReportOutboxWorker는 **제거하지 않았다**. SQL polling 대신 SSCAN cursor/overflow buffer로 tick당 최대20개 신고를 복구한다. 1초 주기와 시작 시 복구를 유지하고, 여러 인스턴스도 동일 Lua를 사용한다. 클라이언트가 다시 요청하지 않아도 미발행 이벤트를 복구한다.
- 원본·journal·중복 방지 정보에는 TTL이나 자동 삭제가 없다. reportId와 이벤트 UUID, 응답 스키마, 신고/취소 멱등 정책을 유지한다. 설명은 원본에만 남고 이벤트에는 넣지 않는다.

REDIS_URL, REPORTS_POST_SERVICE_URL, MODERATION_HTTP_GATEWAY_TRUSTED_JWKS를 설정한다. Redis 미설정/연결 장애·손상된 키는503이며 메모리나 User DB로 우회하지 않는다. Redis 장애 중 신규 신고를 PostgreSQL에 접수하던 이전 동작은 사라진다. 서버에서 상태 전이가 실행되고 응답만 실패한 경우에는 원본이 남을 수 있으므로 재요청은 저장된 결과를 따른다.

기존 `moderation:report:<64자리 hash>` 및 다른 Redis 키·스트림·Consumer Group은 건드리지 않는다. 과거 형식과 새 report_UUID 계약을 자동 변환하지 않는다. 실제 PostgreSQL 데이터가 있다면 전환 전에 reportId·eventId·원본 payload·발행 이력을 보존하는 별도 검토 이관이 필요하다. 이번 로컬 작업은 기존 DB나 Redis 데이터를 이관·삭제하지 않았다. 설정·Compose 정의 제거도 기존 PostgreSQL 볼륨/테이블 삭제를 실행하지 않는다.

운영은 원본이 eviction되지 않는 정책, Redis persistence/backup/복구 훈련, TLS/ACL과 보존/익명화 정책을 마련해야 한다. 공용 Redis 전체 정책을 앱이 CONFIG SET으로 바꾸지 않는다. 현재 standalone/cluster-mode-disabled 연결을 전제로 하며 다른 hash slot에 걸친 Redis Cluster Lua는 지원하지 않는다. event stream 설정을 바꿔 기존 journal을 다른 스트림에 자동 재발행하지 않도록 저장된 stream과 다르면 거부한다.

Redis 원본과 journal이 함께 영구 유실되면 독립 PostgreSQL 원본에서 복구하던 보장은 없다. Lua의 실행 격리와 디스크 영속성은 다르다. 로컬 AOF appendfsync=always 강제 종료/재시작 통과가 운영 ElastiCache의 영속성·failover/RPO 검증을 대신하지 않는다.

## Post 대상 검증

기존 공개 GET /api/v1/posts/{postId}, GET /api/v1/posts/{postId}/comments?limit=100&cursor=... 계약을 사용한다. 부모 ACTIVE/미만료와 댓글 ID·부모·ACTIVE를 확인한다. 전체 3초, 댓글 최대 10페이지다. 확정된 미존재/삭제/만료는 404, 응답 오류·장애·탐색 예산 초과는 503이며 저장하지 않는다. 큰 댓글 목록에 정확한 단건 조회가 필요하므로 Post 담당자에게 대상 검증 API/Moderation 호출자 인증 계약을 요청한다. 기존 ws-gateway 전용 내부 API의 권한은 사용하지 않는다.

검증 이후 로컬 커밋 전에 대상이 삭제되는 경쟁은 분산 트랜잭션으로 막지 않는다. 신고는 검증 당시 대상에 대한 감사 기록이다. 취소는 Post 가용성에 의존하지 않는다.

## Redis Streams 이벤트

Stream은 moderation:report-events(MODERATION_REPORT_EVENT_STREAM으로 변경 가능), 생산자는 moderation-service다. Lifecycle moderation:events, AI moderation:content-events, Post post:events와 같은 키는 시작 시 거부한다.

XADD 필드: eventId(UUID), eventType(REPORT_CREATED/REPORT_WITHDRAWN), data(아래 전체 envelope의 JSON 문자열). Redis Stream ID와 eventId는 다르다.

```json
{
  "eventId":"123e4567-e89b-42d3-a456-426614174000",
  "eventType":"REPORT_CREATED",
  "schemaVersion":1,
  "producer":"moderation-service",
  "occurredAt":"2026-10-29T03:00:00.000Z",
  "data":{
    "reportId":"report_123e4567-e89b-42d3-a456-426614174000",
    "reporterUserId":"100",
    "targetType":"COMMENT",
    "postId":"post_123e4567-e89b-42d3-a456-426614174000",
    "commentId":"comment_123e4567-e89b-42d3-a456-426614174000",
    "reason":"HARASSMENT"
  }
}
```

취소는 eventType=REPORT_WITHDRAWN이며 data.reason 대신 data.withdrawnAt(occurredAt과 같은 시각)을 포함한다. commentId는 댓글에서만 있다. description/본문/기타 개인정보는 이벤트에 넣지 않는다. 필드 계약은 report-events.schema.json에도 기록했다.

REPORT_CREATED는 신규 신고 전이에서만, REPORT_WITHDRAWN은 본인 PENDING→WITHDRAWN 전이에서만 journal에 생성한다. 정상 경로는 Lua에서 즉시 XADD한다. Worker와 재요청 모두 같은 journal을 복구하며 이미 확인된 이벤트는 다시 보내지 않는다. 발행 확인 직전의 부분 실패는 동일 eventId 중복을 허용하는 **at-least-once** 계약이다. 같은 신고의 생성 이벤트 확인 전에 취소 이벤트를 발행하지 않는다. 서로 다른 신고 사이의 전체 순서는 계약하지 않는다.

미발행 journal을 무기한 자동 폐기하지 않으며 생산자 DLQ는 추가하지 않았다. pending 개수·지연과 복구 실패 로그를 관측한다. 미래 소비자는 별도 Group(예: moderation-report-review-v1), eventId 영속 중복 방지와 부작용 원자 저장, 저장 후 XACK, Pending reclaim·backoff·자체 DLQ를 준비해야 한다. 해당 Group은 제안이며 이번에 새 소비자를 등록하지 않는다.

Stream 자동 trim/삭제, Redis 기존 데이터 초기화는 하지 않는다. 현재 /health/ready는 Lifecycle/AI readiness이며 신고 대상 Post 접근 권한까지 보증하지 않는다. 인증된 신고 smoke와 pending 관측이 필요하다.

## 최신 dev 병합 시 계약 정리

Redis-only src/reports.ts와 우회 가능한 별도 guard는 등록/유지하지 않고 단일 ReportsModule의 Redis 원본·journal로 통합했다. 과거 targetId/자유문자열 사유 본문은 postId/commentId 및 enum 사유·description으로 전환해야 한다. 기존 Redis 신고 키는 삭제하지 않지만 새 namespace로 자동 이관하지도 않는다.

최신 dev의 운영 Post 공개 조회는 Gateway 서비스 JWT와 서명된 사용자 ID가 필요하다. 현재 무인증 서비스 직접 읽기로는 검증할 수 없어503이 된다. Moderation→Post 단건 대상 검증 서비스 인증 계약/클라이언트를 준비한 뒤 운영 접수를 열어야 한다. [병합 후 후속 요청](gateway-handoff.md)을 따른다.
