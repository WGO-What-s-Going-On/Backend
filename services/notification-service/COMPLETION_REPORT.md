# Notification Service 완료 보고서

2026-11-04, 브랜치 `feat/notification-user-events`, 시작 기준 `cd8e9e9`. 구현과 로컬 통합 검증을 완료했다. 실제 GCP/PWA 검증은 수행하지 않았다. 원격 push·PR·dev merge·배포·운영 Secret 변경·운영 DB/Redis 초기화는 하지 않았다.

## 1. 서비스별 기능 현황

[전체 매트릭스](NOTIFICATION_MATRIX.md)의 기존 댓글/게시글 공감·2분 묶음·PostgreSQL 원본·FCM 재시도·unread·기존 API를 보존했다. 답글, 댓글 공감, 투표 후보/승리, User 칭호/레벨, Moderation lifecycle/신고 접수·취소/확정 콘텐츠 삭제를 연결했다. User의 wgo-titles-v2 칭호·지역 랭킹 정책·보상 원장과 계산은 변경하지 않았다. Map의 GEO는 게시글 후보이며 수신 동의가 아니므로 사용자 위치를 추정하지 않고 Notification 소유의 별도 구독을 구현했다.

## 2. Consumer와 계약

| Stream | Group | 파싱/권위 |
| --- | --- | --- |
| post:events | post-notification 유지 | Post eventType/schemaVersion, 실제 적용된 활동·상태 |
| user:events | user-notification | User type/version/target/payload |
| moderation:events | moderation-notification | 버전 있는 lifecycle 판단 |
| moderation:report-events | moderation-report-notification | 신고 접수/취소 data |
| moderation:content-events | moderation-content-notification | AI 관찰 receipt만 |

공통 DurableStreamConsumer로 입력 검증·Pending 회수·재연결·DLQ를 통합했다. Post는 같은 MongoDB 트랜잭션에서 부모를 검증/fence하고 parentCommentAuthorId를 추가한다. Moderation은 실제 projection.version 및 기존 staleAt+10분 예정 시각을 선택 필드로 발행한다. User는 Notification 전용 ES256의 양방향 차단 읽기 API를, Post는 Moderation 전용 ES256의 대상 존재/부모/상태 읽기 API를 추가했다. 사용자 헤더나 다른 서비스 키를 신뢰하는 우회는 없다. [이벤트 계약](EVENT_CONTRACTS.md), [User 차단 계약](../user-service/contracts/user-blocks.md), [신고 대상 계약](../moderation-service/contracts/reports.md)을 참조한다.

## 3. 수신자·알림함·FCM 정책

| 유형 | 수신자 | 알림함 | Push |
| --- | --- | --- | --- |
| 댓글/게시글 공감 | 게시글 작성자, 본인 행동 제외 | O | O |
| 답글 | 확인된 부모 작성자와 게시글 작성자, 같은 수신자 중복 제거 | O | O |
| 댓글 공감 | 댓글 작성자, 본인 행동 제외 | O | O |
| 투표 후보/승리 | 실제 후보/승리 댓글 작성자, 별도 사실 | O | O |
| 칭호 획득/레벨 UP | 해당 사용자, 성과 자기제외 없음 | O | O |
| 칭호 회수/레벨 DOWN | 해당 사용자 | O | X |
| INITIAL/크레딧/AI 평가 | 대상 알림 생성 안 함 | X | X |
| STALE/재활성화 | 확인된 게시글 작성자만 | O | O, 지난 경고는 X |
| 실제 종료/수동 재열림 | Post의 실제 전이로 확인한 작성자 | O | O |
| 신고 접수/취소 | 신고자 본인 | O | X |
| 확정 콘텐츠 삭제 | 실제 삭제 적용된 작성자 | O | O |
| 주변 새 글 | 별도 opt-in·위치 동의·최대15분 위치·150m·인가 통과 사용자 | O | O, 기본 OFF |

