# 사용자 차단·Redis 신고 최신 dev 통합 및 검증

2026-11-01 로컬 검증 결과. **로컬 통합은 완료했으나 운영 신규 신고 접수는 Post 인증 계약 미지원으로 배포 차단 상태**다. 테스트 대상 확인 성공 어댑터와 실제 Post 연동을 구분한다.

## 1. 작업 브랜치와 기준

- 새 브랜치: `feat/blocks-reports-redis-dev`.
- `git fetch origin` 성공 후 기준: `origin/dev` = `77691c92e41ade61da037cf93549f14a6078a147`.
- 원본 Redis 신고: `feat/moderation-reports-redis` = `24cce65d064b2b557d40356672dfc5bf611a3e61`.
- 공통 조상: `9176d57f1c2ab7ad6b34fa204217dd97b7c4b791`.
- 작업 시작 시 원본 작업 트리는 깨끗했다. 최신 dev 위에 필요한 변경만 선택 이식했으며 dev/main 및 원본 브랜치의 이력은 바꾸지 않았다.

## 2. 백업과 커밋

`backup/moderation-reports-redis-before-dev-integration-20261101`을 원본 `24cce65d064b2b557d40356672dfc5bf611a3e61`에 생성했다. 원본과 백업이 같은 SHA임을 재확인했다. 칭호·보상 브랜치는 이식·변경하지 않았다.

검증 후 이 문서를 포함해 `feat: integrate user blocks and Redis reports with latest dev`로 로컬 커밋한다. 최종 SHA는 작업 완료 응답과 `git log -1 --format=%H`에서 확인한다. 자기 자신의 SHA를 커밋 내용 안에 넣지는 않는다. push·PR 생성/수정·다른 브랜치 merge·배포·운영 Secret 변경은 수행하지 않는다.

## 3. 이식한 기능

- User: canonical POST/GET `/api/v1/users/me/blocks`, DELETE `/api/v1/users/me/blocks/{blockedUserId}`. 기존 PUT/DELETE body 경로를 같은 트랜잭션으로 연결했다.
- 기존 PostgreSQL `user_blocks`를 재사용한다. 사용자 행을 ID 순으로 잠가 관계 유무와 Outbox를 원자 커밋한다. 자기 차단·대상 상태·소유권·재시도 멱등성과 기존 숫자 cursor/새 owner-bound cursor를 유지한다. 신규 DB migration은 없다.
- Moderation: POST `/api/v1/moderation/reports`, DELETE `/api/v1/moderation/reports/{reportId}`. Redis 원본·journal·pending 복구를 최종 원본 브랜치에서 가져왔다. `pg`, PostgreSQL 신고 migration, SQL polling을 복원하지 않았다.
- ReportStore, reportScript, ReportOutboxWorker, report-events schema, User UsersService는 원본 `24cce65`와 줄바꿈 정규화 후 내용이 동일하다. 단순 구현 코드만 옮기고 복구 경로를 빠뜨리지 않았다.

## 4. 충돌 원인과 처리

오래된 기능 브랜치와 최신 dev는 GCP/Cloud SQL 연결 및 User readiness 인증 예외에서 갈라졌다. 전체 파일 덮어쓰기·일괄 cherry-pick 대신 기능 diff를 파일별 적용했다.

User guard에는 POST/동적 DELETE 허용만 더하고 dev의 unauthenticated GET `/health/ready` 예외를 유지했다. 충돌한 User 인증 테스트와 README는 최신 dev 위에서 필요한 항목만 추가했다. 원본의 불필요한 Dockerfile `COPY migrations`는 가져오지 않았다. PostgreSQL 신고 전용 설정과 예전 AWS 운영 설정은 복원하지 않았다. 오래된 PostgreSQL 구현 보고서는 가져오지 않고 이 문서로 현재 사실을 기록한다.

## 5. User 검증

실제 전용 PostgreSQL에서 전체 회귀 254 통과, 1 skip. 기존 인증·프로필·약관·탈퇴·gRPC·Outbox·Cloud SQL 설정 검증을 포함한다. skip은 별도 WS Gateway까지 필요로 하는 `RUN_GATEWAY_INTEGRATION` opt-in 테스트다.

차단 canonical/호환 API 혼합 재시도, 신규 생성·중복·해제·중복 해제, 자기/미존재/탈퇴 대상·비활성 요청자, owner 격리와 cursor continuation, 동시 혼합 명령, 양방향 동시 차단, 정확한 Outbox payload를 검사했다. 생성 실패는 기존 trigger 주입 테스트, 해제 실패는 추가 CHECK 제약 주입 테스트로 관계와 Outbox의 동시 롤백을 확인했다. Supertest는 app.listen으로 공유 서버를 유지해 동시 요청의 임시 서버 종료 경쟁을 제거한다.

