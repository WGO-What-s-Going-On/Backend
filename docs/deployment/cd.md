# ECS Fargate 서비스별 배포

최초 AWS 인프라 준비와 환경별 배포 실행 순서는 [AWS 배포 체크리스트](./aws-deployment-checklist.md)를 따른다.

이 구현은 **이미 생성된 AWS 인프라에 애플리케이션을 배포**한다. VPC·DB·ECS·ECR·IAM·ALB를
생성하지 않는다. 실제 AWS 호출이나 배포는 로컬 구현 검증에서 실행하지 않는다.

## GitHub 설정

전체 Secret 이름·형식·환경별 범위는 루트 [`.env.cd.example`](../../.env.cd.example)에 있다.
실제 값을 채운 파일을 커밋하지 말고 GitHub Secrets에 직접 등록한다.

- `staging`, `production` Environment Secrets: `AWS_REGION`, `AWS_ACCOUNT_ID`, `AWS_ROLE_ARN`,
  `ECR_REGISTRY`, `ECS_CLUSTER`, `CD_IMAGE_PLATFORM`, `CD_STATE_PREFIX`, `CD_SERVICES_JSON`,
  `CD_RUNTIME_SECRETS_JSON`.
- 두 Environment 모두 배포 브랜치를 `main`으로 제한한다. `production`에는 required reviewers를
  설정한다. YAML의 `environment: production` 자체는 승인자를 생성하지 않는다.
- 배포 대상 서비스 이름 집합과 ECR registry/region/repository 이름은 두 환경에서 같아야 한다.
  Production은 staging에서 만든 동일 digest를 pull한다. 다른 AWS 계정이면 ECR repository policy와
  task execution role의 cross-account pull 권한을 구성한다.
- main Ruleset/branch protection에서 PR 병합과 `ci` 체크 성공을 필수로 지정하고 최신 main 반영을 요구한다.
  이 설정은 저장소 코드가 자동으로 생성하지 않는다. CD에서 push CI 성공을 재조회하지 않는다.
- Secret/task definition만 바꿀 때는 선택적으로 `CD_FORCE_SERVICES` Secret에 서비스 이름 목록 또는
  `all`을 설정하고 main으로 변경 안내 PR을 병합한다. staging/production에 같은 값을 적용하고
  배포 성공 후 비운다. 수동 신규 실행은 없으며 실패한 기존 실행은 GitHub에서 재실행할 수 있다.

## 파이프라인 흐름

1. **main 브랜치의 `push` 이벤트**로 배포한다. PR 병합도 main push를 발생시킨다.
   dev push, 태그 push, PR 닫기만으로는 실행되지 않으며 수동 신규 실행도 지원하지 않는다.
   checkout 전에 push 이벤트·main ref·대상 저장소·브랜치 삭제 여부·SHA 일치를 검사한다.
   checkout, `CD_SHA`, release artifact 이름 모두 실행 시점의 `github.sha`로 고정한다.
   저장소 기본 브랜치가 dev여도 실행 ref는 main이므로 Environment의 main 제한과 일치한다.
   직접 main push도 트리거되므로 **PR·필수 ci·최신 main 반영을 요구하고 우회를 제한하는
   main 보호 규칙**이 필요하다. CD 자체는 PR 병합 여부나 CI 성공을 재조회하지 않는다.
   CI는 기존처럼 PR 단계에서만 실행한다.
2. staging에서 서비스별 SSM 마지막 성공 SHA와 현재 SHA의 런타임 변경을 비교한다.
   테스트·문서만 변경되면 이미지를 다시 만들지 않는다. 누락된 state는 최초 배포로 간주한다.
   권한/네트워크 오류를 state 없음으로 처리하지 않는다. 삭제되거나 유효하지 않은 과거 Git SHA는
   배포를 중단하므로 히스토리 rewrite를 피하고 state 복구를 검토한다.
