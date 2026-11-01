# GCP 전환 검증 기록

이슈 #76의 신규 개발·데모 환경 전환을 12개 커밋으로 구현했다. 기존 AWS 데이터 이관과
AWS 리소스 삭제는 포함하지 않는다. 로컬 검증 완료와 실제 GCP 배포 완료는 구분한다.
아래 결과는 2026-11-01, Node 24.21.0과 로컬 Docker 저장소에서 확인했다.

## 서비스와 계약

모든 7개 앱의 `pnpm typecheck`, 테스트, `pnpm build`가 통과했다.
패키지에 별도 lint script가 없어 임의 linter를 추가하지 않았다. 루트 `npm run format`을 적용했다.

| 범위 | 실행 | 결과 |
| --- | --- | --- |
| User | `pnpm test` | 242 pass, 1 skip |
| Map | `pnpm test` | 91 pass |
| Post | `RUN_INTEGRATION=1 RUN_SEMANTIC_INTEGRATION=1 pnpm test` | 199 pass, 12 skip |
| Notification | `pnpm test` / `pnpm test:integration` | 59 / 36 pass |
| HTTP Gateway | `pnpm test` | 60 pass |
| WS Gateway | `pnpm test` | 52 pass |
| Moderation | `pnpm test` / `pnpm test:integration` | 53 / 50 pass, 통합 1 skip |
| User→Gateway | `RUN_GATEWAY_INTEGRATION=1 pnpm exec vitest run test/auth.integration.test.ts` | 63 pass |
| WS→Post·Map | `RUN_INTEGRATION=1 RUN_WS_INTEGRATION=1 pnpm exec vitest run test/post.integration.test.ts test/ws-lifecycle.integration.test.ts test/map-budget.integration.test.ts` | 28 pass |
| 실제 E5 모델 | Post의 `pnpm semantic:model:test` | 3 pass |
| CD·설정·Kubernetes renderer | `node --test scripts/*.test.mjs` | 54 pass |

교차 계약은 해당 서비스 디렉터리에서 실행한다. User의 기본 실행에서 생략한 Gateway 경로는 별도 실행으로 확인했다.
Post의 기본 실행에서 생략한 WS 경로와 모델 단위 검증도 별도로 실행했다. 실제 모델과 전체 검색 통합을 함께 실행하는 선택 테스트는 미실행이다.
Moderation의 강제 Redis 재시작 선택 테스트와 실제 OpenAI·FCM 호출은 이번 검증에서 실행하지 않았다.
실패 주입 테스트의 예상 오류 로그를 테스트 실패로 세지 않았다.

Notification은 실제 PostgreSQL·Redis로 중복 이벤트, 트랜잭션 rollback, token 소유권,
재시도 lease와 만료 정리를 확인했다. Cloud SQL IAM Proxy 모드는 설정 계약 테스트이며 실제 IAM 연결을 증명하지 않는다.
GCS adapter는 세대 번호와 create-only 조건, 재시도·해시 검증을 테스트했으며 실제 서명 URL은 GCP smoke 대상이다.
Post 미디어 통합 첫 실행에서 일시적 404가 있었고 재실행 7/7 및 루트 전체 실행이 통과했다. 원인은 확정하지 않았다.

로컬 상세 로그는 `/private/tmp/wgo-gcp-<service>-final.log`,
`/private/tmp/wgo-gcp-script-final.log`, `/private/tmp/wgo-gcp-user-gateway-contract.log`,
`/private/tmp/wgo-gcp-ws-post-contract.log`에 남겼다. 이 경로는 작업 머신의 증거이며 CI artifact가 아니다.
재현에는 [CI 안내](../ci.md)의 격리 저장소와 서비스 `.env.example`을 사용한다.

## 컨테이너와 영속 저장소

