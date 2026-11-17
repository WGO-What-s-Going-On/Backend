# 주변 알림: 구독 없는 위치 GEO 경로

2026-11-17 KST. 로컬 구현·검증 문서. 운영 적용은 실행하지 않았다.
이 문서는 이전 FINAL_QA_PROFILE_IMAGE_NEARBY_NOTIFICATION.md의 구독 기반 **주변 알림** 설계를 대체한다.
프로필 이미지 진단 결과와 기존 커밋은 변경하지 않는다.

## 계약과 대상 선정

PostCreated의 `post.latitude`, `post.longitude`, `post.radiusM`을 사용한다.
기존 migration 5의 `notification_nearby_job_policy.participation_radius_m`에 원래 반경을 저장해 재시도에도 보존한다.
새 Map RPC는 `wgo.map.locations.v1.MapLocationRecipients/FindNearbyLocationUsers`이다.
요청: latitude, longitude, participationRadiusM(기존 Post 계약 1..10000m, UI의 150/250/350m 포함), authorId, limit(1..50), afterUserId.
응답: users[{userId}], nextAfterUserId. 기존 Map RPC/메시지/필드는 변경하지 않는다.

Map의 새 Redis GEO는 후보만 제공한다. 후보마다 기존 LocationStore의 최신 위치·이동 상태를 다시 읽고
기존 `decide`로 실제 반경과 5분 최신성, 미래 시각 허용 범위를 검사한다. 이동 중·정지 미확인은 제외한다.
GEO의 근사 좌표와 거리 오차는 1m 후보 여유와 원본 좌표 최종 계산으로 보정한다.
Redis GEO가 지원하지 않는 위도 ±85.05112878 밖은 새 조회가 UNAVAILABLE로 실패하며 기존 Map 기능은 그대로다.

Notification의 기존 설정 기본값은 그대로다: 레코드 없음/nearby 필드 없음/true는 포함, false는 제외.
작성자, 비활성 사용자, 양방향 차단, 게시글별 수신 해제, 중복, 기존 빈도 제한도 적용한다.
기존 inbox writer, durable delivery, FCM adapter의 재시도·토큰 정리·멱등성을 재사용한다.
새 nearby delivery에만 내부 audience 식별자와 작업 만료 시각을 추가하며 이 값은 FCM payload에서 제거한다.
기존 구독 revision이 붙은 대기 delivery는 기존 구독 검사를 유지한다.
Map/동의 조회 오류는 job을 PENDING으로 돌리고 재시도한다. 삭제/종료/숨김, 만료, 플래그 OFF는 발송을 막는다.

## 동의·철회

User의 새 읽기 전용 내부 API: `POST /internal/notifications/nearby/eligibility`, body `{userIds:["1",...]}` (1..50, 중복 금지).
Notification 전용 ES256 서비스 JWT만 허용한다. 응답 `{users:[{userId:"1",eligible:true}]}`.
User DB만 읽으며 ACTIVE 상태 및 현재 유효한 LOCATION, PRIVACY_COLLECTION_USE 약관 각각의
`user_term_consents.revoked_at IS NULL`, agreed_at <= now를 확인한다.
누락·철회·구버전 동의·존재하지 않는 사용자/약관은 false이다. 통신·응답 오류는 자동 허용하지 않는다.
발송 작업 생성 전과 새 nearby Push 직전에 다시 확인한다. 다른 알림 유형에는 적용하지 않는다.

별도의 프론트 동의 UI/구독 API를 필수로 추가하지 않는다. 기존 가입 약관 동의 기록을 사용한다.
실제 운영 약관 본문과 운영 동의 데이터는 이번 작업에서 조회하지 않았다. 코드의 동의 기록 확인은
새로운 위치 사용 목적이 법적으로 승인됐다는 증명이 아니다. 운영자는 현재 게시 약관의 주변 게시글 알림 목적,
보존 기간, 기존 철회 UI가 실제로 revoked_at 또는 nearby=false에 반영되는지 배포 전에 확인해야 한다.
현재 DB 밖에서 철회된 사실이나, 과거 구독 DELETE 후 삭제된 행만으로는 과거 철회 여부를 복원할 수 없다.
그런 별도 철회 기록이 있다면 활성화 전에 기존 settings/동의 기록과 대조해야 하며 동의로 임의 추정하지 않는다.

## 프론트 계약과 기존 구독 API 호환

