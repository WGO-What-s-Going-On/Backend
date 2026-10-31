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
