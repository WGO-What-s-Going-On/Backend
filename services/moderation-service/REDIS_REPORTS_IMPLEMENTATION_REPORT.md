# Moderation 신고 Redis 전환 결과

기준: 2026-10-30, 로컬 브랜치 `feat/moderation-reports-redis`, 출발 커밋 `83a63f0`.
수정 범위는 Moderation과 Moderation의 CI 의존성 선언·회귀 테스트다. User/Post/Map/Notification/Gateway/WS의 소스는 수정하지 않았다. push, PR 생성·수정, merge, 배포, 운영 Secret 변경은 하지 않았다.

## 구현과 정합성

신고 원본과 이벤트 journal은 REDIS_URL의 같은 Redis에 저장한다. `report.store.ts`는 pg 대신 Redis를 사용하고 `report-script.ts`의 Lua에서 상태 변경과 기존 XADD를 함께 실행한다. PostgreSQL 의존성·lock 항목·연결 환경변수·migration 스크립트·신규 SQL·Compose reports-db profile을 제거했다. 기존 PostgreSQL 볼륨/테이블을 삭제하는 명령은 실행하지 않았다. User의 PostgreSQL·Outbox와 CI 의존성은 그대로다.

ReportOutboxWorker는 제거하지 않았다. Redis pending journal의 시작 시/1초 주기 복구를 담당하며 SSCAN cursor와 overflow buffer로 tick당 최대20개 신고를 처리한다. 여러 인스턴스의 동시 복구도 같은 Lua를 사용한다.

| 실패 지점 | 저장 결과 | 복구/호환성 |
| --- | --- | --- |
| 키 타입 검증/상태 기록 이전 | 신고 전이·이벤트 없음 | 503, 기존 값 보존 |
| pending 등록 후 canonical HSET 이전 | 미커밋 queue 항목만 존재 | Worker가 해당 항목만 정리, 정상 재요청 가능 |
| canonical HSET 이후 XADD 이전 | 원본+정확한 eventId/payload가 journal에 함께 남음 | 요청503, Worker가 클라이언트 재요청 없이 발행 |
| XADD 이후 확인 HSET 이전 | Stream에는 이벤트, journal에는 미확인 상태 | 같은 eventId로 at-least-once 재전달 가능; 후행 취소는 선행 확인 후 발행 |
| 확인 HSET 이후 queue 정리 이전 | 발행 receipt가 원본에 저장됨 | Worker는 재발행 없이 pending만 정리 |
| 모든 실행 성공 후 응답만 유실 | 원본·발행 확인 완료 | 재요청은 최초 결과, 추가 이벤트 없음 |
| Redis 강제 종료/재시작 | 저장된 상태·journal·stream을 AOF에서 복원 | 미발행 취소 복구, 기존 UUID·payload·순서 유지 검증 |

records HASH의 canonical 값 안에 신고와 최대2개 생성/취소 이벤트를 함께 저장한다. 생성 시 역조회 ID와 canonical 값을 한 HSET으로 쓴다. pending SET은 그 전에 등록하므로 Lua의 부분 오류로 커밋된 작업이 복구 대상에서 빠지지 않게 한다. TTL/자동 trim/원본 삭제는 없다. 이미 발행 확인한 선행 이벤트는 이후 취소 복구에서 다시 발행하지 않는다. 서로 다른 신고 사이의 전체 순서는 계약하지 않는다.

## 이벤트 종류별 호환성

아래는 기본 Stream 이름이다. 기존 환경변수 override도 유지한다. 신고 transport의 `eventId/eventType/data`, data 안의 `eventId/eventType/schemaVersion/producer/occurredAt/data`, UUID 형식과 최초 발생 시각을 유지했다. REPORT_CREATED의 reason, REPORT_WITHDRAWN의 withdrawnAt 및 COMMENT일 때의 commentId를 유지하며 description은 이벤트에 넣지 않는다.

| 이벤트/레코드 | 생산자 | Stream | 발행 조건 | 변경 전후 |
| --- | --- | --- | --- | --- |
| REPORT_CREATED | moderation-service / ReportsService | moderation:report-events | 신규 신고 생성 전이 | 동일 v1 envelope·UUID·payload; SQL Outbox→동일 Redis Lua+복구 journal |
| REPORT_WITHDRAWN | moderation-service / ReportsService | moderation:report-events | 본인 PENDING→WITHDRAWN 전이 | 동일 계약; 중복 취소는 새 이벤트 없음; 같은 신고의 생성보다 뒤에 발행 |
| BOARD_STALE | moderation-service / LifecycleService | moderation:events | 활동 부족 또는 ENDED 조건으로 ACTIVE→STALE | 생산·발행 코드/계약 변경 없음 |
| BOARD_REACTIVATED | moderation-service / LifecycleService | moderation:events | 의미 있는 활동 또는 ENDED 조건 해소로 STALE→ACTIVE | 변경 없음 |
| BOARD_CLOSED | moderation-service / LifecycleService | moderation:events | STALE 유예 10분 경과 후 CLOSED 전이 | 변경 없음 |
| CONTENT_MODERATION_EVALUATED | moderation-service / RedisModerationResultRepository | moderation:content-events | 처리 가능한 댓글 AI 평가 성공; flagged true/false 모두 | 변경 없음; 기존 결정적 eventId·재발행/receipt 유지 |
| 입력 처리 실패 DLQ 레코드 | moderation-service / PostEventConsumer | moderation:post:dead | Invalid 입력 또는 처리 실패 수신 횟수5회 이상 | 기존 DLQ payload·XACK 순서 변경 없음 |