3. 변경 이미지를 ECR에 push하고 digest를 고정한다. 서비스 순서는 User→Map→Post→Notification→
   Moderation→HTTP Gateway→WS Gateway다. 호환되지 않는 계약은 별도 단계적 릴리스가 필요하다.
4. 서비스의 런타임 값은 GitHub Secret JSON에서 Secrets Manager의 기존 서비스 전용 Secret에 저장한다.
   Task definition은 JSON key와 **VersionId를 고정한 참조**만 가진다. plaintext 런타임 값은
   task definition·Docker layer·artifact에 넣지 않는다. 구 버전 Secret을 삭제하면 rollback이 불가능하다.
5. 선택적으로 migration Fargate task를 한 번 실행한다. 성공 후 서비스 revision을 갱신하고 ECS
   circuit breaker/rollback을 활성화한다. 안정화 확인 시 **목표 revision이 실제 COMPLETED인지**도 검사한다.
   `services-stable`만 통과한 자동 rollback을 성공 배포로 기록하지 않는다.
6. 선택적 HTTPS smoke와 VPC 내 일회성 `smokeCommand`를 실행한 후에만 SSM 성공 상태를 갱신한다.
   서비스별 ECS container healthCheck는 필수다. 비즈니스 smoke를 설정하지 않으면 readiness 수준을
   넘어 인증·WS 실제 동작까지 배포 후 확인한 것은 아니다. CI의 인증/위치 통합 테스트도 유지한다.
7. 같은 workflow 실행의 release artifact만 production에 전달한다. artifact에는 SHA·서비스 이름·
   image digest만 있으며 배포 설정/런타임 secret은 없다. Production은 이미지를 다시 빌드하지 않는다.
   staging에서 변경되지 않은 서비스도 release에 포함해 이전 production 실패로 미반영된 이미지를 따라잡는다.
8. 전체 CD workflow는 취소하지 않고 직렬화한다. 대기 실행이 새 실행으로 대체되어도 서비스별 마지막
   성공 SHA를 기준으로 다음 실행이 누락 변경을 포함한다. 과거/분기된 SHA로 되돌아가는 자동 배포는 거부한다.

## AWS 사전 준비

- 기존 ECR repositories, ECS rolling (`ECS` controller) Fargate services, desiredCount >= 1.
  서비스별 task definition JSON과 app healthCheck는 Secret으로 제공한다. 컨테이너 CPU 아키텍처는
  `CD_IMAGE_PLATFORM`과 일치해야 한다. Task definition family, IAM roles, 로그 그룹 등은 실제 값을 사용한다.
- User/Post/Map/Notification/Moderation과 저장소는 사설 네트워크. Gateway만 ALB 등 외부 진입점에 연결한다.
  내부 서비스 DNS, HTTP/gRPC 포트, TLS와 보안 그룹을 구성한다. Gateway의 HOST는 `0.0.0.0`으로 설정한다.
- Task execution role: ECR pull, CloudWatch logs, 서비스 전용 Secret 조회 및 필요 시 KMS decrypt.
- GitHub OIDC role: ECR push(주로 staging), ECS describe/register/update/run/wait/stop에 필요한 권한,
  제한된 task/execution role의 `iam:PassRole`, 해당 Secret의 `PutSecretValue`, 해당 SSM prefix의
  `GetParameters`/`PutParameter`. `GetParameters`는 ARN path별 권한을 부여한다.
  OIDC trust의 `aud=sts.amazonaws.com` 및 `sub=repo:ORG/REPO:environment:staging|production`을 제한한다.
- Application task role은 배포 역할과 분리한다. 애플리케이션이 직접 필요한 AWS 권한만 부여한다.
- Secrets Manager secret은 서비스·환경별로 별도 생성한다. 실행 역할이 참조된 모든 VersionId를 읽을 수 있어야 한다.
- NAT/VPC endpoints 또는 적절한 네트워크 경로로 ECR·Secrets Manager·CloudWatch 및 외부 OAuth에 접근한다.
- DB/Redis는 배포 파이프라인이 생성·삭제하지 않는다. MongoDB transaction 및 Cassandra 기능은 현재
  드라이버/구현과 실제 선택한 AWS 저장소의 호환성을 먼저 검증한다.

