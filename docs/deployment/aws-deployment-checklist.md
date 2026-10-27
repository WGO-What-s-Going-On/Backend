# AWS ECS Fargate 배포 체크리스트

작성 기준: 2026-10-26, 현재 저장소의 CI/CD 및 서비스 구현.

이 문서는 AWS 인프라 최초 준비부터 애플리케이션 배포·검증까지의 실행 순서다. 체크박스는 실제 환경에서 확인한 뒤 표시한다. 문서 작성이 AWS 리소스 생성이나 배포 완료를 의미하지 않는다.

현재 CD는 기존 AWS 리소스에 애플리케이션을 배포한다. VPC, 저장소, ECR, ECS Service, IAM, ALB를 생성하지 않는다. 인프라 생성은 별도 작업이며, 환경별 재현이 가능하도록 Terraform·CloudFormation 등으로 관리하는 것을 권장한다.

- 배포 동작: [CD 운영 문서](./cd.md)
- GitHub Secret 이름·JSON 예시: [`.env.cd.example`](../../.env.cd.example)
- 실행 기준: [CD workflow](../../.github/workflows/cd.yml), [배포 스크립트](../../scripts/cd.mjs)

## 전체 순서

```text
환경·저장소 결정 → VPC·보안 그룹 → 저장소 생성
→ ECR·로그·Secret → IAM·OIDC → ECS·내부 DNS·ALB
→ 최초 이미지·스키마·서비스 기동 → GitHub Secrets 연결
→ main PR 병합 → staging 검증 → production 승인·검증
```

## 1. 배포 환경과 저장소 선택 확정

- [ ] AWS 계정과 리전을 결정한다. 예시 리전은 서울 `ap-northeast-2`다.
- [ ] staging과 production의 Cluster, DB 데이터, Redis, Secret, 도메인을 분리한다.
- [ ] 운영 환경의 가용 영역, Task 수, 저장소 고가용성·백업·복구 목표를 정한다.
- [ ] 비용 예산과 알림을 설정한다. NAT, ALB, 상시 실행 저장소 및 Fargate 비용을 포함한다.
- [ ] 아래 저장소 선택과 현재 코드의 호환성을 확인한다.

| 사용 서비스 | 현재 구현 | 준비할 항목 |
| --- | --- | --- |
| User | PostgreSQL | RDS PostgreSQL 등, 애플리케이션 사용자·DB·마이그레이션 |
| Post | MongoDB 트랜잭션 | Replica Set 지원 환경, 인덱스·연결 정책 |
| Map | Cassandra | keyspace·테이블, 드라이버·조건부 쓰기·페이징 호환성 |
| 이벤트 생산자·소비자 및 캐시 | Redis Streams·GEO·Lua | 지원 명령, TLS·인증, 보존·메모리·장애 복구 정책 |
| Notification | DynamoDB | 알림·구독·이벤트 처리 상태 테이블과 인덱스 |
| Post 유사도 검색 | Elasticsearch | 벡터 검색·mapping·alias 호환성 |
| Moderation | Redis 기반 이벤트 처리 | Post 이벤트 구독, Moderation 이벤트 발행, 외부 AI 연결 |

Notification은 현재 코드에서 DynamoDB를 사용한다. 과거 설계 문서만 보고 PostgreSQL을 준비하지 않는다. DynamoDB 구조는 [테이블 생성 스크립트](../../services/notification-service/scripts/create-local-tables.mjs)를 참고하되, 로컬 endpoint를 사용하는 스크립트를 검토 없이 운영에 실행하지 않는다.

DocumentDB·Keyspaces·OpenSearch는 각각 MongoDB·Cassandra·Elasticsearch의 주소만 바꾸는 대체재로 가정하지 않는다. 실제 사용하는 트랜잭션, 쿼리, 인증, TLS, 검색 API를 검증한 뒤 선택한다.

완료 기준: 환경별 저장소 제품과 연결·인증 방식이 결정돼 있다.

## 2. VPC와 외부 통신 경로 생성

- [ ] VPC와 DNS 설정을 준비한다.
- [ ] 서로 다른 가용 영역에 ALB용 Public Subnet을 준비한다.
- [ ] ECS Task용 Private Subnet과 DB용 Subnet Group을 준비한다.
- [ ] Internet Gateway와 라우팅 테이블을 구성한다.
- [ ] Private Task의 외부 API 접근을 위한 NAT 등의 outbound 경로를 준비한다.
- [ ] ECR, Secrets Manager, CloudWatch 등에 NAT 또는 필요한 VPC Endpoint로 접근 가능한지 확인한다.
- [ ] 카카오, FCM, AI API 등 AWS 외부 서비스 연결을 확인한다. AWS 전용 Endpoint만으로 이 통신을 대체하지 않는다.
- [ ] ECS Task의 Public IP 할당을 비활성화한다.