다음 Post 이벤트 소비도 그대로 유지한다. 생산자는 모두 post-service, 입력 Stream은 post:events, Moderation Consumer Group은 post-moderation(override 가능)이다.

| 입력 이벤트 | 기존 처리/소비 조건 | 변경 전후 |
| --- | --- | --- |
| PostCreated | 게시판 Lifecycle 초기화 | 변경 없음 |
| PostCommentCreated | 유효한 댓글 검사·활동 반영 | 변경 없음 |
| PostCommentDeleted | 댓글 삭제/version fence 반영 | 변경 없음 |
| PostReactionCreated | 반응·활동/종료 판단 반영 | 변경 없음 |
| PostReactionRemoved | 반응 제거/version 반영 | 변경 없음 |
| PostParticipantJoined | 기존 no-op 처리 후 소비 완료 | 변경 없음 |
| PostParticipantLeft | 기존 no-op 처리 후 소비 완료 | 변경 없음 |
| PostDeleted | 원본 삭제 상태 반영 | 변경 없음 |
| PostExpired | 원본 만료 상태 반영 | 변경 없음 |

기존 Lifecycle·AI·Post 이벤트 source 파일이 HEAD와 동일함을 diff로 확인했다. 새 신고 컨슈머를 추가하거나 기존 Group·PEL을 재설정하지 않는다.

## API·기존 데이터

- POST /api/v1/moderation/reports: 동일 본문·201 ReportResponse. DELETE /api/v1/moderation/reports/{reportId}: 동일200 ReportResponse.
- ES256 Gateway 인증, 서명 userId 대조, 본인 취소·중복 신고·취소 정책·enum·Swagger DTO를 유지했다. 503 설명의 database 표현만 Redis storage로 갱신했다.
- 기존 moderation:report:<hash>와 다른 Stream/Group/PEL은 변경하지 않는다. 기존 report-events 메시지·ID·Consumer Group·Pending 항목을 남긴 채 새 신고를 발행하는 회귀 검증을 추가했다.
- 신고 원본은 새 moderation:reports:v1 namespace를 사용한다. 과거 hash reportId 데이터 또는 기존 PostgreSQL 행의 자동 이관은 하지 않는다. 실제 PostgreSQL 데이터가 있다면 배포 전에 별도 이관을 검토해야 하며 reportId/eventId/payload/발행 이력을 보존해야 한다.

## 로컬 검증

Node24.13.0 / pnpm10.33.0, 이번 작업이 생성한 `wgo-report-redis-test-20261030` 컨테이너의 Redis8만 사용했다. AOF=yes, appendfsync=always, maxmemory-policy=noeviction. 기존 로컬/운영 Redis나 DB를 테스트에 사용하지 않았다. 신고 테스트는 비어 있는 DB만 허용하며 자신이 만든 키만 정리하고 FLUSHDB/FLUSHALL을 호출하지 않는다.

| 검증 | 결과 |
| --- | --- |
| pnpm test | 64 통과 |
| pnpm test:integration + MODERATION_REPORT_RESTART_CONTAINER | 69 통과, 기존 Compose restart opt-in 1 skip |
| 위 suite 중 신고 Redis 테스트 | 19 통과, AOF 강제 종료/재시작 포함 |
| pnpm typecheck / pnpm build | 통과 |
| frozen lockfile 검사 (lockfile-only, offline) | 통과, pg/@types/pg lock 항목 제거 |
| Linux node24 CI dependency mock 테스트 | 4 통과; Moderation만 Redis 의존성으로 변경 |
| 빌드된 실제 AppModule 시작·HTTP guard·OpenAPI | PostgreSQL 없이 부팅; /health/live200, 무인증 신고401 |
| 이전 실제 Moderation OpenAPI와 비교 | 신고 생성/취소 operation·DTO 동일(503 설명 문구만 변경) |
| 실제 User+Moderation Gateway OpenAPI 병합·형식 검증 | 통과; Gateway 소스 수정 없음 |
| 루트 npm run format / git diff --check | 실행·무관한 포맷 복원 / 통과 |

신고 테스트는 다중 인스턴스 경쟁, 소유권, 중복 요청의 이벤트 없음, 원본·설명 보존, REVIEWED 취소 거부, key wrong type, Lua 상태 전/후·XADD 후·발행 확인 후 오류, 응답 유실, 복구 batch overflow, Redis 미설정·연결 실패, 기존 Stream/PEL 보존, 실제 인증 HTTP/OpenAPI 및 강제 종료 복구를 다룬다. Lifecycle/AI 회귀는 실제 Redis와 테스트 provider로 검증했고 외부 OpenAI 유료 호출은 하지 않았다.

## 남은 운영 조건

Redis 장애 중 신고 접수는503이며, 서버에서 전이가 끝나고 응답이 실패한 경우 원본/journal이 남을 수 있다. 임의 TTL을 붙이지 않으며 noeviction에 준하는 원본 보호, persistence/backup/복구·보존 정책과 관측이 필요하다. 앱은 공용 Redis의 CONFIG를 수정하지 않는다.

Lua는 디스크 영속성을 보장하지 않는다. Redis 원본·journal·Stream이 함께 영구 유실되면 독립 PostgreSQL Outbox에서 복구하던 능력은 없다. 로컬 AOF 강제 종료 통과는 운영 ElastiCache failover/RPO 검증이 아니다. 현재 cluster-mode-disabled 연결을 전제로 한다.

Moderation→Post 대상 검증의 운영 서비스 인증 계약은 기존 후속 작업으로 남겨 두었다. 저장소 전환으로 이 권한 문제를 우회하지 않았으며 운영 신고 접수가 완료됐다고 주장하지 않는다.
