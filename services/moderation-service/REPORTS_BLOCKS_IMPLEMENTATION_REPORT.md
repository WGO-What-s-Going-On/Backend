> 이 문서는 최초 PostgreSQL 구현 당시의 이력이다. 현재 Moderation 신고 저장·복구는 Redis로 전환했다. 최신 동작·이벤트 호환성·검증 결과는 [Redis 전환 보고](REDIS_REPORTS_IMPLEMENTATION_REPORT.md)를 따른다. User 서비스의 PostgreSQL·Outbox는 그대로다.

# 사용자 차단·신고 구현 결과 (2026-10-29)

## CI 후속 수정

- Moderation의 PostgreSQL 신고 통합 테스트가 추가되었으나 CI 시작 의존성은 Redis만 선택하고 있었다. scripts/ci-dependencies.mjs의 moderation 의존성을 postgres/redis6383으로 보완하고, 시작·정리 명령의 회귀 테스트를 추가했다. 실제 CI 시작 스크립트로 두 컨테이너의 healthcheck 통과도 확인했다.
- User 통합 테스트는 app.init만 호출해 Supertest가 공유 서버를 요청 단위로 자동 시작·종료했다. 동시 요청 중 자동 종료와 연결이 경쟁할 수 있어, beforeAll에서 loopback 임의 포트로 listen하고 afterAll에서 종료하도록 수정했다. 동시성 테스트가 시작될 때 listening 상태도 검증한다. 업무 트랜잭션이나 동시 요청 수를 줄이거나 실패를 retry로 감추지 않았다.
- 신고 테스트의 CREATE DATABASE가 실패하면 생성하지 않은 DB에 DROP을 다시 시도하지 않고 administrative pool을 정리하도록 보완했다.
- 검증: Linux Node24의 User 통합73개 통과, 같은 동시 요청 테스트10회 연속 통과. User 전체246/선택1개 생략, Moderation59, 실제 CI 의존성으로 통합56/선택1개 생략, Linux CI/CD 스크립트49개 통과. 두 서비스 typecheck/build, 루트 format과 diff 검사를 통과했다.
- Linux 스크립트 검증은 Windows 체크아웃의 CRLF를 임시 컨테이너 복사본에서 CI와 같은 LF로 맞추어 수행했다. 원본 workflow는 변경하지 않았다. 운영 자원·Secrets·배포는 사용하지 않았다.

## 최신 dev 병합 결과

최신 dev 9176d57을 현재 기능 브랜치에 병합했다. 기존 기능 커밋 a984102는 그대로 보존하며 backup/blocks-reports-before-dev-merge에서도 확인할 수 있다. User 실명/브라우저 쿠키·새 migration 및 다른 서비스의 dev 변경을 보존했다.

충돌9개 파일과 자동 병합으로 생긴 중복 라우트/키를 정리했다. 차단의 구 PUT/본문 DELETE와 신 POST/경로 DELETE는 단일 트랜잭션·Outbox를 사용한다. GET은 기존 createdAt 별칭과 숫자 ASC 커서를 지원하고 신규 DESC opaque 커서도 유지한다. 신고는 단일 PostgreSQL ReportsModule로 통합하며, 최신 Gateway의 서명된 userId와 헤더 일치 검증을 보존했다.

기존 dev 신고의 targetId/자유문자열 본문은 원래 작업의 postId/commentId·enum 사유/description 계약으로 전환해야 한다. 예전 Redis-only 데이터를 삭제하지 않았으며 운영 이관은 별도다. 최신 Post 운영 조회의 서비스 인증 계약이 없어 대상 확인은503으로 닫히므로 Moderation 전용 DB와 Moderation→Post 검증 API가 운영 선행 조건이다.