- 실제 Post linux/amd64 이미지를 빌드하고 포함된 모델로 384차원 벡터 추론 smoke를 실행했다.
- 실제 Notification 이미지에서 migration 재실행, cleanup, live/ready HTTP와 SIGTERM 종료를 확인했다.
- MongoDB TLS·인증·단일 replica set에서 트랜잭션 commit/rollback 및 재시작 후 보존을 확인했다.
- Redis TLS·인증·AOF·Streams 재시작 보존을 확인했다. 별도 Redis command smoke로 GEO·Lua·Pub/Sub·pending reclaim·ACK를 확인했다.
- Cassandra TLS·제한 계정·schema 초기화·LOCAL_QUORUM·LOCAL_SERIAL 조건부 쓰기를 확인했다.
- runtime wrapper의 실제 자식 프로세스에 SIGTERM이 전달되고 drain 종료를 기다리는 테스트를 실행했다.

다중 worker 경쟁·lease·중복 방지는 저장소 통합 테스트로 확인했다. 실제 GKE replica 확대·Pod 교체 시험은 아직 실행하지 않았다.
로컬 재시작 시험은 Backup for GKE 복원이나 Cloud SQL PITR 시험을 대신하지 않는다.

## 배포 정의와 권한

kubeconform 0.7.0을 공식 체크섬으로 검증해 `node scripts/gke-validate.mjs`를 실행했다.
Kubernetes 1.33 schema 기준 59개 리소스 중 46 valid, 13 skipped, 0 invalid, 0 errors였다.
생략 대상은 SecretProviderClass·ManagedCertificate·BackendConfig·FrontendConfig·Elasticsearch·ProtectedApplication CRD다.
이 결과는 GKE Autopilot admission 통과를 뜻하지 않는다.

`gcp-bootstrap.mjs`, `gcp-cicd-identity.mjs`는 dry-run 출력만 확인했다.
배포 orchestration 테스트는 주입한 CLI 응답으로 digest 승격·migration 선행·실패 복원을 검증했다.
GitHub hosted runner와 실제 GKE rollout 결과는 이 로컬 기록에 포함하지 않는다.

독립 검토 후 다음을 보완했다.

- Secret Manager managed CSI용 KSA principal 권한을 SDK용 GSA 권한과 함께 부여한다.
- `webOrigins`를 GCS CORS와 Gateway 설정에 반영한다.
- Backup for GKE 복원 대상을 MongoDB·Redis·Cassandra로 제한한다. 원본 Cloud SQL·GCS에 접속할 수 있는 앱과 ES snapshot writer를 자동 복원하지 않는다.
- ConfigMap·SecretProviderClass·bootstrap을 내용 hash로 고정하고 Notification CronJob도 같은 버전을 참조한다.

## AWS 잔여 의존성

7개 앱 package manifest와 런타임 소스, 배포 스크립트, Actions에서 AWS SDK 직접 의존성과
AWS credential·ECR·ECS·DynamoDB·S3 환경변수를 제거했다. 과거 AWS runbook은 새 문서 안내로 교체했다.
역사적 QA·성능 기록은 당시 결과를 보존한다.

Post MongoDB 드라이버와 Moderation OpenAI SDK lockfile에는 upstream의 선택적 AWS peer dependency 이름이 남는다.
이것은 앱이 AWS SDK를 설치·사용하도록 추가한 dependency가 아니므로 생성된 lockfile metadata를 임의 삭제하지 않았다.

## 실제 GCP에서 남은 확인

1. bootstrap dry-run을 검토하고 실제 프로젝트·도메인·IAM과 고정 Secret 버전을 설정한다.
2. Cloud SQL 자동 IAM 인증과 서비스별 DB 접근 거부, migration Job 종료를 확인한다.
3. ECK/CSI/Backup CRD 설치 후 Autopilot admission과 모든 저장소 readiness를 확인한다.
4. GCS `media:gcs:smoke`로 Workload Identity signBlob, 브라우저 CORS, 업로드·완료·다운로드를 확인한다.
5. 두 Gateway HTTPS·WebSocket, 7개 앱 rollout, Pod 삭제·replica 확대 중 이벤트 pending 회수와 중복 방지를 확인한다.
6. Cloud SQL PITR, 별도 클러스터 Backup for GKE restore, ECK GCS snapshot restore와 미디어 객체 버전 복원을 실제 데이터로 확인한다.
7. Cloud Logging·Monitoring에서 장애 로그·지표 수집과 알림 운영을 확인한다.

실행 명령과 복원 격리 조건은 [GCP 초기화](gcp.md), [저장소 운영](gcp-storage.md), [CD](cd.md)를 따른다.