```text
사용자 → Route 53 → Public ALB(HTTPS)
                       → Private HTTP·WS Gateway
                            → Private 내부 서비스
                                 → DB·Redis·검색 저장소
```

완료 기준: 외부 진입은 ALB를 통하고, Task가 필요한 저장소·외부 API에 연결할 수 있다.

## 3. 서비스별 Security Group 구성

- [ ] ALB에 외부 HTTPS 443을 허용한다. HTTP를 열면 HTTPS로 전환한다.
- [ ] Gateway는 ALB SG에서 오는 해당 포트만 허용한다.
- [ ] 내부 서비스는 실제 호출자 SG에서 오는 포트만 허용한다.
- [ ] DB·Redis는 사용하는 서비스 SG에서만 접근하도록 제한한다.
- [ ] Service Connect를 사용한다면 실제 proxy ingress 포트도 SG와 일치시킨다.

| 대상 | 기본 포트 | 접근 주체 |
| --- | --- | --- |
| HTTP Gateway | 8080 | ALB |
| WS Gateway | 8081 | ALB |
| User | HTTP 3001 / gRPC 50052 | 해당 API를 호출하는 Gateway·내부 서비스 |
| Post | HTTP 3002 | 해당 API를 호출하는 Gateway·내부 서비스 |
| Map | HTTP 3003 / gRPC 50051 | 해당 API를 호출하는 Gateway·Post |
| Notification | HTTP 3004 | 필요한 내부 호출자 |
| Moderation | HTTP 3005 | 필요한 내부 호출자 |

Task Role은 AWS API 권한이고 SG는 네트워크 접근 제어다. SG로 연결을 제한해도 기존 사용자 JWT·서비스 간 인증 검증은 유지한다. Task IP를 고정 식별자로 사용하지 않는다.

## 4. 저장소 생성과 런타임 연결 검증

- [ ] 환경별 저장소와 애플리케이션 전용 계정·접근 권한을 준비한다.
- [ ] MongoDB 트랜잭션과 Replica Set 연결을 검증한다.
- [ ] Map의 [Cassandra schema](../../services/map-service/schema.cql)를 선택한 저장소에 맞춰 검토한다.
- [ ] DynamoDB 테이블·인덱스·TTL 설정과 애플리케이션의 기대 구조를 일치시킨다.
- [ ] Elasticsearch mapping·alias 초기화를 준비한다.
- [ ] 실제 운영 TLS·인증 정책으로 연결 테스트를 한다. 현재 PostgreSQL·Cassandra 설정에 필요한 연결 옵션이 없다면 배포 전 보강한다.
- [ ] Redis 생산자·소비자의 endpoint, 논리 DB, Stream 이름을 일치시킨다.
- [ ] Redis 토폴로지와 클라이언트·다중 키 Lua 호환성을 확인한다. Cluster 구성을 주소 교체만으로 적용하지 않는다.
- [ ] 캐시 eviction이 이벤트 Stream과 처리 상태를 제거하지 않도록 저장소 분리 또는 적절한 메모리 정책을 정한다.
- [ ] 백업·보존 기간과 복구 절차를 마련한다.

Post의 `post:events`를 읽는 Map·Notification·Moderation·WS는 해당 생산자의 Stream에 접근해야 한다. Post의 `MODERATION_REDIS_URL`은 Moderation 발행 endpoint와 맞춘다. 로컬 서비스별 Redis 포트를 운영에서도 독립 저장소로 그대로 옮기면 이벤트가 연결되지 않을 수 있다.

## 5. ECR·CloudWatch·Secrets Manager 생성

- [ ] 아래 서비스별 ECR Repository를 생성한다.
- [ ] 환경·서비스별 CloudWatch Log Group과 보존 기간을 설정한다.
- [ ] 환경·서비스별 Secrets Manager Secret을 생성하고 ARN을 기록한다.
- [ ] CD 성공 상태를 저장할 SSM 경로를 정한다. 예: `/wgo/deployments`.

```text
wgo/user-service
wgo/map-service
wgo/post-service
wgo/notification-service
wgo/moderation-service
wgo/http-gateway
wgo/ws-gateway
```