Gateway의 Moderation 인증·문서 수집은 dev에 이미 포함됐다. 남은 User 신경로 allowlist/문서와 프론트/Post/인프라 변경은 [최신 후속 요청](contracts/gateway-handoff.md)이 기준이다. 아래 본문은 최초 구현 당시의 조사/검증 기록이며 Gateway 상태는 이 병합 결과가 우선한다. 병합 후 검증은 Node24.13.0/pnpm10.33.0에서 완료했다. User 246통과/외부 Gateway 선택1개 생략, Moderation 59통과, 격리된 Redis의 통합56통과/재시작 선택1개 생략이다. 두 서비스 typecheck/build, 루트 format과 변경분 검사를 통과했다. 동시 실행에서 Redis DB15가 공유된 첫 통합 실행은 충돌했으며, Moderation용 로컬 Redis를 분리한 최종 실행은 통과했다. 실제 PostgreSQL 이벤트6개와 서비스 OpenAPI 형식도 검증했다. 기능 차이는 dev 대비 User/Moderation 두 서비스의43개 파일에 한정한다.

## 최초 구현 기록

## 1. 작업 기준과 브랜치

브랜치: `feat/user-blocks-moderation-reports`. 파일 수정 전에 dev에서 새 브랜치를 생성했다. 시작 시 작업 트리는 깨끗했고 HEAD/origin/dev 및 원격 조회한 dev가 모두 8b2598d였다. 기존 변경을 덮어쓰거나 rebase/reset하지 않았다. push/PR/병합/AWS 배포·운영 데이터·Secrets 변경은 하지 않았다.

## 2. 구현 API와 프론트 계약

| 메서드·경로 | 요청 | 응답 |
| --- | --- | --- |
| POST /api/v1/users/me/blocks | `{ "blockedUserId":"123" }` | 204, 본문 없음 |
| GET /api/v1/users/me/blocks | cursor 선택, limit 기본30/최대100 | 200 `{ items:[{userId,nickname,profileImageKey,blockedAt}], nextCursor }` |
| DELETE /api/v1/users/me/blocks/{blockedUserId} | 경로 ID | 204, 본문 없음 |
| POST /api/v1/moderation/reports | targetType, postId, reason, description 선택; COMMENT에는 commentId 필수 | 201 `{reportId,status,createdAt,withdrawnAt}` |
| DELETE /api/v1/moderation/reports/{reportId} | 본인 신고 ID | 200 동일 응답 형식, WITHDRAWN/최초 취소 시각 |

사용자 ID는 기존 서비스 규약의 decimal 문자열(1..9007199254740991)이다. post/comment/report ID는 각각 접두사와 UUID 문자열이다. 신고 사유는 SPAM/HARASSMENT/INAPPROPRIATE_CONTENT/FALSE_INFORMATION/OTHER, description은 최대2000 Unicode 문자다. unknown fields와 잘못된 조합은 400이다.

차단 생성·해제 요청자는 ACTIVE, 차단 대상은 ACTIVE/SUSPENDED를 허용한다. 자기 자신400, 미존재/탈퇴/탈퇴대기 신규 대상404, 비활성 요청자403이다. 중복 차단·해제는 이벤트 없는 멱등204다. 탈퇴 대상의 기존 관계도 해제할 수 있다. 목록은 본인 소유자 조건과 ID 내림차순 keyset이며 타인 cursor는400이다.

신고는 신고자/대상별 평생1건으로 최초 사유/설명을 보존한다. PENDING/REVIEWED 재요청은 원본 반환, WITHDRAWN 재신고는409다. PENDING만 취소 가능하고 중복 취소는 최초 시각 유지/이벤트 없음이다. REVIEWED 취소409, 타인 신고는404다. 취소는 soft 상태 변경이며 설명·감사 이력은 남긴다. 검토/제재 API와 자동 제재는 추가하지 않았다.

## 3. 원본 저장 구조와 동시성

User는 기존 PostgreSQL user_blocks(복합 PK/FK/CHECK)와 outbox_events를 재사용한다. 사용자 행을 ID 오름차순 FOR UPDATE로 잠가 관계가 없는 경우의 동시 생성/삭제·양방향 차단을 직렬화한다. 차단 변경과 Outbox insert가 같은 트랜잭션이다. User DB migration은 불필요하다.