각 종류 설정 false는 새 알림함과 Push를 함께 억제하며 실제 게시글이 있으면 mute도 적용한다. Push 직전에 설정/차단/구독 상태를 재검증한다. 후보는 게시글·사용자당 한 제품 알림으로 묶되 댓글별 fact는 별도 보존한다. 두 후보 중 하나가 삭제되어도 다른 유효 후보가 남으면 유지한다. 승리/무승부/무효를 추정하지 않는다. User 지역 이름/rank/score/run은 실제 payload만 보존한다. 링크·묶음·취소 세부 사항은 이벤트 계약에 명시했다. 내부 인가용 사용자 ID와 위치 revision은 FCM에 직렬화하지 않으며 주변 알림함의 actor도 null이다.

## 4. 완료 범위와 차단 항목

- **구현·로컬 통합 검증 완료:** 매트릭스의 기존/신규 알림과 API, 차단 조회/신고 대상 인증, 영속 fanout, 장애 복구. 주변 알림 코드는 검증했지만 운영 기본 OFF다.
- **외부 계약 선행 필요 — 신고 결과:** Moderation에 REVIEWED enum은 있지만 승인된 관리자 인증/검토 명령/감사 기록/조치 완료 생산자가 없다. 권한 있는 검토 상태 전이와 원자적 journal/Outbox, reportId·신고자·확정 결정·실제 조치 완료를 담는 계약이 필요하다. 접수/취소 또는 AI flagged로 결과를 대체하지 않았다.
- **외부 계약 선행 필요 — 사용자 WS Notification:** WS Gateway의 사용자별 Notification 채널·인가·재연결 계약이 없다. REST/FCM으로 제공하며 공개 room broadcast를 추가하지 않았다.
- **운영 활성화 선행:** 위치 동의 UI·실제 사용자 위치 권한, 별도 서비스 키/URL, GCP 권한·실기기 검증. 프런트 저장소는 수정하지 않았다.

## 5. PostgreSQL migration과 보존

v1 테이블을 유지하고 v2에 stream-scoped Inbox/업무 키/시작점, 실제 post FK가 선택적인 공통 delivery scope를 추가했다. v3는 댓글·상태 projection 보강, v4는 위치 구독/빈도 제한/영속 fanout이다. User/신고 delivery에 가짜 Post ID를 만들지 않는다. 기존 rows/read/preferences/token/marker/delivery가 채워진 v1 layout을 재구성해 실제 migration을 두 번 실행하고 보존·멱등성을 검증했다. 앱 자동 DDL 없이 별도 db:migrate Job을 사용한다. 운영 대용량 PK 변경의 잠금 시간은 별도 검증 대상이다.

## 6. 중복·역순·장애 복구

PostgreSQL transaction에 Inbox·알림·업무 키·delivery를 함께 기록한 뒤 XACK한다. stream과 eventId 복합 키, 같은 Post/event ID 직렬화, post 행 잠금, activityVersion/tombstone, lifecycle/postVersion, 변경 불가능한 작성자 문맥 검증을 사용한다. unknown/억제된 정상 사건도 receipt를 남긴다. ACK 장애는 poison 입력으로 DLQ하지 않으며 DLQ 저장과 ACK는 원자적 Redis Lua다. 부분 FCM 성공은 성공 token을 재전송하지 않고 실패 token만 재시도한다. 60초 lease와 lease ID 완료 fencing으로 다중 worker를 제어한다.

새 그룹 cutoff와 기존 그룹 PEL을 보존하며, 기존 Post의 과거 미지원 유형에는 별도 기능 도입 경계를 고정해 복구 중 과거 알림이 새로 발송되지 않게 한다. 재처리 CLI는 원본 eventId를 유지하고 DLQ를 삭제하지 않는다. 실제 외부 FCM 전송의 exactly-once는 주장하지 않는다. 알림은30일 논리 TTL/1000행 정리, 위치는 최대15분 유효/1분 주기 bounded cleanup이다. [운영 절차](OPERATIONS.md)에 배포·복구·한계를 명시했다.

## 7. 검증 결과와 재현

Node24/pnpm10, 전용 PostgreSQL18·Redis8·MongoDB8 replica set, mock FCM을 사용했다. 테스트 DB는 UUID schema/database로 분리하고 작업 소유 컨테이너에 별도 라벨을 붙였다. 기존 운영 데이터는 건드리지 않았다.