현재 CD에서는 staging과 production이 같은 ECR registry·region·repository 이름을 사용한다. 별도 계정에서 이미지를 가져오면 ECR repository policy와 execution role의 cross-account pull 권한도 필요하다.

SSM 경로는 이름 prefix이며 별도 폴더 생성 작업은 없다. 최초 서비스별 Parameter는 없어도 되지만, 조회·쓰기 권한은 필요하다.

## 6. IAM 역할과 GitHub OIDC 연결

| 역할 | 필요한 권한 범위 |
| --- | --- |
| GitHub Deploy Role | ECR push, ECS describe/register/update/run/stop, 제한된 역할의 PassRole, 서비스 Secret 갱신, SSM 배포 상태 조회·저장 |
| ECS Task Execution Role | ECR pull, CloudWatch 로그 전송, 참조 Secret 읽기, 필요한 KMS decrypt |
| 서비스별 ECS Task Role | 애플리케이션이 직접 사용하는 AWS API. 예: Notification의 지정 DynamoDB 테이블 접근 |

- [ ] GitHub OIDC Provider를 IAM에 등록한다.
- [ ] staging과 production Deploy Role을 분리한다.
- [ ] trust policy의 `aud`를 `sts.amazonaws.com`으로 제한한다.
- [ ] `sub`를 아래 환경별 값으로 제한한다.
- [ ] 각 역할의 리소스 범위를 서비스·환경에 맞게 제한한다.
- [ ] 장기 AWS Access Key 대신 workflow의 OIDC 인증을 사용한다.

```text
repo:WGO-What-s-Going-On/Backend:environment:staging
repo:WGO-What-s-Going-On/Backend:environment:production
```

## 7. ECS·서비스 탐색·ALB 구성

- [ ] `wgo-staging`, `wgo-production` 등 환경별 Cluster를 만든다.
- [ ] 애플리케이션별 Task Definition과 ECS Service 설정을 준비한다.
- [ ] Fargate, `awsvpc`, Linux, 이미지와 같은 CPU 아키텍처를 지정한다.
- [ ] CPU·메모리, IAM 역할, healthCheck, portMappings, awslogs를 설정한다.
- [ ] 내부 DNS를 준비한다. Service Connect를 사용하면 namespace, 이름 있는 portMappings, client/server 설정을 구성한다.
- [ ] 서비스 주소 환경변수를 내부 DNS로 설정한다. 예: `MAP_GRPC_ADDRESS=map-service:50051`.
- [ ] Gateway `HOST`, User gRPC bind 주소 등을 컨테이너 외부에서 접근 가능한 값으로 설정한다.
- [ ] ACM 인증서와 ALB HTTPS Listener를 생성한다.
- [ ] HTTP·WS Gateway별 IP 타입 Target Group과 라우팅 규칙을 만든다.
- [ ] Route 53 레코드를 ALB에 연결한다.
- [ ] 컨테이너 health check와 ALB health check를 실제 제공 경로에 맞춘다.
- [ ] WS heartbeat, ALB idle timeout, 배포 시 연결 drain·재접속을 검증한다.

Post는 임베딩 모델을 실행하므로 메모리·CPU·시작 시간을 별도로 측정한다. 현재 [Post Dockerfile](../../services/post-service/Dockerfile)은 모델 파일을 복사하지 않는다. 모델을 활성화하려면 이미지 포함 또는 시작 전 모델 공급 방식을 준비하고 `SEMANTIC_MODEL_PATH`, 파일 권한, 실제 추론 성공을 검증해야 한다. 모델 비활성화를 선택하면 유사도 검색을 정상 제공하는 배포로 간주하지 않는다.

## 8. 최초 이미지·스키마·서비스 기동

현재 CD는 ECS 서비스를 처음 만들지 않는다. 실행 시 기존 서비스가 `ACTIVE`, deployment controller가 `ECS`, `desiredCount >= 1`이어야 하며 진행 중인 deployment가 있으면 중단한다. `desiredCount=0` 서비스만 만들고 CD에 최초 기동을 맡기지 않는다.