Moderation에는 전용 PostgreSQL 원본을 추가했다. moderation_reports는 식별·소유자·대상 키와 원본 JSONB, 대상별 UNIQUE를 가진다. moderation_report_outbox는 sequence, stable eventId, 원본 envelope, attempts/published_at 및 pending 인덱스를 가진다. 신규 migrations/001-reports.sql은 DDL 트랜잭션이며 pnpm reports:migrate로 명시 실행한다. 실행 시 자동 migration은 없다.

신규 신고는 advisory transaction lock+UNIQUE, 취소는 소유자 조건 FOR UPDATE로 보호한다. 신고/취소 상태와 이벤트 생성은 각각 원자적인 DB 트랜잭션이다. 기존 Lifecycle/AI Redis 구조와 별개이며 User/Post DB에는 접근하지 않는다. TTL/자동 삭제는 없다.

**운영 Moderation DB는 아직 확보/연결되었다고 가정하지 않는다.** 전용 DB/계정, TLS·CA, 백업/PITR, 복구·접근 정책, migration·Secret 주입은 인프라 담당자의 선행 작업이다. 신규 pg 어댑터의 RDS IAM 토큰 회전은 미구현이다. 미설정 DB·대상검증은503으로 닫힌다.

## 4. Redis 이벤트 4종의 실제 계약

| 이벤트 | Stream | envelope |
| --- | --- | --- |
| USER_BLOCK_CREATED | user:events | eventId, **type**, target:{type:USER,id:차단자}, occurredAt, **version:1**, producer:user-service, correlationId, **payload:{blockerUserId,blockedUserId}** |
| USER_BLOCK_REMOVED | user:events | 동일 구조, type만 변경 |
| REPORT_CREATED | moderation:report-events | eventId, **eventType**, **schemaVersion:1**, producer:moderation-service, occurredAt, **data:{reportId,reporterUserId,targetType,postId,commentId?,reason}** |
| REPORT_WITHDRAWN | moderation:report-events | 동일 구조, data.reason 대신 **withdrawnAt** |

모든 Redis 메시지의 필드는 eventId/eventType/data이며 Redis의 data는 위 **전체 envelope의 JSON 문자열**이다. User envelope는 기존 type/version/payload를 유지하여 예시 형식과 구분한다. eventId는 UUID, 사용자 ID는 문자열이다. 신고 상세 설명·본문은 이벤트에서 제외한다. 버전별 JSON Schema를 각 서비스 contracts에 추가했다.

현재 Post는 moderation:events의 BOARD Lifecycle을 소비한다. 신고를 별도 moderation:report-events로 분리해 해당 소비자를 변경하지 않았다. User 신규 이벤트 소비자는 저장소에서 확인되지 않았다. 신규 이벤트를 Notification/Post/Map이 자동 소비한다고 주장하지 않는다.

## 5. Outbox·장애 복구

User는 기존 Outbox Worker/Publisher를 재사용한다. Moderation worker는 1초 poll, 최대20건, FOR UPDATE SKIP LOCKED로 발행한다. 같은 신고의 미발행 선행 sequence가 있으면 후행 취소가 기다린다. 두 서비스 모두 XADD 성공 후 발행 완료를 기록한다. Redis 장애는 DB pending 원본에서 동일 eventId로 재시도한다.

XADD 성공/SQL 확인 실패·응답 유실은 같은 eventId로 중복 전달할 수 있는 **at-least-once** 계약이다. 생산자는 영구 실패를 자동 폐기하지 않으며 pending/attempts·로그 감시가 필요하다. 생산자 DLQ/자동 trim은 추가하지 않았다. 미래 소비자는 eventId 영속 중복 방지와 부작용 원자 저장, 저장 후 XACK, Pending reclaim/backoff/소비자 DLQ를 구현해야 한다.

Redis 장애조치로 발행 완료 이벤트가 유실되면 PostgreSQL Outbox를 감사해 같은 ID로 재발행해야 한다. User worker의 여러 인스턴스 간 전달 순서는 보장하지 않는다. 관계 재동기화 API/버전 계약이 필요한 소비자는 후속 작업이다. 보존·익명화/접근 통제 기간은 운영 공개 전에 확정해야 한다.

