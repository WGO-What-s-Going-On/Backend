# GCP 개발·데모 배포

서울 `asia-northeast3`의 GKE Autopilot에 7개 앱을 독립 Deployment로 배포한다.
Elasticsearch는 ECK, MongoDB·Redis·Cassandra는 PVC를 사용하는 단일 노드 StatefulSet이다.
MongoDB는 `rs0` replica set이다. Atlas와 Memorystore는 사용하지 않는다.
Cloud SQL PostgreSQL 인스턴스 하나에 `wgo_user`와 `wgo_notification` DB 및 IAM 사용자를 분리한다.
Cloud Storage 버킷은 비공개이며 Post만 객체와 서명 권한을 가진다.

## 설정과 권한을 준비한다

`deploy/gke/environment.example.json`을 저장소 밖에 복사하여 프로젝트와 도메인을 입력한다.
이 파일에는 비밀값을 넣지 않는다. 실행 시 `GCP_ENV_FILE`로 지정한다.
앱별 Secret Manager secret 이름은 `<namespace>-<service>-runtime`이다.
값은 해당 서비스 `.env.example`의 문자열 설정을 담은 JSON object다.
CSI driver가 특정 버전을 `/var/run/wgo/runtime.json`으로 mount한다.
`runtime.cjs`가 자식 프로세스를 시작하기 전에 읽으므로 JWT와 인증서 등 설정은 시작 시 적용된다.
새 secret 버전은 검토한 배포 설정 변경과 rollout으로 적용한다. `latest`를 배포에 사용하지 않는다.

Cloud SQL 사용자 이름은 서비스 GSA 이메일에서 `.gserviceaccount.com`을 뺀 이름이다.
앱과 migration은 동일 Pod의 Auth Proxy에 연결한다. `DB_CONNECTION_MODE=cloud-sql-proxy`,
`DB_HOST=127.0.0.1`, `DB_TLS_MODE=disable`을 사용하고 `DB_PASSWORD`는 넣지 않는다.
Proxy의 `--auto-iam-authn --private-ip`가 원격 TLS와 토큰 갱신을 담당한다.
서비스 계정에는 자기 DB의 CONNECT와 schema 권한만 부여한다.
다른 서비스 DB의 PUBLIC CONNECT를 회수한다. DB 생성과 권한 부여는 관리자 초기화 작업이다.

GitHub 배포 계정은 Artifact Registry push와 대상 namespace의 배포 권한만 가진다.
Pod 계정과 분리하고 GitHub OIDC provider의 repository 및 main ref 조건을 제한한다.
앱별 GSA에 필요한 자기 secret의 `secretAccessor`를 부여한다.
User와 Notification에는 Cloud SQL Client 및 Instance User를 부여한다.
Post에는 미디어 버킷 객체 권한과 서명용 GSA의 `iam.serviceAccounts.signBlob` 권한을 부여한다.
서비스 계정 JSON key를 생성하지 않는다.

## 구현과 검증 순서를 따른다

1. 설정 계약을 확정한다.
2. User Cloud SQL 연결을 전환한다.
3. Map Cassandra 연결을 전환한다.
4. Notification PostgreSQL schema와 repository를 준비한다.
5. Notification 이벤트·retry 구현 후 모든 provider를 함께 전환한다.
6. GCS 미디어를 전환한다.
7. Post 운영 DB·검색·모델을 검증한다.
8. Redis 연결·복구를 검증한다.
9. Kubernetes 앱·저장소·백업 정의를 추가한다.
10. Pod 교체와 여러 replica를 검증한다.
11. CI/CD를 전환한다.
12. 통합 검증과 AWS 의존성 정리를 완료한다.

기존 데이터 이관과 AWS 리소스 삭제는 범위 밖이다. 사용자는 12개 커밋과 하나의 PR을 요청했다.

## 근거

