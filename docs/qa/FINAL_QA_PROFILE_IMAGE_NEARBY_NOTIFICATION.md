# 최종 QA — 프로필 이미지와 주변 새 게시글 알림

2026-11-17, Asia/Seoul. 운영에는 적용하지 않았다.

## 작업 기준과 보존 범위

- 별도 worktree `WGO/qa-final`, 브랜치 `fix/final-qa-profile-image-nearby-notification`.
- 기준은 로컬 보관 `origin/main`의 `a8d4480b3d197c69c06f1f3f6523c066fb2626f5`다.
  원격 Git 작업 금지에 따라 fetch/원격 최신 여부 재조회는 하지 않았다.
- 원래 `WGO/Backend`의 dev, 작업 트리 및 기존 커밋 이력은 그대로 둔다.
- push, PR, merge, 배포, 운영 데이터/객체/Secret/IAM/기능 플래그 변경, 실제 FCM은 실행하지 않았다.
  GCP/GKE 진단은 공개 설정·정책과 실제 Pod의 권한 실패를 읽기 전용으로 확인했다.
- 기준 main의 기존 파일을 Git 정규화 hash로 비교했다. Map **51개** 중 변경은 main.ts/store.ts뿐이며,
  User **149개 기존 파일은 모두 동일**하다. 신규 문서/코드/테스트는 별도 추가했다.

## 이슈 1: 프로필 이미지

원인은 운영 권한이다. 실제 User Pod의 SDK URL 서명은 `iam.serviceAccounts.signBlob` 거부,
진단용 미존재 객체 metadata GET은 HTTP 403 `storage.objects.get` 거부였다.
현재 공유 media 버킷 설정과 Workload Identity 계정 매핑은 맞다. CORS에는 운영 웹 Origin과 PUT이 있다.

User 코드를 재구현하거나 수정하지 않았다. 배포 프론트 번들의 업로드/complete/URL 경로와 로컬 프론트의
요청 계약도 확인했으며, 현재 근거로 프론트 오호출을 원인으로 단정하지 않는다.
최근 로그 범위에 실제 업로드 POST trace가 없으므로 실제 사용자의 브라우저 실패 요청을 추적했다고 주장하지 않는다.

- 변경 파일: `services/user-service/FINAL_QA_PROFILE_IMAGE_REPORT.md` 하나.
- 로컬 커밋: `0032bed` (`docs(user): diagnose final profile image QA IAM failures`).
- 세부 계약·53 통과/1 skip의 프로필 테스트·IAM 근거·승인 후 E2E 절차는
  [프로필 진단 보고서](../../services/user-service/FINAL_QA_PROFILE_IMAGE_REPORT.md)에 있다.
- User 전체 추가 회귀: Linux 로컬 PostgreSQL/Redis에서 **29개 파일, 542 통과·4 skip**.
  Gateway 산출물/선택 환경 변수 및 Redis 재시작 선택 테스트는 실행하지 않았다.
  Windows 전체 실행의 기존 지역 랭킹 테스트 5건 timeout은 코드/timeout 변경 없이 Linux에서 모두 통과했다.
  User typecheck/build도 통과했다.
- 운영 해결은 아직 아니다. 승인 후 User 자기 GSA의 최소 signBlob 권한과 공유 버킷 `user-profiles/`에
  한정한 create/get/delete 권한을 적용해야 한다. 버킷 env/CORS/Post 권한 변경은 현재 근거상 불필요하다.

## 이슈 2: 원인과 추가 구현

기존 Notification NearbyWorker는 자체 PostgreSQL 구독 좌표로 150m를 계산했으며 Map RPC를 호출하지 않았다.
또한 PostCreated에 이미 있는 실제 참가 반경을 보관/적용하지 않았다. Map에는 주변 사용자 목록 RPC가 없었다.
운영 Notification의 `NEARBY_NOTIFICATIONS_ENABLED`는 미설정(기본 OFF), 기존 Push 플래그는 true다.
배포 웹 `/assets/index-DRIPodCV.js`에는 주변 알림 별도 동의 계약의 `locationConsent`와 subscription 경로가 없다.

새 경로는 다음과 같다.