## 6. 대상 검증과 인증·인가

신고 대상은 기존 Post 공개 상세/댓글 목록 HTTP 계약으로 ACTIVE/미만료, 댓글 소속/상태를 검증한다. 3초·최대10페이지 예산 내 미존재는404, 장애/예산 초과는503이며 저장하지 않는다. 단건 대상 확인 API가 없으므로 큰 댓글 목록에는503 제한이 있다. 검증 이후 로컬 저장 전 삭제 경쟁은 감사 기록으로 허용하며 취소는 Post 가용성과 무관하다.

User 수신 GatewayAuthGuard에 새3개 API를 등록했다. Moderation은 별도 MODERATION_HTTP_GATEWAY_TRUSTED_JWKS와 audience wgo-moderation-service로 ES256 Gateway 인증을 검증한다. issuer/subject/typ/kid/iat/exp/서명, 중복 헤더·사용자 ID를 확인한다. 개발 인증 우회는 없고 JWKS 미설정은401이다. User용 audience/신뢰키와 혼용하지 않는다.

공개 클라이언트의 사용자 토큰 검증·내부 헤더 제거/재작성은 Gateway 후속 작업이다. 신고자의 최신 정지/탈퇴 상태 조회는 기존 Gateway 계약에 없으므로 아직 별도 연결되지 않았다. 현 /health/ready는 Lifecycle/AI 준비 상태이며 신규 신고 DB/Post 상태까지 보증하지 않는다.

## 7. Swagger 및 통합 Gateway 상태

서비스별 /docs, /docs/openapi.json에 신규5개 API/DTO/enum/인증/오류를 반영했다. User DELETE도 서비스 인증 대상이다. 추가 필드 금지 및 POST/COMMENT별 commentId 조건을 OpenAPI schema에 반영했다.

실제 생성한 두 서비스 Controller fixture OpenAPI는 SwaggerParser의 OpenAPI3.0 검증을 통과했다. PostgreSQL 실제 상태 전이에서 추출한 User2개/Moderation4개 이벤트도 JSON Schema/UUID/date-time 검증에 통과했다.

**통합 Swagger·CloudFront는 아직 반영되지 않았다.** Gateway userOperations는 신규 User API를 거부하고, Moderation은 undocumentedServices에 있다. 단순 수집 추가 외에도 source.service==='user' 전용 내부→공개 인증 변환을 확장해야 한다. 파일/함수/endpoint/테스트별 요청은 contracts/gateway-handoff.md에 있다.

## 8. 테스트 명령과 결과

Node24.13.0/pnpm10.33.0을 사용했다. 운영 .env를 테스트에 로드하지 않고 새 로컬 PostgreSQL18/Redis8 컨테이너만 사용했다. 임시 DB와 전용 Redis 키를 정리한다. 초기 과도한 병렬 실행에서 기존 시간제한 실패가 발생하여 worker2/명시 timeout으로 재검증했다. 테스트 기대값 오류2건도 수정했다.

| 범위 | 명령 | 결과 |
| --- | --- | --- |
| User | pnpm typecheck / pnpm build | 통과 |
| User 전체 | pnpm test --maxWorkers=2 --hookTimeout=30000 --testTimeout=30000 | 243통과, 기존 외부 Gateway 선택 테스트1개 생략 |
| Moderation | pnpm typecheck / pnpm build | 통과 |
| Moderation 전체 | pnpm test --maxWorkers=2 --hookTimeout=30000 --testTimeout=30000 | 58통과 |
| Moderation 통합 | pnpm test:integration | 56통과, 기존 Compose Redis 재시작 선택 테스트1개 생략 |
| 루트 | npm.cmd run format | 실행 완료, 무관한 줄바꿈 변경 복원 |
| 계약 | 실제 OpenAPI SwaggerParser 검증 / 실제 이벤트 JSON Schema+format 검증 | 두 문서 및 이벤트6개 통과 |