- [ ] 배포할 커밋과 `CD_IMAGE_PLATFORM`을 확정한다.
- [ ] 서비스 이미지를 빌드해 ECR에 push하고 digest를 기록한다.
- [ ] 서비스별 Secret에 초기 런타임 값을 등록하고 Task Definition에 참조를 설정한다.
- [ ] DB 마이그레이션·Cassandra schema·DynamoDB 테이블·검색 인덱스를 먼저 준비한다.
- [ ] 필요하면 준비된 Task Definition으로 VPC 내 일회성 migration task를 실행한다. 최초에는 CD 밖에서 수행한다.
- [ ] 준비된 이미지와 Task Definition으로 ECS Service를 생성하고 최초 정상 기동을 확인한다.
- [ ] staging·production 모두 초기 서비스 상태를 준비한다. 공개 트래픽 연결은 검증 후 진행한다.

현재 CD의 서비스 처리 순서:

```text
User → Map → Post → Notification → Moderation → HTTP Gateway → WS Gateway
```

최초 정상 revision이 없으면 CD의 rollback 대상도 정상이라는 보장이 없다. 임시 이미지가 실행된다는 이유만으로 애플리케이션 준비 완료로 판단하지 않는다.

## 9. GitHub Environment와 Secrets 등록

- [ ] GitHub `staging`, `production` Environment를 확인한다.
- [ ] 두 환경의 deployment branch를 `main`으로 제한한다.
- [ ] production required reviewers를 지정한다.
- [ ] main 보호 규칙에 PR 병합·최종 `ci` 체크·최신 main 반영을 요구한다.
- [ ] 아래 Secret을 각 Environment에 등록한다.

| Secret | 내용 |
| --- | --- |
| `AWS_REGION` | AWS 리전 |
| `AWS_ACCOUNT_ID` | 대상 계정 |
| `AWS_ROLE_ARN` | 환경별 GitHub Deploy Role |
| `ECR_REGISTRY` | 공유 이미지 registry |
| `ECS_CLUSTER` | 환경별 Cluster |
| `CD_IMAGE_PLATFORM` | 예: `linux/amd64` |
| `CD_STATE_PREFIX` | 예: `/wgo/deployments` |
| `CD_SERVICES_JSON` | 서비스별 ECR·ECS·Task Definition·Secret ARN·migration/smoke 설정 |
| `CD_RUNTIME_SECRETS_JSON` | 서비스별 런타임 환경변수 JSON. 모든 값은 문자열 |
| `CD_FORCE_SERVICES` | 선택적 강제 배포 서비스 목록 또는 `all` |

- [ ] 두 환경의 서비스 이름 집합과 ECR 구성을 일치시킨다.
- [ ] 모든 서비스에 `NODE_ENV=production`을 설정한다.
- [ ] User·HTTP Gateway·WS Gateway의 `JWT_ACCESS_SECRET`, issuer, audience를 맞춘다.
- [ ] 서비스 간 ES256 서명키·공개키 계약을 별도로 맞춘다. 사용자 Access JWT 키와 재사용하지 않는다.
- [ ] 카카오 callback, CORS, WS allowed origins를 실제 도메인으로 바꾼다.
- [ ] Notification의 로컬 `DYNAMODB_ENDPOINT`를 운영 설정에서 제거한다.
- [ ] Post 유사도 threshold·모델 설정과 Moderation consumer 활성화 여부를 결정한다.
- [ ] Secret JSON에 예시 문자열·localhost·개발용 키가 남아 있지 않은지 확인한다.

값의 전달 경로는 GitHub Secrets → CD의 Secrets Manager 새 버전 저장 → VersionId가 고정된 ECS 환경변수 주입이다. 실제 값을 저장한 `.env`나 JSON 파일은 커밋하지 않는다. 이전 Secret 버전은 rollback에 필요하다.

## 10. main PR 병합과 staging 배포

- [ ] 배포 대상 변경을 dev에 반영하고 `dev → main` 릴리스 PR을 만든다.
- [ ] 필수 CI가 성공했는지 확인한 뒤 main에 병합한다.
- [ ] CD가 정확한 병합 SHA를 사용하고 staging job을 시작하는지 확인한다.
- [ ] 이미지 push → Secret 갱신 → 선택적 migration → ECS update → 안정화 → 선택적 smoke → SSM 성공 상태 기록 순서를 확인한다.
- [ ] 실행의 `release.json`에 서비스별 image digest가 남는지 확인한다.
- [ ] 아래 비즈니스 검증을 통과하기 전 production 배포를 승인하지 않는다.

단순 push, dev 병합, PR 닫기만으로 CD는 실행되지 않는다. 현재 workflow에는 수동 신규 실행용 `workflow_dispatch`도 없다. Secret·Task 설정만 변경했을 때는 두 환경에 같은 `CD_FORCE_SERVICES`를 설정하고 main으로 변경 안내 PR을 병합한 뒤, 성공 후 값을 비운다.