1. 기존 PostCreated 소비 transaction이 기존 job과 **신규 별도 정책 테이블**에 실제 참가 반경을 기록한다.
   기존 receipt/ACK 구조는 유지한다. ACK는 durable job 저장 이후이며 Map 호출 실패와 독립적으로 재처리 가능하다.
2. Notification이 기존 명시적 구독의 활성 ID/revision/만료만 Map의 새 RPC로 동기화한다.
   Map 위치 보유 자체로 수신 동의를 추정하지 않는다. 기존 구독의 TTL/좌표 필드/HTTP 계약은 보존한다.
3. Map이 기존 Cassandra/캐시의 최신 위치·이동 상태를 읽어 **별도 H3 파생 인덱스**를 준비한다.
   완성된 snapshot만 공개한다. 인덱스 미준비/유실/부분 손상/만료는 정상 empty와 구분한다.
4. Notification이 새 FindNearbyUsers gRPC를 호출한다. Map은 후보 최대 50명을 원본으로 다시 검증하고,
   기존 decide/distanceM 기준 `min(150m, 실제 참가 반경)`, 5분 최신성, 이동 제한을 적용한다.
5. Notification은 작성자·중복을 제외하고 현재 동의 revision, 기존 사용자/게시글 알림 설정,
   기존 User API의 양방향 차단·활성 상태 확인을 적용한다.
6. 기존 NotificationEventWriter, PostEventHandler, FirebasePushAdapter 및 delivery 재시도/멱등성을 재사용한다.
   댓글·공감·칭호·레벨·라이프사이클·신고 알림 처리 코드는 변경하지 않았다.
7. Map 장애는 작업/cursor를 성공 처리하지 않고 재시도한다. 기존 15분 위치 사용 기한은 연장하지 않고,
   그 기한을 넘긴 미완료 작업은 새 만료 로그로 드러낸다.

상세 RPC/인덱스/인증/복구/성능 한계는 [신규 Map 계약](../../services/map-service/contracts/map-notification.md)을 따른다.
기존 Map Proto 메시지/RPC, HTTP 응답·오류 코드·인증, 위치 검증, 이동 계산, 지역 코드, 게시글 검색 코드는 동일하다.
기존 Cassandra DDL/컬럼/데이터/TTL과 Redis key 의미를 변경하거나 삭제하지 않는다.

## Map 변경 파일별 근거

| 파일 (services/map-service/ 기준) | 신규 기능 추가에 한정된 근거 |
| --- | --- |
| `src/main.ts` | 신규 등록 import/호출과 종료 호출 3줄만 추가. 기존 HTTP/gRPC 생성·소비자·readiness 로직은 그대로다. |
| `src/store.ts` | import 1줄과 기존 put 완료 후 ID observer 호출 1줄만 추가. 원래 쿼리/이동 감지/캐시/return은 수정하지 않았다. observer는 동기 I/O가 없고 예외를 기존 저장 결과에 전파하지 않는다. |
| `src/notification-location-events.ts` | 신규 observer 등록/예약만 구현. 기존 위치 저장을 대체하지 않는다. |
| `src/notification-recipient-index.ts` | 새 namespace의 동의 기반 H3 snapshot, 페이지 조회, TTL/손상 검증, 갱신/복구만 구현. 기존 데이터 삭제/변경 명령은 없다. 기존 위치 store는 조회만 한다. |
| `src/notification-grpc.ts` | 새 service/package만 등록. 별도 Notification ES256 public JWKS로 인증하며 기존 Post 인증 설정을 건드리지 않는다. |
| `src/notification-runtime.ts` | 신규 플래그/키 설정·Redis 연결·worker 시작/종료를 격리한다. 신규 키 오류나 접속 실패가 기존 Map 시작을 막지 않으며 연결을 기존 시작 경로에서 await하지 않는다. |
| `contracts/map-notification.proto` | 새 service/RPC/message만 정의. 기존 map-authorization.proto 및 Post 복사본은 그대로다. |
| `contracts/map-notification.md` | 신규 계약과 복구·운영 한계 문서다. |
| `test/notification-recipients.test.ts` | 신규 전용 테스트. 기존 Map 테스트 파일 16개는 수정하지 않았다. |

## 나머지 이슈 2 변경 파일

Notification 기준:

```text
services/notification-service/.env.example
services/notification-service/Dockerfile
services/notification-service/package.json
services/notification-service/pnpm-lock.yaml
services/notification-service/contracts/map-notification.proto
services/notification-service/src/event-consumer/post-event.ts
services/notification-service/src/notification/map-nearby.client.ts
services/notification-service/src/notification/nearby.policy.ts
services/notification-service/src/notification/nearby.worker.ts
services/notification-service/src/notification/notification.module.ts
services/notification-service/src/persistence/nearby-map.schema.ts
services/notification-service/src/persistence/schema.ts
services/notification-service/test/integration/infrastructure.integration.ts
services/notification-service/test/integration/legacy-upgrade.integration.ts
services/notification-service/test/integration/nearby.integration.ts
services/notification-service/test/integration/nearby-map.integration.ts
```

신규 정책 테이블은 `notification_nearby_job_policy`, migration version은 5다. 기존 테이블 컬럼/행은 변경하지 않는다.
기존 nearby 테스트는 Map 대상자 응답 대역을 주입하고 기존 동의·설정·저장·재시도 assertion을 유지했다.
인프라/upgrade 테스트는 추가 migration/테이블을 fixture에 반영했다. 실제 Map gRPC는 별도 신규 통합 테스트에서 검증한다.
grpc-js/proto-loader는 기존 잠금 버전을 직접 의존성으로 승격했다. 다른 의존성 버전은 변경하지 않았다.
Docker runtime에는 새 Proto 파일도 포함한다.

공통 검증/문서:

```text
scripts/ci-run.mjs
scripts/ci-services.json
scripts/nearby-ci.test.mjs
docs/qa/FINAL_QA_PROFILE_IMAGE_NEARBY_NOTIFICATION.md
```

Notification의 실제 Map 모듈 통합 테스트를 위해 CI가 Map 의존성을 먼저 준비하도록 추가했고,
신규 계약 변경 시 두 서비스 회귀를 선택한다. 기존 CI/Post 준비 경로는 유지한다.
`scripts/gke-lib.mjs`, 운영 렌더러/Secret/IAM/배포 manifest는 변경하지 않았다.

## 검증 결과와 재현 범위

| 검증 | 결과 |
| --- | --- |
| 변경 전 Map 기존 전체, Linux Node 24 + 실제 Cassandra 4.1/Redis 8 | 16개 파일, **103 통과** |
| 변경 후 Map 기존 전체 + 신규 전용 테스트 | 17개 파일, **113 통과** (기존 103 + 신규 10), skip 없음 |
| Notification 기존 단위 회귀 | **112 통과**, 변경 전/후 동일 |
| Notification PostgreSQL/Redis 통합 | **93 통과·1 skip** (기존 87개 + 신규 Map 경로 6개). skip은 재시작 선택 테스트 |
| 신규 실제 gRPC 경로 | 실제 Post CreatePost 명령/Outbox serializer → Redis Streams 소비/ACK → Map gRPC → 동의/차단/반경/이동/설정 필터 → PostgreSQL 알림함/delivery → 실제 Firebase adapter + Messaging 대역, **6 통과** |
| 실패/복구 | Map UNAVAILABLE 시 같은 job/cursor 재시도, snapshot 유실 재구축, 부분/미완성/TTL 만료 거부, 기존 Map 캐시 유실 시 Cassandra 조회, observer 예외/신규 설정 오류 격리, FCM 일시 실패 재시도·중복 방지 |
| 페이지/경계 | 115명 pagination, 50명 모두 반경 밖인 중간 페이지의 cursor 진행, 작성자/차단/비활성/미동의/5분 초과/이동 중 제외, 실제 50m 참가 반경, 150m 안/밖, 극지/날짜 변경선 |
| User 전체 회귀 | **542 통과·4 skip**, 기존 소스 그대로 |
| CI 준비/계약 선택 | Linux Node test **7 통과** |
| typecheck/build | Map/Notification/User 통과. 별도 lint script는 없다. |
| Map/Notification 로컬 Docker build/런타임 자산 | 성공, production dependency와 새 Map Proto 로드 확인 |
| 포맷 | 루트 npm run format 실행. 무관한 포맷/줄바꿈 변경은 원상 복구 |

