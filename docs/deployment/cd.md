# GKE 배포 파이프라인

GitHub Actions는 main 변경을 Artifact Registry 이미지와 GKE Deployment로 배포한다.
`staging`에서 확인한 image digest를 `production`에 그대로 승격한다. production에서 재빌드하지 않는다.
개발·데모 인프라는 서울 `asia-northeast3` GKE Autopilot이다.

## 최초 실행을 준비한다

1. `gcp.md`와 저장소 배포 안내에 따라 인프라·DB·Secret Manager·TLS·Ingress를 초기화한다.
2. `.env.cd.example`의 비밀값 없는 설정을 각 GitHub Environment의 Variables에 등록한다.
3. `GCP_ENV_FILE=환경파일 GITHUB_REPOSITORY=WGO-What-s-Going-On/Backend node scripts/gcp-cicd-identity.mjs`로 IAM/RBAC 계획을 확인한 뒤 `--apply`로 생성한다. OIDC는 이 저장소와 `refs/heads/main`으로 제한한다. production Environment에 승인자를 지정한다.
4. 배포 GSA에 Artifact Registry writer, GKE 클러스터 조회 및 DNS endpoint 접근 권한을 부여한다.
5. namespace RBAC는 앱 ServiceAccount, SecretProviderClass, ConfigMap, Deployment, Service, migration Job, Pod 상태 조회와 smoke exec에 한정한다. PVC·StatefulSet·Secret 값 접근은 필요하지 않다.
6. main에서 `workflow_dispatch`의 `initial_deployment=true`로 staging을 초기화한다.

GKE DNS 기반 control-plane endpoint를 사용한다. 배포 runner가 private node 네트워크에 직접 연결할 필요는 없다.
생성 스크립트의 `roles/container.clusterViewer`는 클러스터 조회와 DNS endpoint 연결 권한을 제공한다. Kubernetes 쓰기는 namespace Role로 제한한다. [GKE IAM 권한](https://docs.cloud.google.com/iam/docs/roles-permissions/container)을 따른다.
일반 PR CI는 GCP 인증 없이 코드와 배포 renderer 및 orchestration 테스트를 실행한다.

DB 이름은 `wgo_user`, `wgo_notification`으로 고정되어 있다. production을 추가할 때는 staging과 별도 Cloud SQL 인스턴스·namespace·도메인·Secret을 사용한다. namespace만 분리해서는 DB가 격리되지 않는다.

최초 HTTPS smoke 전에 DNS와 ManagedCertificate가 준비되어야 한다. 인증서 발급 중 실패한 배포는 발급 완료 후 다시 실행한다.

## 변경 서비스를 배포한다

`scripts/cd.mjs`는 각 서비스의 `wgo-release-<name>` ConfigMap에서 마지막 성공 SHA를 읽는다.
마지막 성공 이후의 소스 변경만 빌드한다. 중간 배포 실행이 생략돼도 누락된 서비스 변경을 다음 실행에서 발견한다.
manifest·secret 버전·bootstrap 변경은 기존 digest로 재배포한다.
모든 이미지 push가 성공한 다음 dependency wave 순서로 migration과 rollout을 실행한다.
User와 Notification migration은 같은 이미지·인증·고정 설정을 가진 Job에서 실행한다.

ConfigMap과 SecretProviderClass는 내용 hash로 이름을 고정한다. 기존 Pod는 새 설정을 조용히 읽지 않는다.
Secret Manager 값은 읽거나 GitHub artifact에 저장하지 않는다. release artifact에는 SHA와 이미지 digest만 들어간다.
Pod readiness와 내부 smoke 및 두 Gateway의 HTTPS smoke가 성공한 후에만 마지막 성공 기록을 갱신한다.

## 실패를 복구한다

rollout이나 smoke가 실패하면 마지막 성공 resource snapshot을 다시 적용한다.
이 snapshot에는 이전 image, 설정 ConfigMap, SecretProviderClass 버전, bootstrap이 포함된다.
첫 배포 실패에는 성공한 predecessor가 없으므로 새 Deployment를 제거하고 성공 기록을 남기지 않는다.
이미 성공한 다른 서비스는 유지한다. 실패 서비스는 다음 실행에서 마지막 성공 SHA부터 다시 판단한다.
DB migration을 자동으로 되돌리지 않는다. migration은 구버전 앱과 호환되게 작성하고 데이터 복구는 별도 runbook을 따른다.

실패 진단 시 앱 로그나 Secret JSON을 Actions 출력에 복사하지 않는다.
내용 hash ConfigMap과 SecretProviderClass의 정리는 rollback 보존 기간 뒤에 운영자가 수행한다.
현재 Deployment와 마지막 성공 기록이 참조하는 리소스는 삭제하지 않는다.

## 검증한다

`node --test scripts/*.test.mjs`는 변경 선택, digest 승격, 권한 오류, migration·rollout 실패 복구를 검증한다.
실제 GKE 배포는 `gcloud`와 환경 자격증명이 있는 staging에서 별도로 실행한다.
로컬 모의 CLI 결과를 실제 클라우드 배포 성공으로 취급하지 않는다.

- [GitHub GCP 인증 Action](https://github.com/google-github-actions/auth).
- [GKE credentials Action](https://github.com/google-github-actions/get-gke-credentials).