- 위치: 기존 `PUT /api/v1/location` 요청·응답 그대로. 기존의 정상적인 위치 갱신으로만 새 GEO가 채워진다.
- 설정: 기존 `GET/PATCH /api/v1/notifications/settings`, JSON `{nearby:false}`로 수신 해제,
  `{nearby:true}`로 활성화한다. 누락/기본값도 대상이므로 새 opt-in 요청은 필요하지 않다.
- 기존 가입 약관 API `POST /api/v1/users/me/term-consents` 계약은 변경하지 않는다.
- `/api/v1/notifications/nearby-subscription` GET/PUT/DELETE 및 테이블은 유지한다.
  새 수신자 선정에는 사용하지 않는다. 구독 PUT은 위치 갱신이나 nearby=true 설정을 대신하지 않는다.
  DELETE는 기존 행/대기 nearby delivery 정리에 더해 nearby=false를 병합하여 구버전 프론트의 철회를 존중한다.
  다른 설정 필드는 보존한다. 재활성화는 기존 알림 설정 API로 수행한다.
- 과거 구독 API의 응답 `enabled/locationConsent`는 구독 행의 상태이며 새 nearby 설정을 뜻하지 않는다.
  프론트는 새 경로에서 해당 응답을 수신 설정으로 해석하거나 등록·갱신할 필요가 없다.

## Redis GEO 수명과 장애 한계

신규 namespace: `map:nearby-location:v1:geo`, `:time`, `:state`만 사용한다.
geo는 ID/좌표, time은 위치 갱신 시각, state는 epoch/초기화 시각/개수/용량 장애 시각을 보유한다.
기존 Cassandra 테이블과 Redis 키는 쓰거나 지우지 않는다. Cassandra 스캔/backfill은 없다.
원본 위치 API 성공 뒤의 기존 관찰자 hook은 ID만 크기 제한 Set에 넣는다. 네트워크 I/O를 기다리지 않는다.
별도 timer가 최대 5개의 위치 읽기를 병렬 처리하여 Lua로 GEO/시각/manifest를 원자 갱신한다.
대기 ID는 1,000개, GEO 멤버는 100,000개로 제한한다. 5분 초과 멤버는 tick당 최대 1,000개 정리한다.
키 TTL은 610초이며 worker 종료 뒤 남은 키도 제거된다. 정리되는 동안에도 원본 최신성 재검사로 발송하지 않는다.

프로세스 재시작은 남아 있는 공유 Redis 인덱스를 사용한다. 키 유실/개수 불일치/queue overflow는
새 인덱스를 초기화한다. 초기화 후 5분은 UNAVAILABLE로 응답하며 Notification은 재시도한다.
이후 성공적인 위치 갱신을 관찰한 사용자만 조회된다. 준비된 빈 결과와 미준비·Redis 장애를 구분한다.
100,000명 상한을 넘으면 5분간 UNAVAILABLE로 처리해 조용히 일부만 성공으로 반환하지 않는다.

**알려진 한계:** 비동기 관찰 전후 프로세스 강제 종료, Redis 단절, 복구 중 갱신하지 않는 사용자,
여러 Pod의 갱신/페이지 진행 경쟁으로 일부 후보가 누락될 수 있다. 이벤트 전체 수신자 집합의 snapshot은 아니다.
원본 Cassandra가 있어도 복구용 전체 스캔을 하지 않는다. 복구의 완전성과 at-least-once 위치 이벤트는 보장하지 않는다.
이미 완료한 fanout을 나중 위치 갱신 때문에 재발송하지 않는다. 작업은 PostCreated 후 기존 15분에 만료된다.
개별 동의/차단 검사 후 실제 전송 사이의 동시 철회 경쟁도 서비스 간 원자 트랜잭션으로 제거할 수는 없다.

## 기존 Map 보존 근거

이번 Map 변경은 다음 파일뿐이다.

| 파일 | 변경 이유 |
| --- | --- |
| src/location-geo-index.ts | 별도 namespace와 bounded worker의 신규 GEO 인덱스 |
| contracts/map-location-recipients.proto | 기존 필드와 별개 package/service/message 추가 |
| src/notification-grpc.ts | 기존 인증·handler로 신규 service 추가 등록, 기존 RPC handler 동일 |
| src/notification-runtime.ts | 플래그 안에서 새 index 생성·시작·종료 연결 |
| test/location-geo-index.test.ts | 신규 기능 검증만 추가 |