## 11. staging 비즈니스 검증 후 production 승인

- [ ] 실제 로그인·토큰 갱신·HTTP 인증을 검증한다.
- [ ] 사용자 위치 갱신과 게시물 생성·조회·참여를 검증한다.
- [ ] Post Outbox → Redis Stream → Map Consumer → GEO·Cell 반영을 확인한다.
- [ ] 삭제·만료 후 GEO·Cell 정리와 검색 제외를 확인한다.
- [ ] WS 연결 인증·Room 인가·댓글·삭제/만료 알림을 확인한다.
- [ ] 실제 E5 모델을 활성화했다면 추론·유사도 검색을 검증한다.
- [ ] 활성화한 Notification·Moderation 외부 연동을 검증한다.
- [ ] Pending·재시도·DLQ와 관련 오류 로그를 확인한다.
- [ ] 기존 데이터가 있는 Map은 필요 시 `rebuild:posts`를 VPC 내 운영 작업으로 실행하고 결과를 확인한다.
- [ ] production Environment를 승인한다.
- [ ] production이 staging과 동일 image digest를 사용하고 목표 revision으로 안정화됐는지 확인한다.
- [ ] production 도메인에서 핵심 동작을 다시 검증한다.

health check 성공만으로 로그인·WS·모델·이벤트 흐름까지 검증됐다고 판단하지 않는다. 자동 검증을 원하면 `smokeUrl` 또는 `smokeCommand`를 설정한다. Private 서비스 검증에는 VPC 내 `smokeCommand`를 사용한다.

## 12. 운영 관측과 실패 복구

- [ ] ECS Task 재시작·CPU·메모리, ALB 오류율·지연, 저장소 연결 실패 알람을 설정한다.
- [ ] Consumer Pending·처리 지연·재시도·DLQ 증가를 감지하는 로그/지표와 알림 경로를 연결한다.
- [ ] WS 롤링 배포 후 재연결·재인가·재참여를 확인한다.
- [ ] 배포 SHA, image digest, Task Definition revision, migration 결과를 기록한다.
- [ ] 이전 이미지·Task Definition·Secret 버전을 보존한다.

| 실패 지점 | 확인·복구 순서 |
| --- | --- |
| OIDC / ECR / Secret 권한 | trust 조건, 역할 정책, ARN, 네트워크 확인 |
| Task 시작 실패 | ECS stopped reason, CloudWatch 로그, 이미지·Secret·포트·모델 경로 확인 |
| Migration 실패 | 서비스 업데이트 이전 중단 여부 확인, 데이터 상태 확인 후 재실행 |
| ECS 안정화·smoke 실패 | 이전 Task Definition 복구 여부와 실제 실행 revision 확인 |
| production 실패 | staging artifact가 남아 있는 실행에서 `Re-run failed jobs` 검토 |
| 이벤트 처리 실패 | 원인 복구 후 기존 Pending·DLQ 운영 절차로 재처리 |

애플리케이션 rollback은 DB rollback이 아니다. 여러 서비스의 배포도 전체 원자적 rollback이 아니므로, 먼저 성공한 서비스가 남은 상태에서 계약 호환성을 확인한다. 과거 커밋을 다시 배포하기보다 변경을 되돌리는 새 PR을 CI 검증 후 main에 병합하는 경로를 사용한다.

## 최초 배포 전 아직 결정·검증할 항목

- [ ] 운영 저장소 제품과 PostgreSQL·Cassandra TLS/인증 연결 방식
- [ ] E5 모델 공급 방식과 Post Task 자원 크기
- [ ] Redis 이벤트 연결·보존·클러스터 호환성
- [ ] 실제 AWS 환경의 초기 기동, 다중 Task, WS 재접속, 장애 복구

로컬의 실제 저장소 통합 테스트 통과와 AWS 운영 검증은 구분한다. 한국 내 검색 좌표와 최대 반경 350m에서는 Redis GEO 극지방 경계 문제가 발생하지 않지만, 글로벌 좌표를 허용한다면 해당 검색 누락은 별도 후속 수정 대상이다.

## 공식 참고 자료

- [Fargate outbound 네트워크](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/networking-outbound.html)
- [ECS Service Connect](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html)
- [GitHub Actions AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [Keyspaces와 Cassandra 차이](https://docs.aws.amazon.com/keyspaces/latest/devguide/functional-differences.html)
- [ECS 배포 circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html)