Map 초기 Windows 실행의 기존 500ms 시간 예산 실패, host 경유 테스트 연결 지연은 테스트/정책 변경 없이
Linux 컨테이너 간 직접 연결로 해결했다. Notification의 한 전체 실행은 Map 테스트와 로컬 Redis DB가 겹쳐 무효 처리했고,
별도 logical DB로 격리해 다시 검증했다. 실패한 실행을 통과로 집계하지 않는다.
실행 로그는 로컬 `WGO/.runtime/qa-final-*.log`에 있다.

Post 생성 테스트에서 Post DB/위치 인가 port, User HTTP 응답, Firebase Messaging transport는 로컬 대역이다.
Map 새 RPC·Redis와 Notification 소비자·PostgreSQL·Firebase adapter는 실제 구현을 실행했다.
Map 별도 테스트는 실제 Cassandra location write/read 및 기존 캐시 유실도 검증했다.
운영 브라우저 GCS PUT/complete, 실기기 FCM, 운영 부하/성능 E2E까지 통과했다는 의미는 아니다.

## 운영/프론트 반영 조건 — 미실행

1. 프로필 IAM 변경은 위 보고서의 최소 권한 계획을 별도로 승인받는다. 코드 배포로 권한 문제를 해결하려 하지 않는다.
2. Notification version 5 migration을 승인 후 먼저 적용한다. 실제 참가 반경을 알 수 없는 과거 job은 임의 150m로 채우지 않는다.
   신규 경로를 끈 채 기존 15분 만료 정책으로 정리된 뒤 활성화하는 순서를 검토한다.
3. Map에 `MAP_NOTIFICATION_TRUSTED_JWKS`를 추가한다. Notification 기존 서비스 키의 **public** 부분만
   `iss=wgo-notification-service`와 함께 주입한다. 기존 `MAP_SERVICE_TRUSTED_JWKS`는 그대로 둔다.
4. Map `MAP_NEARBY_NOTIFICATIONS_ENABLED`, Notification `NEARBY_NOTIFICATIONS_ENABLED`는 기본 OFF다.
   두 서비스 코드/Proto/migration/키/동의 연동과 부하 검증을 완료한 후 별도 승인으로 활성화한다.
   Notification의 `MAP_GRPC_ADDRESS=map-service:50051`, 기존 User blocks URL/키, FCM 설정도 확인한다.
   현재 namespace 내부 통신 NetworkPolicy는 pod 간 ingress를 허용하므로 정책 변경을 요구할 근거는 없다.
5. FE는 기존 알림 종류 설정의 nearby=true와 별도로 명시적 위치 알림 동의를 받는다.
   Access JWT로 먼저 기존 `PUT /api/v1/location`에 위치를 갱신하고,
   `PUT /api/v1/notifications/nearby-subscription`에
   `{enabled:true,locationConsent:true,latitude,longitude,capturedAt:<ISO Z>,expiresInSeconds:60..900}`를 보낸다.
   상태는 GET 같은 경로, 철회는 DELETE(204) 또는 기존 `{enabled:false}` PUT을 사용한다.
   앱 x-user-id를 직접 보내지 않는다. 기존 Map 최신성 5분과 동의 만료를 유지하고 백그라운드 추적 범위를 확대하지 않는다.
6. Push는 기존 `PUT /api/v1/notifications/push-subscriptions`의 token/platform 등록이 별도로 필요하다.
   동의 만료/철회와 기존 queued push 취소를 유지한다. 알림함 저장과 실기기 Push 수신은 별도 검증한다.
7. 인덱스는 비동기다. 갱신/재구축과 위치 쓰기의 선형화, 10,000명/20초 상한의 운영 부하 성능은 보장하지 않는다.
   기존 Map의 동기 요청 쿼리/await는 그대로이며 회귀는 통과했지만, 추가 background I/O의 운영 부하 영향은 미검증이다.
   운영 규모 검증 전 플래그를 켜지 않는다. 더 강한 즉시 일관성이나 대규모 처리량이 필요하면 별도 설계를 합의한다.
8. 승인된 테스트 계정/기기에서 PostCreated부터 대상자·알림함·실제 FCM까지 검증하는 운영 E2E는
   데이터/객체/발송 변경을 수반하므로 이번에는 실행하지 않았다.

운영 반영 승인 요청이나 실행은 하지 않았다. 이 보고서는 로컬 구현·검증과 남은 운영 작업을 구분한다.