Outbox 실제 Redis Streams 테스트에 USER_BLOCK_CREATED/REMOVED를 포함하며 기존 eventId/eventType/data 및 envelope를 그대로 전달한다. 소비 서비스의 차단 정책 적용 Consumer는 이 작업 범위가 아니다.

## 6. Redis 신고·장애 검증

단위·HTTP·OpenAPI 64 통과. 실제 Redis 통합 70 통과, 1 skip. 70개 중 신고 suite는 20개이며 나머지는 Lifecycle/AI/Consumer 회귀다. skip은 기존 Compose 전용 재시작 테스트이며 신고용 강제 종료 재시작은 실제 실행·통과했다.

검증 범위: 게시글·댓글 원본/설명 보존, 상태·소유권·검토 완료 취소 거부, 중복 생성·취소와 다중 인스턴스 경쟁, 키 타입 오류, canonical 기록 전/후 Lua 오류, XADD 후 receipt 실패, 응답 유실, Worker 자동 복구·batch overflow, 원본·eventId·payload·발생 시각·순서 보존, 기존 키·Stream·Consumer Group·PEL 보존. 전용 Redis의 AOF always를 확인한 후 KILL/start하고 미발행 취소를 journal에서 복구했다.

Redis에는 `moderation:reports:v1:records` HASH의 target:digest 필드에 `{format,stream,report,events}`, id:reportId 필드에 digest를 저장하고 `moderation:reports:v1:pending` SET에 복구 대상을 둔다. 기존 데이터 초기화·자동 이관·TTL·Stream trim은 추가하지 않는다. 별도 인스턴스가 아니라 같은 REDIS_URL의 원본/journal/Stream을 Lua에서 처리한다.

## 7. 이벤트·복구·호환성

비교 기준은 Redis 최종 원본 `24cce65`. User 차단 이벤트는 기존 dev의 단순 관계 쓰기에 새로 추가되지만 원본 기능 브랜치의 계약은 그대로다.

| 종류 | 생산자 | Stream | 발행 조건 | 통합 후 호환성 |
| --- | --- | --- | --- | --- |
| USER_BLOCK_CREATED | User changeBlock + 기존 PG OutboxWorker | user:events | 관계가 없을 때 생성 커밋 | 기존 type/version/payload envelope·UUID 유지, 중복 생성은 이벤트 없음 |
| USER_BLOCK_REMOVED | User changeBlock + 기존 PG OutboxWorker | user:events | 있던 관계 해제 커밋 | 동일 계약, 중복 해제 이벤트 없음. 다중 Worker 전체 순서는 보장하지 않음 |
| REPORT_CREATED | ReportsService + Redis Lua/복구 Worker | moderation:report-events | 최초 신고 원본 전이 | eventId/eventType/data 필드, v1 envelope·UUID·payload·발생 시각 동일 |
| REPORT_WITHDRAWN | ReportsService + Redis Lua/복구 Worker | moderation:report-events | 본인 PENDING→WITHDRAWN | 최초 취소 시각 유지, 중복 이벤트 없음. 같은 신고의 생성 발행 확인 후 취소 발행 |
| BOARD_STALE | LifecycleService | moderation:events | ACTIVE→STALE (활동 부족/ENDED) | 최신 dev 소스·조건·payload 변경 없음 |
| BOARD_REACTIVATED | LifecycleService | moderation:events | STALE→ACTIVE | 변경 없음 |
| BOARD_CLOSED | LifecycleService | moderation:events | STALE 유예 종료→CLOSED | dev의 종료 이벤트 연동 수정 포함, 변경 없음 |
| CONTENT_MODERATION_EVALUATED | RedisModerationResultRepository | moderation:content-events | 댓글 AI 평가 성공, flagged 양쪽 | 결정적 eventId·receipt·재발행 계약 변경 없음 |
| 입력 처리 실패 DLQ | PostEventConsumer | moderation:post:dead | 기존 invalid/최대 재시도 조건 | payload·ACK 순서 변경 없음 |

PostCreated/PostCommentCreated/PostCommentDeleted/PostReactionCreated/PostReactionRemoved/PostParticipantJoined/PostParticipantLeft/PostDeleted/PostExpired 소비와 post-moderation Group·Pending 회수·ACK·DLQ 코드는 origin/dev와 동일하다.

Lua는 실패 시 롤백되지 않는다. pending 등록 후 canonical HSET 전에 실패하면 무해한 queue만 정리한다. HSET 후 XADD 전 실패하면 원본과 journal의 동일 eventId로 Worker가 복구한다. XADD 후 receipt 전 실패는 같은 eventId의 at-least-once 중복이 가능하다. 선행 receipt를 저장하기 전에는 후행 취소를 발행하지 않는다. 이미 확인한 이벤트는 재발행하지 않는다. 응답만 유실된 성공 재시도는 저장된 최초 결과를 돌려준다. 소비자는 eventId 기반 영속 멱등성을 가져야 한다.