## 마이그레이션과 실패 복구

`migrationCommand`/`smokeCommand`는 shell 문자열이 아닌 argv 배열이며 해당 app image 안에서 실행한다.
기존 ECS 서비스의 awsvpc 네트워크 설정을 사용한다. User TypeORM 예시는 `.env.cd.example`에 있다.
스키마 명령은 독립적·멱등적이어야 하고, 신·구 버전이 공존하는 expand/contract 절차를 따른다.
마이그레이션 실패 시 service update를 실행하지 않는다. 앱 rollback은 DB rollback을 의미하지 않는다.

안정화·smoke·상태 기록 실패 시 이전 task definition으로 복구하고 마지막 성공 SSM state는 유지한다.
최초 배포에도 기존 서비스가 필요하지만 최초 정상 릴리스가 없는 경우 복구 대상이 정상이라는 보장은 없다.
실패한 task의 CloudWatch 로그와 ECS events를 확인하고 수정 후 같은 SHA 재실행 또는 새 CI 성공으로 재시도한다.
Production 실패 후 `Re-run failed jobs`는 기존 staging release artifact를 다시 사용한다.
`Re-run all jobs`는 같은 SHA 이름의 artifact를 명시적으로 교체해 upload-artifact v4 충돌을 피한다.
실패 이전에 성공한 서비스는 유지되므로 여러 서비스가 함께 실패하면 전체 원자적 rollback이라고 가정하지 않는다.

WS 롤링 배포 중 기존 소켓은 새 task로 이전되지 않는다. 클라이언트 재연결·재인가·재참여가 필요하다.
WS 사용자 토큰 알고리즘 불일치 등 남은 운영 공개 차단 이슈를 배포 성공만으로 해제하지 않는다.

## 로컬 검증

`node --test scripts/cd*.test.mjs`는 AWS 호출 없이 secret 비노출, digest 고정, 버전 고정,
필수 healthCheck, 아키텍처 및 release 유효성을 검증한다. Fake AWS/docker CLI를 사용하는
별도 프로세스 테스트는 smoke 이전 state 갱신 방지, 자동 rollback 판별, smoke 실패 복구,
SSM 권한 오류, production 미반영 배포 따라잡기와 강제 Secret 회전을 검증한다. CI도 `scripts/*.test.mjs`를 실행한다.
`actionlint .github/workflows/cd.yml`로 workflow 문법을 검증한다. 실제 배포 검증은 Secrets와 사전 인프라
설정 후 staging에서 진행해야 한다.

참고: [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[AWS ECS update-service](https://docs.aws.amazon.com/cli/latest/reference/ecs/update-service.html),
[ECS 배포 circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).

트리거 기준: [GitHub의 push 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).

전환 시 변경된 workflow를 main에 반영해야 한다. 기존 pull_request_target 실패 실행을 재실행해도
새 트리거로 바뀌지 않는다. 반영 후 생성된 push 실행에서 staging과 production을 검증한다.

## 운영 저장소 및 파일 공급

[최초 AWS 저장소 연결](./aws-storage.md)의 변수 표·CA 읽기 전용 볼륨·모델 이미지·IAM·검증 차단 조건을 따른다.
Post 모델 다운로드는 기존 Docker build 내부에서 고정 revision/체크섬으로 수행하며 runtime Secret을 빌드에 전달하지 않는다.
인증서는 기존 Task Definition volumes/mountPoints로 공급하고 새 버전 경로를 사용한다.
Secret VersionId 고정·rollback·production 동일 digest 승격과 최초 ECS Service 생성 제외 범위는 변경하지 않는다.