- [GKE Secret Manager CSI](https://docs.cloud.google.com/secret-manager/docs/secret-manager-managed-csi-component).
- [Cloud SQL GKE 연결](https://docs.cloud.google.com/sql/docs/postgres/connect-kubernetes-engine).
- [ECK Autopilot](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/deploy-eck-on-gke-autopilot).

## 새 환경을 초기화한다

`gcloud`, `kubectl`, Node 24, OpenSSL, JDK keytool을 준비한다. 아래 생성 명령은 비용이 발생하므로 대상 프로젝트를 확인하고 실행한다.

```sh
export GCP_ENV_FILE=/secure/wgo-demo-environment.json
node scripts/gcp-bootstrap.mjs
node scripts/gcp-bootstrap.mjs --apply
```

첫 명령은 수행할 명령만 출력한다. 두 번째 명령이 VPC·NAT·Autopilot·Artifact Registry·Cloud SQL·비공개 버킷·IAM을 생성한다.
기존 리소스의 발견 오류를 미존재로 취급하지 않는다. 이미 있는 리소스의 모든 drift를 자동 교정하는 도구는 아니다.
클러스터는 private node와 IAM으로 접근하는 DNS control-plane endpoint를 사용한다.
Secret Manager CSI의 KSA principal 권한과 SDK용 GSA 권한을 각각 설정한다.
`webOrigins`에는 실제 프런트엔드 HTTPS origin을 넣는다. Gateway와 GCS 버킷 CORS에 적용된다.

클러스터 인증을 얻은 뒤 foundation을 적용한다. 프로젝트와 클러스터 이름은 환경 파일과 일치시킨다.

```sh
gcloud container clusters get-credentials wgo-demo --region asia-northeast3 --project YOUR_PROJECT --dns-endpoint
node scripts/gke-render.mjs foundation > /tmp/wgo-foundation.json
kubectl apply -f /tmp/wgo-foundation.json
```

ECK operator와 CRD를 설치하고 `elastic-system` operator readiness를 확인한다.
[저장소 초기화·복원 절차](gcp-storage.md)에 따라 인증서·비밀번호를 생성한 후 저장소 정의를 적용한다.

```sh
node scripts/gke-render.mjs storage > /tmp/wgo-storage.json
kubectl apply -f /tmp/wgo-storage.json
bash scripts/gcp-storage-smoke.sh wgo-demo
```

DNS의 API·WS A 레코드는 생성한 글로벌 고정 IP를 가리켜야 한다.
ManagedCertificate의 `certificateStatus=Active`를 확인한다. 인증서 발급 대기는 앱 오류와 구분한다.
내부 서비스와 DB는 ClusterIP와 NetworkPolicy로 외부에서 직접 접근할 수 없다.

Cloud SQL은 관리자 연결로 아래 SQL을 실행한다. 이 단계에는 private IP 경로와 관리자 DB 인증이 필요하다.
DB와 IAM 사용자는 bootstrap에서 만들며 SQL 스크립트는 DB별 권한만 부여한다.

```sh
node scripts/gcp-sql-grants.mjs > /tmp/wgo-grants.sql
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/wgo-grants.sql
```

앱별 JSON에 JWT·서비스 간 JWK·Kakao·OpenAI·저장소 연결값을 채운다.
Post의 ES API key와 평가한 semantic threshold를 준비하고 초기 semantic alias를 생성한다.
JWT access secret/issuer/audience는 User와 두 Gateway가 동일하게 사용한다.
HTTP Gateway private JWK의 public key만 각 서비스 trusted JWKS에 넣는다.
Post private JWK의 public key만 Map과 User에, WS private JWK의 public key만 Post에 넣는다.
Notification은 FIREBASE_PROJECT_ID를 넣고 private key/email을 생략하면 ADC를 사용한다.
인증 키와 외부 API 키는 실제 값을 생성·발급해야 하며 저장소 예시를 그대로 배포하지 않는다.

```sh
gcloud secrets versions add wgo-demo-user-service-runtime --project YOUR_PROJECT --data-file=/secure/user-runtime.json
```

다른 6개 앱도 각자의 secret에 업로드한다. 출력된 숫자 version을 환경 파일에 고정한다.
기본 `secretVersion`과 서비스별 `secretVersions` override를 지원한다.
`{"secretVersions":{"user-service":"2"}}`는 User만 새 버전으로 전환한다.
앱 JSON으로 `NODE_EXTRA_CA_CERTS`, `DB_CONNECTION_MODE`, 내부 주소 같은 검토된 manifest 설정을 임의 덮어쓰지 않는다.

## CI/CD 권한을 연결한다

```sh
export GITHUB_REPOSITORY=WGO-What-s-Going-On/Backend
node scripts/gcp-cicd-identity.mjs
node scripts/gcp-cicd-identity.mjs --apply
```

이 명령은 main ref만 허용하는 GitHub OIDC provider와 Artifact Registry writer, namespace RBAC를 만든다.
스토리지 Secret·PVC·StatefulSet 삭제 권한을 CD에 주지 않는다.
출력된 비밀값 없는 provider·계정 식별자와 `.env.cd.example`의 Variables를 GitHub Environment에 설정한다.
staging과 production은 설정·namespace·IAM 계정을 분리하고 같은 registry의 digest를 승격한다.
개발·데모만 운영하면 staging의 수동 초기 배포를 사용하고 production Environment는 승인 전까지 실행하지 않는다.

## 백업과 관측을 확인한다

Cloud SQL은 일일 자동 백업 7개와 PITR 7일을 유지하며 삭제 보호를 사용한다.
GCS 미디어는 버전 관리를 사용한다. 이전 버전 정리 정책은 보존 요구를 확정한 뒤 적용한다.
Stateful 데이터와 ES의 별도 snapshot은 [저장소 백업](gcp-storage.md)을 따른다.
Cloud SQL PITR은 별도 인스턴스로 복원하여 User·Notification schema와 데이터 일관성을 확인한다.
앱 DB와 Redis snapshot의 시점이 다르므로 이벤트 dedup과 pending 처리를 함께 검증한다.

클러스터 생성에서 Cloud Logging의 SYSTEM·WORKLOAD와 Cloud Monitoring의 SYSTEM 수집을 활성화한다.
운영자는 GKE workload restart·OOM·PVC 용량·Redis 메모리·consumer pending·outbox 실패와 백업 실패를 확인한다.
서비스 로그의 event ID와 correlation ID로 전송 지연 원인을 추적한다. 비밀 JSON을 로그나 workflow artifact로 저장하지 않는다.

## 검증을 재현한다

```sh
npm run format
node --test scripts/*.test.mjs
node scripts/gke-validate.mjs
```

마지막 명령은 kubeconform 0.7.0과 Kubernetes 1.33 core schema를 사용한다.
ECK·CSI·GKE 전용 CRD는 이 검사에서 제외되므로 해당 CRD가 설치된 GKE의 server dry-run과 실제 rollout으로 별도 검증한다.
7개 앱 각각 `node scripts/ci-run.mjs SERVICE`로 repository-defined typecheck·tests·build를 실행한다.

## 기존 Standard 데모 클러스터에 배포한다

월 예산을 위한 단일 노드 환경은 `deploymentProfile: "standard-demo"`,
`clusterLocation: "asia-northeast3-a"`, `replicas: 1`을 환경 JSON에 지정한다.
`region`은 Artifact Registry와 Cloud SQL에 사용하는 `asia-northeast3`로 유지한다.
프로필 생략 시 기존 Autopilot 자원 설정과 regional location을 유지한다.
`gcp-bootstrap.mjs`와 저장소 renderer는 Autopilot 초기화용이다. 이미 구성된 Standard
클러스터와 저장소에 다시 실행하지 않는다.

Standard 앱 요청량은 Post 100m CPU·2560Mi, 나머지 6개는 각각 25m·384Mi다.
SQL proxy는 각각 10m·64Mi를 요청한다. 앱 합계는 270m·4992Mi다.
마이그레이션 하나와 Notification cleanup이 겹치면 340m·5888Mi가 필요하다.
배포 전 현재 시스템·저장소 요청량과 합쳐 노드 allocatable 및 namespace quota를 확인한다.
이 수치는 스케줄링 요청량이며 실제 처리 성능이나 최대 메모리 사용량의 보장이 아니다.
GitHub staging 환경의 `CD_DEPLOY_CONCURRENCY`는 `1`로 설정한다.
업데이트는 추가 Pod 없이 기존 Pod를 먼저 종료하므로 잠시 서비스가 중단된다.

첫 앱 배포 전에 `infra-http-gateway-maintenance`와 `infra-ws-gateway-maintenance`
Deployment를 제거한다. 앱 Service는 `wgo/component=application`까지 선택하므로
마이그레이션과 cleanup Job에는 사용자 요청을 전달하지 않는다.
`main` push의 production 승격은 repository variable `CD_ENABLE_PRODUCTION=true`일 때만
실행한다. 별도 production 인프라가 준비되기 전에는 설정하지 않는다.

MongoDB 서버 인증서는 replica 내부 연결에서 TLS client로도 사용되므로
serverAuth와 clientAuth 용도를 함께 갖는다. 기존 인증서를 교체할 때는 CA와
DB 비밀번호를 유지하고 인증서만 재발급한다. 초기화 스크립트를 재실행해
운영 비밀번호를 회전하지 않는다.