| 대상 | 결과 |
| --- | --- |
| Notification 단위 | 73 passed |
| Notification PostgreSQL/Redis 통합 | 79 passed, 재시작 opt-in 1개는 별도 실행 |
| 실제 Redis·PostgreSQL 컨테이너 재시작 | 별도 1 passed |
| User 전체 | 507 passed, 기존 별도 컨테이너 재시작 1 skipped |
| Post 전체, RUN_INTEGRATION=1 | 261 passed, 선택형 WS/모델/E2E 등24 skipped |
| 신규 실제 Post→Notification E2E | 별도1 passed. 위24 skipped 중 신규 E2E를 따로 활성화해 실행 |
| Moderation 단위 / 실제 Redis 통합 | 69 passed / 69 passed, 기존 별도 재시작2 skipped |
| HTTP Gateway 전체 및 실제 Notification 연동 | 89 passed, rate-limit 통합과 신규 E2E 포함 |
| User/Post/Notification/Moderation/HTTP Gateway | 각각 typecheck·build 통과 |
| 포맷·diff | 루트 npm run format 실행, 무관한 포맷 복원, git diff --check 확인 |

서버의 FCM 부분 응답/invalid token/lease/commit 전후 실패, ACK6회 장애, DLQ 원본 재처리, 기존/신규 그룹 시작점, v1 데이터 migration, 115명 fanout, 거리 경계, 소유자 격리, immutable 작성자 충돌을 검증했다. 실제 MongoDB 트랜잭션·Outbox가 발행한 Post 이벤트를 Redis와 Notification SQL까지 소비하고 User 실제 DB의 ES256 차단 조회와 Moderation→Post 실제 대상 검증을 연결했다. Gateway도 실제 Notification API/SQL/서명/Swagger를 연결했다. 실기기·외부 GCP 발송은 포함하지 않는다.

재현은 각 서비스의 `pnpm typecheck`, `pnpm build`, `pnpm test`, Notification/Moderation의 `pnpm test:integration`을 사용한다. Post 통합은 RUN_INTEGRATION=1이다. 신규 Post E2E는 Notification/User/Moderation을 먼저 build하고 `RUN_NOTIFICATION_E2E=1 pnpm test notification-e2e.integration.test.ts`, Gateway E2E는 Notification build 후 `RUN_NOTIFICATION_GATEWAY_E2E=1 pnpm test notification.integration.test.ts`다. loopback 전용 테스트 endpoint와 빈 테스트 Redis DB를 준비해야 한다. 재시작 테스트는 NOTIFICATION_RESTART_TEST=1과 해당 테스트 컨테이너 이름을 명시하며 이름/라벨을 검증한다. lint script가 없는 서비스에는 별도 lint 성공을 주장하지 않는다.

## 8. 기능 단위 커밋

| SHA | 메시지 / 범위 |
| --- | --- |
| aa25ae5 | feat(notification): integrate cross-service event consumers — 공통 Inbox/parser/Consumer |
| 2b98693 | feat(notification): complete post activity notifications — Post 확장·부모 문맥·User 차단 계약 |
| 95d1270 | feat(notification): deliver badge and level notifications — User 정책/전용 group |
| 1965532 | feat(notification): integrate lifecycle and moderation notifications — 판단/적용 분리·전용 인증 |
| 82e2684 | feat(notification): support nearby alerts and preferences — 명시적 동의·bounded fanout·API |
| 0db1910 | refactor(notification): unify durable notification delivery — 복구·재처리·비공개 문맥 |
| 본 보고서를 포함한 최종 커밋 | test(notification): verify cross-service notification integration — E2E·migration·복구 경계·문서. 최종 SHA는 전달 응답과 git log -7에 기록 |

## 9. 브랜치·작업 트리

`feat/notification-user-events`에서만 작업했다. 최종 커밋 후 `git status --short`와 `git ls-files --others --exclude-standard`가 비어 있는지 확인해 전달한다. 서비스의 실제 .env 파일은 편집하지 않았으며 예제와 문서에 새 변수만 추가했다. Windows 삭제 실패로 생긴 추적되지 않는 잔재를 일괄 삭제하지 않았다. 이 작업 소유 테스트 컨테이너만 라벨 확인 후 정리한다. 원격 동작은 실행하지 않는다.

## 10. GCP 배포 전 환경변수·권한