## 8. Gateway·GCP 호환

Gateway의 기존 JWT 검증은 재작성하지 않고 User POST/동적 DELETE allowlist만 확장했다. 외부 X-User-Id 제거·검증 사용자 재작성, 서비스별 ES256 audience, Moderation 서명 userId 대조, User 최종 인증, 보호 경로 Swagger를 검증했다.

추가 로컬 smoke에서 빌드한 실제 Gateway → 두 실제 Controller/guard → PostgreSQL·Redis를 연결했다. 위조 헤더 999가 실제 인증 사용자 1로 바뀌며, canonical/호환 차단과 Outbox 2건, 신고 생성/취소 멱등성과 Stream 2건, 실제 두 서비스 Swagger 병합·검증을 확인했다. 신고 성공은 명시적인 테스트 대상 확인 어댑터를 사용했다. 실제 ReportTarget은 503이며 Redis 쓰기가 전혀 없음을 확인했다.

User config/database/package/lockfile, Notification 전체, GKE deploy/Cloud SQL proxy/TLS 구성, Moderation Dockerfile 및 Lifecycle/AI/Consumer는 origin/dev 대비 diff 없음. GKE runtime.cjs의 Secret 주입·CA/TLS, GCP Redis AOF always/noeviction/PVC/백업을 유지한다. User·Notification PostgreSQL은 계속 필요하다. Moderation에 PostgreSQL은 필요하지 않다.

## 9. 실제 검증 집계

Node24.13.0 / pnpm10.33.0. 각 서비스 frozen lockfile·offline 설치 성공. User/Gateway lockfile은 dev와 동일하며 Moderation에는 jose만 추가되고 pg는 없다. lint 스크립트는 세 패키지에 정의되어 있지 않아 별도 lint 성공을 주장하지 않는다.

| 명령/검증 | 통과 | 실패 | 미실행/skip |
| --- | ---: | ---: | ---: |
| User pnpm test | 254 | 0 | 1 (WS 포함 opt-in) |
| Moderation pnpm test --maxWorkers=1 | 64 | 0 | 0 |
| Moderation pnpm test:integration + 신고 restart opt-in | 70 | 0 | 1 (기존 Compose 전용) |
| Gateway pnpm test | 74 | 0 | 2 (아래에서 별도 실행) |
| Gateway RUN_INTEGRATION=1 location-rate.integration | 2 | 0 | 0 |
| CI 의존성·GCP/GKE Linux 테스트 | 24 | 0 | 0 |
| CI git 비교 호스트 테스트 | 17 | 0 | 0 |
| User/Moderation/Gateway typecheck 및 build | 모두 성공 | 0 | 0 |
| 실제 Gateway→서비스·저장소·Swagger smoke | 성공 | 0 | 0 |
| 루트 npm run format, 변경 파일 Prettier check, git diff --check | 성공 | 0 | 0 |

중복 집계 없이 **505 통과, 최종 미실행 2개**(User WS opt-in 및 Moderation Compose restart)다. Gateway 기본 skip 2개는 별도 실행으로 해소했다. 로그는 저장소 밖 `.runtime/blocks-reports-*.log`에 두고 커밋하지 않는다.

초기 병렬 실행은 로컬 의존성 설치와 겹쳐 Moderation health 준비 hook 1개가 timeout됐으나 최종 실행에서 64/64로 통과했다. 최소 Linux 이미지에 git이 없어 CI 비교 테스트 5개가 ENOENT로 실패한 초기 실행은 git이 있는 호스트 17/17 및 Linux 24/24로 분리 재검증했다. 소스 assertion을 약화하거나 실패를 skip으로 바꾸지 않았다.

## 10. 운영 차단 사항과 한계

**Moderation→Post 인증 대상 확인 미지원**: origin/dev Post 내부 detail/comments는 WS 전용 ES256 caller만 허용한다. Moderation용 읽기 권한·issuer/subject·공개 키 신뢰 계약이 없으므로 ReportTarget은 네트워크를 호출하지 않고 신규 신고를 503으로 거부한다. URL 설정만으로 열리지 않는다. 기존 신고 재요청/본인 취소/미발행 복구는 유지한다. Post 수정·WS 키 공유·무인증 fallback은 하지 않았다.

운영 접수 전 최소 계약: Moderation 전용 서비스 인증/신뢰 등록, 부모 ACTIVE/미만료와 댓글 ID·부모·ACTIVE 확인 응답, 404/401/503·timeout 정책, 실제 인증 연동 검증. 상세는 contracts/gateway-handoff.md에 기록했다.