기준 e5c6213 대비 main.ts/store.ts/server.ts/location.ts/movement.ts/post-index.ts 및 기존 proto/schema/test는 동일하다.
원본 위치 HTTP 처리의 응답/오류/await 경로에 변경이 없다. 새 worker는 같은 DB/Redis 자원을 사용하므로
운영 지연 영향이 절대 0이라는 보장은 할 수 없다. 로컬 전체 회귀 및 비동기 hook 검증과 별개로
운영 활성화 전 Map 지연/DB 부하/Redis 메모리/신규 RPC p95를 비교해야 한다.

## 운영 적용 체크리스트 — 실행하지 않음

1. CD main push는 `.github/workflows/cd.yml`의 staging을 실행한다. `CD_ENABLE_PRODUCTION=true`이면
   production environment job으로 같은 이미지 digest를 승격한다. 실제 GitHub Environment의 필수 승인자
   설정과 현재 repository variable 값은 이번 작업에서 확인하지 않았다. 자동 운영 승격 여부를 병합 전에 확인한다.
   수동 workflow_dispatch는 staging만이다. 단순 main 병합도 자동 CD를 유발할 수 있으므로 운영자가 사전 확인한다.
2. `scripts/cd.mjs`는 User/Notification 배포 전에 `migrationJob`을 실행·완료 확인한 후 rollout한다.
   Notification migration 5는 **필요**하다. 기존 v4 테이블/행을 보존하고 radius 정책 테이블만 추가한다.
   legacy job의 알 수 없는 반경은 추정하지 않아 만료까지 재시도할 수 있다. 신규 migration은 없다.
3. `deploy/gke/runtime.cjs`는 runtime.json을 base env 위에 병합한다. Secret 전체를 예제 파일로 덮어쓰지 않는다.
   서비스별 기존 Firebase credentials, Post→Map 키, DB/Redis 설정을 반드시 보존한다.
4. Notification `NOTIFICATION_SERVICE_PRIVATE_JWK`의 EC/P-256/ES256/kid에 대응하는 **공개키만**
   Map `MAP_NOTIFICATION_TRUSTED_JWKS` 및 User `USER_NOTIFICATION_TRUSTED_JWKS`에 추가·확인한다.
   iss=wgo-notification-service, sub=notification-service, aud는 각각 wgo-map-service/wgo-user-service, 만료30초이다.
   Post/Gateway 키를 재사용하거나 덮어쓰지 않는다. 실제 Secret 값·키 배포 상태는 이번 단계에서 검증하지 않았다.
5. Notification `MAP_GRPC_ADDRESS`와 `NOTIFICATION_USER_BLOCKS_URL`을 확인한다.
   동의 API는 blocks URL의 origin에서 `/internal/notifications/nearby/eligibility`로 파생한다.
   프록시 경로가 다르면 `NOTIFICATION_USER_NEARBY_ELIGIBILITY_URL`을 별도로 지정한다.
   내부 DNS/네트워크 정책, service-to-service 연결 및 timeout(2초)을 확인한다.
6. 먼저 `NEARBY_NOTIFICATIONS_ENABLED=false`를 유지한 상태로 User 동의 API, Map 새 RPC, Notification을 배포한다.
   CD의 서비스 rollout 순서에 의존하지 않는다. User 권한 검사 테스트, Map 기존 readiness/계약을 확인한다.
7. `MAP_NEARBY_NOTIFICATIONS_ENABLED=true`로 새 RPC/worker를 켠다. 기존 PUT 위치 갱신을 기다려
   5분 warm-up 완료 및 bounded key 개수/TTL, Redis 오류·메모리·원본 위치 API 지연을 검증한다.
   승인되지 않은 실제 사용자 위치 생성, 테스트 Push/운영 데이터 수정은 하지 않는다.
8. 운영 약관/철회 기록과 프론트 설정 계약 확인 후에만 Notification 플래그를 true로 활성화한다.
   기존 Push delivery 플래그는 다른 알림에 영향을 주므로 이 기능 때문에 변경하지 않는다.
   Map UNAVAILABLE가 빈 성공이 아닌 PENDING retry인지, backlog/만료 로그, inbox와 FCM 지표를 관찰한다.
9. 장애 시 우선 Notification의 nearby 플래그만 false로 전환하고 pending/만료 상태를 확인한다.
   기존 의미대로 획득되는 nearby delivery는 취소될 수 있고 재활성화가 취소/만료 job을 재생하지 않는다.
   필요 시 Map nearby 플래그도 false로 끄고 기존 위치/게시글 API를 확인한다.
   키를 임의로 지울 필요는 없으며 재가동 시 점진 복구/warm-up한다. 기능 OFF가 진행 중 FCM을 회수하지는 못한다.