동시 요청·멱등 이벤트 억제·페이지네이션·권한·검증·신고 원본 보존, 실제 SQL 이벤트 insert 실패 롤백, Redis WRONGTYPE 실패/복구, XADD 성공 후 SQL 확인 실패의 동일 eventId 재전달을 검증했다. 선택 Gateway 실연동/Redis 컨테이너 재시작 및 OpenAI 실호출은 수행하지 않았다.

## 9. 프론트엔드 연동 가능 여부

서비스 API/명세는 로컬에서 검증했다. **배포된 공개 Gateway 경유 연동은 아직 불가**하다. Gateway 인증/allowlist·통합 문서, Moderation 전용 DB/설정·migration/JWKS를 준비하고 승인된 배포·문서 재생성을 완료해야 한다. 프론트에 내부 서비스 JWT나 X-User-Id 입력을 요구하지 않는다.

## 10. 다른 팀원에게 요청할 작업

- Gateway: 신규5개 작업 인증, 동적 DELETE, 사용자 신원 헤더 정제, Moderation 전용 audience, 수집/공개 Swagger 변환 및 테스트.
- Post: 단건 신고 대상 검증/Moderation 서비스 인증 계약. 현재 bounded 공개 읽기 제한 개선.
- 인프라: Moderation 전용 PostgreSQL/TLS/backup/PITR/migration/Secret/JWK, Redis ACL·관측, 승인된 배포.
- 제품/보안: 감사·설명/사용자 ID 보존·익명화, abuse rate limit, 필요 시 최신 계정 상태 확인.
- 소비 서비스: 공식 이벤트별 Group/중복 방지/Pending/DLQ와 관계 재동기화 계약. 아직 소비자 구현 없음.

## 11. 변경 파일

- `services/moderation-service/.env.example`
- `services/moderation-service/Dockerfile`
- `services/moderation-service/README.md`
- `services/moderation-service/REPORTS_BLOCKS_IMPLEMENTATION_REPORT.md`
- `services/moderation-service/compose.yaml`
- `services/moderation-service/contracts/gateway-handoff.md`
- `services/moderation-service/contracts/report-events.schema.json`
- `services/moderation-service/contracts/reports.md`
- `services/moderation-service/migrations/001-reports.sql`
- `services/moderation-service/package.json`
- `services/moderation-service/pnpm-lock.yaml`
- `services/moderation-service/scripts/migrate-reports.mjs`
- `services/moderation-service/src/app.module.ts`
- `services/moderation-service/src/config/configuration.ts`
- `services/moderation-service/src/main.ts`
- `services/moderation-service/src/reports/gateway-auth.guard.ts`
- `services/moderation-service/src/reports/report-outbox.worker.ts`
- `services/moderation-service/src/reports/report-target.ts`
- `services/moderation-service/src/reports/report.dto.ts`
- `services/moderation-service/src/reports/report.store.ts`
- `services/moderation-service/src/reports/reports.controller.ts`
- `services/moderation-service/src/reports/reports.module.ts`
- `services/moderation-service/src/reports/reports.service.ts`
- `services/moderation-service/src/swagger.ts`
- `services/moderation-service/test/integration/reports.integration.ts`
- `services/moderation-service/test/report-openapi-auth.test.ts`
- `services/moderation-service/test/reports.test.ts`
- `services/user-service/README.md`
- `services/user-service/contracts/user-block-events.schema.json`
- `services/user-service/contracts/user-blocks.md`
- `services/user-service/src/http-auth/gateway-auth.guard.ts`
- `services/user-service/src/http.openapi.ts`
- `services/user-service/src/swagger.ts`
- `services/user-service/src/users/dto/user-block.dto.ts`
- `services/user-service/src/users/users.controller.ts`
- `services/user-service/src/users/users.service.ts`
- `services/user-service/test/gateway-auth.test.ts`
- `services/user-service/test/openapi.test.ts`
- `services/user-service/test/outbox.integration.test.ts`
- `services/user-service/test/users.integration.test.ts`