| 서비스 | 설정 |
| --- | --- |
| Notification | 기존 REDIS_URL, DB_CONNECTION_MODE/DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_TLS_MODE/DB_POOL_MAX 유지. 직접 연결은 비밀번호/verify-full, 자동 IAM Proxy는 loopback/비밀번호 없음 |
| Notification | FIREBASE_PROJECT_ID, 기존 ADC/Workload Identity. explicit Firebase client email/private key는 둘 다 없거나 둘 다 있어야 함 |
| Notification | NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS, NOTIFICATION_SERVICE_PRIVATE_JWK, NOTIFICATION_USER_BLOCKS_URL |
| User | USER_NOTIFICATION_TRUSTED_JWKS. 기존 Gateway trusted JWKS 유지 |
| Post | POST_MODERATION_TRUSTED_JWKS. 기존 HTTP/WS/Map 인증 유지 |
| Moderation | MODERATION_SERVICE_PRIVATE_JWK, MODERATION_POST_REPORT_TARGET_URL. 기존 Gateway trusted JWKS/Redis 원본 유지 |
| 기능 flag | NOTIFICATION_USER_EVENTS_ENABLED=true, NOTIFICATION_MODERATION_EVENTS_ENABLED=true, NEARBY_NOTIFICATIONS_ENABLED=false, NEARBY_MIN_INTERVAL_SECONDS=600 |

내부 URL은 코드에 명시한 읽기 전용 endpoint 전체 경로다. 서비스마다 별도 ES256 private JWK를 Secret 경로로 공급하고 상대 서비스에는 공개 JWKS만 등록한다. Firebase 대상 프로젝트에는 `roles/firebasecloudmessaging.admin` 등 필요한 발송 권한을 확인한다. [공식 FCM 역할](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)을 따른다. Cloud SQL Proxy GSA에는 `roles/cloudsql.client`/자동 IAM의 `roles/cloudsql.instanceUser`, IAM DB 사용자 등록 및 Notification DB 권한을 확인한다. [GKE 연결 문서](https://docs.cloud.google.com/sql/docs/postgres/connect-kubernetes-engine)를 따른다. Secret Manager를 사용하는 배포 주체의 secret 접근, Redis ACL/TLS, 서비스 간 네트워크도 배포 환경에서 검증한다. 키를 새로 발급하거나 실제 IAM 권한을 변경하지 않았다.

## 11. 안전한 배포 순서

백업/기존 group·PEL 기록 → 기존 worker drain → DB migration → **events:prepare로 시작점 고정** → 상대 공개키/읽기 권한 먼저 등록 → 새 Consumer와 readiness 검증 → Post/Moderation 생산자 선택 필드 확장 → 기능별 관측 후 활성화다. 준비 이후 생산된 이벤트는 group에 남는다. 위치 기능은 동의 UI·권한·차단 조회·실기기 확인 후 별도 ON한다. 기존 Stream/group/marker/history는 삭제·rewind하지 않는다. 상세 절차와 rollback 한계는 운영 문서에 있다.

## 12. 프런트엔드 PWA 실수신 절차

[PWA/FCM 인계](PWA_FCM_HANDOFF.md)에 HTTPS/VAPID/service worker/사용자 권한, 등록 token 계약, 포그라운드·백그라운드·닫힌 탭·iOS 홈 화면, 실제 원본 사건/기기 수신/클릭/알림함, notificationId 중복 표시 방지, 해제·차단·설정·위치 동의를 기록하는 절차를 제공했다. 이 작업에서는 실행하지 않았으며 token 등록 성공을 실수신 성공으로 보고하지 않는다.

## 13. 배포 후 지표·미검증

Stream lag, PEL oldest age/재전달 횟수, DLQ 증가, Inbox commit/DB lock·pool, delivery due age·lease 만료·FCM partial/invalid/permanent 결과, unread 원본-캐시, 위치 만료 cleanup backlog·fanout lag/페이지 크기·인가 실패·throttle를 관측한다. 실제 GKE 다중 Pod drain, Cloud SQL 대용량 migration/연결·IAM, Redis failover/RPO, 실제 Firebase 프로젝트 발송·PWA 기기 수신은 미검증이다. **구현 완료 / 로컬 통합 검증 완료 / 실제 GCP 미검증**을 구분한다.
