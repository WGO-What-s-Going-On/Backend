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

## 원본 저장과 운영 선행 작업

**신규 Moderation 전용 PostgreSQL**을 원본으로 사용한다. 현재 배포는 Redis 기반이므로 신규 운영 DB가 이미 준비되었다고 가정하지 않는다. 기존 Lifecycle/AI Redis 구조는 변경하지 않는다. User/Post의 데이터베이스를 직접 사용하지 않는다.

- moderation_reports: report_id PK, reporter_user_id BIGINT, target_type, post_id, comment_id(POST는 빈 문자열), 원본 document JSONB. reporter/target/post/comment UNIQUE. document에 최초 사유·설명·생성 시각, 상태·취소 시각을 보존한다.
- moderation_report_outbox: 증가 sequence PK, event_id UUID UNIQUE, report FK, event_type, 불변 envelope JSONB, attempts, published_at. pending 및 report별 pending 인덱스.
- 생성과 이벤트 insert, 취소와 이벤트 insert는 각각 동일 DB 트랜잭션이다. 없는 행의 경쟁은 advisory transaction lock+UNIQUE, 취소는 소유자 조건 FOR UPDATE로 직렬화한다.
- 원본/이벤트에 TTL·자동 삭제는 없다. 운영 공개 전 개인정보 담당자가 설명·신고자 ID·이벤트의 보존 기간, 접근 통제, 삭제/익명화, 법적 보존 예외를 확정해야 한다. published Outbox도 자동 청소하지 않는다.

인프라 담당자는 전용 DB/계정/최소 권한, 검증 가능한 TLS·CA, 네트워크, 백업/PITR·복구 훈련, Secret 배포를 준비한다. MODERATION_REPORTS_DATABASE_URL을 주입하고 `pnpm reports:migrate`를 한 번 실행한다. 마이그레이션은 시작 시 자동 실행하지 않으며 이미 적용된 DB에 재실행하면 테이블 존재 오류로 중단한다. 두 테이블/인덱스는 DDL 트랜잭션으로 함께 생성한다. pg URL의 TLS 인증서 검증을 끄지 않는다. 새 어댑터의 RDS IAM 토큰 자동 회전은 미구현이다.

런타임에 DB URL, REPORTS_POST_SERVICE_URL(Post HTTP origin), REDIS_URL, MODERATION_HTTP_GATEWAY_TRUSTED_JWKS를 준비한다. DB/대상 검증 미설정·장애는 503이다. Redis 장애 중에도 DB 커밋된 신고는 성공하며 Outbox에서 재발행한다. REDIS_URL이 없으면 worker를 시작하지 않으므로 공개 전에 반드시 설정한다. Gateway 인증·문서 변경은 별도 담당자 작업이다.

로컬 Compose는 reports-db profile의 PostgreSQL 5434를 제공한다. 예: MODERATION_REPORTS_DATABASE_URL=postgres://wgo:wgo@127.0.0.1:5434/wgo_moderation. 테스트 기본값 5432와 다르므로 통합 테스트에서는 MODERATION_TEST_DATABASE_URL=postgres://wgo:wgo@127.0.0.1:5434/postgres를 지정한다.

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

Worker는 1초 poll/최대20건, FOR UPDATE SKIP LOCKED를 사용한다. 같은 report의 미발행 선행 sequence가 있으면 후행 이벤트가 기다린다. XADD 성공 후에만 published_at을 기록한다. Redis 실패는 attempts 증가/pending 보존 후 다음 poll에 재시도한다. XADD 성공·DB 확인 실패 또는 응답 유실이면 **동일 eventId**로 중복 전달할 수 있다. at-least-once이며 소비자는 eventId 영속 UNIQUE와 부작용을 같은 트랜잭션으로 저장한 뒤 XACK한다.

무기한 retry로 원본을 자동 폐기하지 않는다. pending/attempts/sequence 지연과 로그를 감시한다. 생산자 DLQ는 미구현이며 원본을 남긴다. 미래 소비자는 독립 Group(예: moderation-report-review-v1), Pending reclaim, 제한된 backoff/retry 후 자체 DLQ, 같은 eventId의 검토 재처리를 구현해야 한다. 이 Group은 제안이며 현재 생성·소비되지 않는다. Post/Notification이 자동으로 소비한다고 가정하지 않는다.

Stream 자동 trim은 없다. 운영자는 모든 Group의 확인 checkpoint와 보존 정책으로 trim한다. Redis 장애조치/최근 쓰기 손실은 PostgreSQL에 PUBLISHED로 남은 이벤트도 유실시킬 수 있다. sequence/eventId 범위를 감사해 필요한 outbox의 published_at을 NULL로 복구하고 같은 ID로 재발행한다. 운영 재처리는 소비자 멱등성을 먼저 확인해야 한다. Redis RPO와 PostgreSQL 원본 영속성을 동일시하지 않는다.

기존 /health/ready는 Lifecycle/AI 의존성을 검사하며 신규 신고 DB·Post 검증의 준비 상태를 나타내지 않는다. 운영 공개 전에 신고 경로에 대한 인증된 smoke 및 outbox pending 감시를 별도로 수행한다.

## 최신 dev 병합 시 계약 정리

Redis-only src/reports.ts와 우회 가능한 별도 guard는 등록/유지하지 않고 단일 PostgreSQL ReportsModule로 통합했다. 과거 targetId/자유문자열 사유 본문은 postId/commentId 및 enum 사유·description으로 전환해야 한다. 기존 Redis 신고 키는 삭제하지 않지만 새 DB로 자동 이관하지도 않는다.

최신 dev의 운영 Post 공개 조회는 Gateway 서비스 JWT와 서명된 사용자 ID가 필요하다. 현재 무인증 서비스 직접 읽기로는 검증할 수 없어503이 된다. Moderation→Post 단건 대상 검증 서비스 인증 계약/클라이언트를 준비한 뒤 운영 접수를 열어야 한다. [병합 후 후속 요청](gateway-handoff.md)을 따른다.