10. 이미지 rollback 시 기존 Secret과 migration 5는 유지한다. 테이블 drop/down migration, 원본 Map 키 삭제 금지.
    구독 없는 새 delivery를 구버전이 구독 검사로 취소할 수 있으므로 먼저 nearby OFF 후 상태를 기록한다.
    필요한 재처리는 운영자의 명시적 검토 대상이며 자동 재발송/이벤트 재주입하지 않는다.

운영 GCP/IAM/Secret/DB/Redis/FCM을 변경하거나 실제 Push를 발송하지 않았다.

## 최종 로컬 검증 결과

| 항목 | 변경 전 기준 | 최종 결과 |
| --- | --- | --- |
| Map 전체 | e5c6213 아카이브 실행: 113 통과 | 121 통과 (기존 113 + 신규 8), 기존 테스트 수정 없음 |
| Notification 단위 | 112 통과 | 112 통과 |
| Notification 통합 | 이전 QA 기록 93 통과/1 skip | 103 통과/1 skip |
| User 전체 | 이전 QA 기록 542 통과/4 skip | 546 통과/4 skip |
| CI 선택·계약 복사 | 기존 CI 검사 | 19 통과/1 Windows 전용 skip |

- Map/User 전체는 기존 짧은 concurrency timeout을 변경하지 않고 로컬 Linux Node 24 컨테이너에서 실행했다.
- Notification 통합은 로컬 PostgreSQL/Redis, 실제 gRPC transport, Post command/serializer와 Redis Stream Consumer,
  Firebase adapter 및 로컬 HTTP 동의·차단 테스트 대역을 연결한다. 실제 GCS/FCM을 호출하지 않는다.
- User의 새 동의 endpoint는 별도 로컬 PostgreSQL 테스트 DB에서 실제 SQL과 서비스 인증을 검증했다.
- 150/250/350m 안팎 경계, 설정 없음/필드 없음/true/false, 5분 만료, 이동/정지 미확인,
  작성자/차단/비활성/동의 철회, GEO 생성/이동/만료/상한/TTL/유실/재시작/복구/장애를 검증했다.
- 실제 2초 gRPC deadline, Map 오류, 생성 전/전송 직전 동의 조회 장애, Consumer 재시작/중복,
  inbox/FCM retry 멱등성, 삭제/종료/숨김, delivery 만료를 검증했다.
- Map/Notification/User typecheck·build 통과. 각 package에 별도 lint script는 없다.
- root `npm run format` 실행 후 무관한 포맷 변경은 제거했다. git diff --check 통과.
- 초기 Windows 실행의 로컬 Redis 미접속, 파일 잠금 EBUSY, 테스트 GEO seed 생성 중 timer 경쟁은
  실행 환경 분리·원자 seed로 해결했다. 기존 테스트 timeout이나 기대값을 완화하지 않았다.
- 배포·실제 Secret/약관 본문·운영 동의 분포·대규모 성능·실제 FCM은 미검증이다.

## 변경 파일 전체

- `docs/qa/FINAL_QA_PROFILE_IMAGE_NEARBY_NOTIFICATION.md`
- `docs/qa/NEARBY_LOCATION_GEO_ROLLOUT.md`
- `scripts/ci-services.json`
- `scripts/nearby-ci.test.mjs`
- `services/map-service/contracts/map-location-recipients.proto`
- `services/map-service/src/location-geo-index.ts`
- `services/map-service/src/notification-grpc.ts`
- `services/map-service/src/notification-runtime.ts`
- `services/map-service/test/location-geo-index.test.ts`
- `services/notification-service/README.md`
- `services/notification-service/contracts/map-location-recipients.proto`
- `services/notification-service/src/event-consumer/post-event.handler.ts`
- `services/notification-service/src/firebase/firebase-push.adapter.ts`
- `services/notification-service/src/notification/map-nearby.client.ts`
- `services/notification-service/src/notification/nearby-eligibility.client.ts`
- `services/notification-service/src/notification/nearby-subscription.service.ts`
- `services/notification-service/src/notification/nearby.worker.ts`
- `services/notification-service/src/notification/notification.module.ts`
- `services/notification-service/src/persistence/postgres-event.store.ts`
- `services/notification-service/test/integration/nearby-map.integration.ts`
- `services/notification-service/test/integration/nearby.integration.ts`
- `services/user-service/src/http-auth/gateway-auth.guard.ts`
- `services/user-service/src/users/nearby-eligibility.controller.ts`
- `services/user-service/src/users/users.module.ts`
- `services/user-service/test/nearby-eligibility.integration.test.ts`