Redis 원본·journal·Stream이 함께 영구 유실되면 독립 PG에서 복구할 수 없다. 로컬 AOF 재시작은 운영 장애·backup restore·RPO 검증이 아니다. noeviction·용량·백업·보존/익명화 정책이 필요하며 Redis Cluster 다중 hash slot은 지원하지 않는다. 기존 legacy 신고 키/과거 PG 데이터는 자동 이관하지 않았다. dev의 targetId/자유문자열 사유 클라이언트는 postId/commentId·enum 계약으로 전환해야 한다.

운영 DB/Redis/GKE·유료 OpenAI에는 접근하지 않았다. 새 로컬 컨테이너 4개만 사용했고 테스트가 만든 임시 DB와 키를 정리했다. 컨테이너는 검증 후 정지하며 기존 컨테이너·볼륨은 삭제하지 않는다.

## 11. 최종 diff 검토 및 파일 목록

origin/dev의 직접 자손 브랜치이며 전체 서비스 파일을 과거 버전으로 되돌리지 않았다. 차단·신고·Gateway·계약·필수 회귀만 변경했다. 원본/백업 SHA 불변, PostgreSQL 신고 의존성 부재, Lua/journal/Worker 연결, 실제 Gateway 호출, dev readiness 예외, 기존 GCP/Cloud SQL과 Lifecycle/AI 보존을 확인했다. 루트 포맷의 무관한 파일 247개는 원래 바이트로 복원했다.

아래는 origin/dev 대비 커밋 대상 파일 목록이다. 기존 reports.ts/gateway-auth.ts는 우회 가능한 중복 구현을 제거하고 단일 ReportsModule로 교체하므로 삭제 항목이다. 로컬 커밋 후 git status는 깨끗한 상태로 확인한다.

```text
ARCHITECTURE.md
docs/contracts/frontend-integration.md
gateways/http-gateway/README.md
gateways/http-gateway/src/openapi.ts
gateways/http-gateway/src/user-auth.ts
gateways/http-gateway/test/openapi.test.ts
gateways/http-gateway/test/user-auth.test.ts
scripts/ci-dependencies.test.mjs
services/moderation-service/.env.example
services/moderation-service/README.md
services/moderation-service/REDIS_REPORTS_IMPLEMENTATION_REPORT.md
services/moderation-service/contracts/gateway-handoff.md
services/moderation-service/contracts/report-events.schema.json
services/moderation-service/contracts/reports.md
services/moderation-service/package.json
services/moderation-service/pnpm-lock.yaml
services/moderation-service/src/app.module.ts
services/moderation-service/src/config/configuration.ts
services/moderation-service/src/gateway-auth.ts
services/moderation-service/src/main.ts
services/moderation-service/src/reports.ts
services/moderation-service/src/reports/gateway-auth.guard.ts
services/moderation-service/src/reports/report-outbox.worker.ts
services/moderation-service/src/reports/report-script.ts
services/moderation-service/src/reports/report-target.ts
services/moderation-service/src/reports/report.dto.ts
services/moderation-service/src/reports/report.store.ts
services/moderation-service/src/reports/reports.controller.ts
services/moderation-service/src/reports/reports.module.ts
services/moderation-service/src/reports/reports.service.ts
services/moderation-service/src/swagger.ts
services/moderation-service/test/frontend-auth.test.ts
services/moderation-service/test/integration/reports.integration.ts
services/moderation-service/test/report-openapi-auth.test.ts
services/moderation-service/test/reports.test.ts
services/user-service/README.md
services/user-service/contracts/user-block-events.schema.json
services/user-service/contracts/user-blocks.md
services/user-service/src/http-auth/gateway-auth.guard.ts
services/user-service/src/http.openapi.ts
services/user-service/src/swagger.ts
services/user-service/src/users/dto/user-block.dto.ts
services/user-service/src/users/users.controller.ts
services/user-service/src/users/users.service.ts
services/user-service/test/gateway-auth.test.ts
services/user-service/test/openapi.test.ts
services/user-service/test/outbox.integration.test.ts
services/user-service/test/users.integration.test.ts
```

## 12. PR #70 대체 준비 여부

최신 dev 기반 로컬 대체 브랜치·검증·커밋은 준비 완료다. 기존 PR #70의 PostgreSQL 신고 구현을 그대로 merge하지 않는다. push나 PR 변경은 하지 않았다. **운영 신고 접수 활성화는 준비 완료가 아니며 Post 대상 인증 계약 해결이 선행되어야 한다.** 이 제한을 명시한 구현 검토용 대체 PR의 근거로 사용할 수 있다.
