# 최초 AWS 배포: 저장소 연결과 파일 공급

기준: 2026-10-27. 이 문서는 코드/로컬 검증과 AWS 검증을 구분한다. AWS 리소스 생성,
Secret 변경, 실제 배포는 수행하지 않았다. [CD](./cd.md)의 Secret VersionId 고정·digest 승격·rollback은 그대로다.
최초 ECS Service 생성은 CD 범위 밖이며 정상 initial revision과 desiredCount >= 1이 먼저 필요하다.

## 설정 계약

모든 런타임 값은 `CD_RUNTIME_SECRETS_JSON[service]`의 **문자열** 값이다.
GitHub Environment의 `AWS_REGION`이 ECS 앱으로 자동 전달되는 것은 아니다.
서비스별 Secret에 Map/Notification의 AWS_REGION도 넣는다. 실제 값은 커밋/출력하지 않는다.

| 서비스 / 변수 | 기본값·필수 여부 | 로컬 / 운영 |
| --- | --- | --- |
| Map `CASSANDRA_MODE` | local | 운영은 keyspaces 필수 |
| Map `CASSANDRA_HOST` | 로컬 localhost | 운영 명시 필수, DNS만 입력(포트·URL·자격 증명 금지) |
| Map `CASSANDRA_PORT` | local:9042, keyspaces:9142 | Keyspaces는 9142만 허용 |
| Map `CASSANDRA_KEYSPACE` | 로컬 wgo_map | 운영 기존 keyspace 이름 필수 |
| Map `CASSANDRA_DATACENTER` | 로컬 datacenter1, Keyspaces AWS_REGION | 운영 지정 시 AWS_REGION과 같아야 함 |
| Map `AWS_REGION` | 없음 | Keyspaces 필수, 이 환경은 ap-northeast-2 |
| Map `CASSANDRA_CA_PATH` | 없음 | Keyspaces 필수, 읽을 수 있는 PEM CA 묶음 |
| User `DB_TLS_MODE` | disable | 운영 verify-full 필수; require/검증 우회 모드 없음 |
| User `DB_AUTH_MODE` | password | iam은 새 연결마다 ECS 자격 증명으로 토큰 발급; DB_PASSWORD 금지 |
| User `AWS_REGION` | 없음 | DB_AUTH_MODE=iam일 때 필수 |
| User `DB_TLS_CA_SOURCE` | file | file은 RDS CA 파일, system은 Node의 공개 신뢰 루트(Aurora Express) |
| User `DB_TLS_CA_PATH` | 없음 | verify-full + file일 때 필수; system 또는 disable과 함께 지정하면 오류 |
| Post `MONGODB_URI` | 로컬 replica set URI | 운영 TLS/CA/DB 계정은 아래 URI로 명시 |
| Post `ELASTICSEARCH_URL` | http://localhost:9200 | 운영 HTTPS + 인증서 SAN과 같은 DNS |
| Post `ELASTICSEARCH_API_KEY` | 없음 | 현재 인증된 ES 운영 연결에는 필수, encoded API key |
| Post `NODE_EXTRA_CA_CERTS` | 없음 | 사설 ES CA 파일 필수, Node 프로세스 시작 시 읽음 |
| Post `SEMANTIC_MODEL_PATH` | 로컬 .cache/models/Xenova/multilingual-e5-small; 이미지 /opt/wgo/models/e5 | 변경하면 해당 경로에 동일 검증 파일 공급 필수 |
| Post `SEMANTIC_ENABLED`, `SEMANTIC_MODEL_ENABLED` | false가 아니면 활성 | false로 끄면 유사도 검색 준비 완료가 아님 |
| Post `SEMANTIC_THRESHOLD` | 없음 | 평가된 값 필요; 없으면 추천 503, 인덱싱은 가능 |
| Notification `AWS_REGION` | 클라이언트 로컬 fallback ap-northeast-2 | 운영 명시 필수 |
| Notification `DYNAMODB_*_TABLE` | 로컬 notifications/push-subscriptions/notification-event-state | 운영 3개 실제 이름 모두 필수 |
| Notification `DYNAMODB_ENDPOINT` | 없음 | 로컬 예시 http://127.0.0.1:8002; 운영 금지 |
| 모든 Redis `REDIS_URL` | 서비스별 로컬 포트 | 운영 rediss + AUTH + 동일 이벤트 DB 지정 |

Notification 운영에서는 AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_DYNAMODB도 금지한다.
Map/Notification 운영에서는 AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
AWS_PROFILE을 넣지 않는다. 공유 credentials 파일도 이미지/볼륨에 넣지 않는다.
ECS가 제공하는 credential endpoint 환경변수는 SDK가 사용하므로 제거하지 않는다.
TLS 검증 우회 옵션(NODE_TLS_REJECT_UNAUTHORIZED=0, tlsInsecure, tlsAllowInvalidCertificates,
tlsAllowInvalidHostnames, rejectUnauthorized:false)을 사용하지 않는다.

### User Aurora Express IAM 인증

Aurora Express의 인터넷 액세스 게이트웨이는 IAM 인증 전용이며 사용자 VPC에 속하지 않는다.
이 구성을 유지하는 staging에서는 `DB_AUTH_MODE=iam`, `AWS_REGION`, 실제 `DB_HOST`,
`DB_USER`, `DB_NAME`, `DB_TLS_MODE=verify-full`, `DB_TLS_CA_SOURCE=system`을 지정한다.
`DB_PASSWORD`와 `DB_TLS_CA_PATH`는 제외한다. 일반 VPC RDS의 파일 CA 설정은 그대로 유지한다.

앱과 TypeORM migration은 동일한 password 콜백을 사용한다. pg가 새 연결을 열 때마다
AWS SDK Signer가 IAM 토큰을 생성하며 ECS 임시 자격 증명 갱신도 SDK가 처리한다.
15분짜리 토큰을 환경변수로 고정하거나 DB 연결 풀 시작 시 한 번만 발급하지 않는다.
DB 역할에는 `LOGIN`, `rds_iam`과 User 소유 DB/스키마에 필요한 권한만 부여한다.
User task role에는 해당 DB 사용자 ARN
`arn:aws:rds-db:<region>:<account>:dbuser:<cluster-resource-id>/<DB_USER>`에 대한
`rds-db:connect`가 필요하다. execution role이나 GitHub 배포 역할의 권한으로 대체되지 않는다.
기본 AWS 자격 증명 체인을 사용하며 정적 AWS 키를 Secret에 넣지 않는다.

컨테이너에서 실제 TLS·IAM 접속과 migration을 검증해야 배포 준비가 완료된다.
IAM 토큰 생성 성공만으로 `rds-db:connect` 권한이 검증되는 것은 아니다.

## 인증서 공급: 이미지에 개인키를 복사하지 않는다

이번 구성은 **인증서 볼륨을 런타임에 읽기 전용 마운트**한다. Docker build context에
인증서를 넣지 않으며 개인키/운영 비밀번호/토큰은 모델 다운로드에도 필요 없다.
파일 경로만 Secret에 지정해도 파일이 생기지 않는다. 배포 전에 실제 볼륨을 준비해야 한다.

준비 파일:

- `rds-global-bundle.pem`: [AWS RDS 공개 CA bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
  RDS와 DocumentDB가 사용하는 CA를 확인하고 공식 출처·지문·만료를 검토한다.
- `keyspaces-bundle.pem`: AmazonRootCA1–4와 전환기 Starfield 루트를
  [AWS Node 드라이버 안내](https://docs.aws.amazon.com/keyspaces/latest/devguide/using_nodejs_driver.html)에 따라 결합한다.
- `elasticsearch-ca.pem`: Private EC2 Elasticsearch HTTP 인증서를 서명한 공개 CA 체인.
  서버 인증서 SAN에 ELASTICSEARCH_URL의 DNS가 있어야 한다. 임의 IP/CNAME으로 바꿔 검증을 우회하지 않는다.
  ES 서버의 `http.p12`, CA 개인키, 서버 개인키는 앱에 전달하지 않는다.

예를 들어 사전 준비한 EFS Access Point의 **버전별 디렉터리**에 공개 CA 파일만 공급한다.
파일 0444/0644, 디렉터리 0555/0755로 `node` 사용자(이미지 UID 1000)가 읽고 탐색할 수 있어야 한다.
EFS는 이번 코드나 CD가 생성하지 않는다. 사용할 수 없다면 다른 사전 공급 볼륨 방식을 먼저 준비해야 한다.
Task Definition에 아래를 병합한다(실제 식별자로 교체). 앱 및 일회성 migration task가 같은 정의를 사용한다.

```json
{
  "volumes": [{
    "name": "storage-ca",
    "efsVolumeConfiguration": {
      "fileSystemId": "<filesystem-id>",
      "transitEncryption": "ENABLED",
      "authorizationConfig": {"accessPointId": "<versioned-access-point-id>", "iam": "ENABLED"}
    }
  }],
  "containerDefinitions": [{
    "name": "app",
    "mountPoints": [{"sourceVolume": "storage-ca", "containerPath": "/app/certs", "readOnly": true}]
  }]
}
```

기존 containerDefinitions를 교체하지 말고 mountPoints만 추가한다. healthCheck/image/ports/logs 유지.
EFS 사용 시 Fargate 지원 platform, mount target, SG 2049와 접근점 POSIX 권한을 검증한다.
Task Role에는 지정 filesystem/access point 조건의 `elasticfilesystem:ClientMount`만 추가한다.
ClientWrite/ClientRootAccess는 앱에 부여하지 않는다.

인증서 교체는 기존 파일을 덮어쓰지 않고 새 버전 디렉터리/접근점과 새 Task Definition으로 진행한다.
구·신 CA를 겹쳐 신뢰하는 기간을 두고 staging 연결 테스트 후 재배포한다. `NODE_EXTRA_CA_CERTS`는
프로세스 시작 시에만 읽으므로 파일 교체만으로 충분하지 않다. Secret/task-only 변경은 기존
CD_FORCE_SERVICES 절차를 따른다. 이전 이미지·Secret VersionId·인증서 볼륨 버전을 함께 보존해야 rollback된다.

User 앱과 TypeORM migration은 configuration().database.ssl의 같은 CA 검증 정책을 사용한다.
CA 누락/읽기 실패/잘못된 PEM은 연결 전에 설정 이름을 포함한 오류로 실패한다.
Post 이미지 진입점 `dist/start.js`도 extra CA와 URI의 tlsCAFile을 확인한 뒤 앱을 시작한다.
운영 CLI는 동일 환경/볼륨으로 실행하며, 필요 시 먼저 `node --input-type=module -e
"import('./dist/runtime-files.js').then(m=>m.validateRuntimeFiles())"`로 파일을 검사한다.

## Map / Keyspaces

두 클라이언트(CassandraLocationStore, PostIndex)는 같은 서비스 내부 설정을 사용한다.
`rebuild:posts`/`dist/rebuild-post-index.js`도 PostIndex를 생성하므로 같은 TLS/인증 설정이다.
로컬 초기화는 CI compose + schema.cql이고 앱에 자동 CREATE TABLE 경로는 없다.

`cassandra-driver` 4.8.0 + AWS 공식 `aws-sigv4-auth-cassandra-plugin` 1.0.5로 서명한다.
플러그인 1.0.5는 SDK v2에 의존하며 자체 credential lookup rejection을 callback에 전달하지 않는다.
작은 서비스 내부 어댑터가 SDK v3 defaultProvider를 보유하고 각 새 연결에서 조회한 최신 임시
자격 증명을 공식 플러그인에 전달한다. lookup 실패는 드라이버 callback으로 반환한다.
provider의 만료 갱신과 드라이버 기본 재연결 정책은 유지하며 자격 증명을 시작 시 고정하지 않는다.
v2는 공식 서명 플러그인의 전이 의존성으로 여전히 남아 있으므로 보안/지원 정책 검토가 필요하다.

Keyspaces는 읽기·쓰기를 LOCAL_QUORUM으로 설정한다. 상태 확인 직후 쓰기/삭제 흐름을 위해
읽기도 최신 성공 쓰기를 반영하도록 한다. SERIAL/LOCAL_SERIAL을 설정하지 않는다.
클라이언트 timestamp 생성을 끄고 서버 timestamp를 사용한다. LWT의 IF NOT EXISTS 및
IF status = ?는 그대로 보존한다. 자동 전체 재시도를 추가하지 않는다.
[consistency](https://docs.aws.amazon.com/keyspaces/latest/devguide/consistency.html),
[LWT](https://docs.aws.amazon.com/keyspaces/latest/devguide/lightweight_transactions.html).

주변 조회와 rebuild는 행 수가 아니라 pageState가 없어질 때까지 순회한다. 빈/짧은 페이지도
pageState가 있으면 계속한다. Keyspaces의 1MB 페이지 경계와 기존 요청 예산을 함께 적용한다.
실제 AWS 지연에서 250ms read timeout/500ms 검색 예산이 충분한지는 부하 검증 전까지 미확인이다.
[페이징 차이](https://docs.aws.amazon.com/keyspaces/latest/devguide/paginating-results.html).

이미 생성된 테이블 5개를 재생성하지 않는다. schema.cql은 로컬 전용(SimpleStrategy,
TimeWindowCompactionStrategy)이며 Keyspaces에 실행하지 않는다. 운영자 read-only schema 조회로 다음을 대조한다.

| 테이블 | 기대 키 / 운영 확인 |
| --- | --- |
| user_locations | user_id bigint PK; 레거시 테이블, 현재 latest 저장은 history 사용 |
| user_location_history | partition (user_id bigint, day_bucket date), clustering update_id timeuuid DESC; TTL 604800 및 TTL 기능 활성화 |
| post_locations | post_id text PK; event_id/author_id/좌표/radius_m/category/expires_at/cell/shard 타입 |
| post_status | post_id text PK, status text, occurred_at timestamp; LWT 경합 확인 |
| posts_by_cell | partition (cell text, shard int), clustering post_id text |

스키마 차이는 별도 검토된 Keyspaces DDL/관리 API로만 수정하고 ACTIVE 상태를 확인한다.
앱 Task Role에 CREATE/ALTER/DROP을 주지 않는다. 필요한 `cassandra:Select`, `Modify`를 이
keyspace의 다섯 table ARN으로 제한하고 드라이버 discovery용 system/system_schema/system_schema_mcs
메타데이터 테이블에는 Select만 허용한다. 적용할 실제 system table 목록은 접속 감사로 좁힌다.
Task Role 자격 증명 갱신 이후 새 연결, 네트워크 단절 복구, LWT 동시 ACTIVE→EXPIRED→DELETED,
1MB 초과 페이지, GEO 재구축을 AWS에서 확인한다.

## Post / DocumentDB와 ES

예시(비밀번호는 URL percent-encoding):

```text
MONGODB_URI=mongodb://<user>:<encoded-password>@<cluster-dns>:27017/wgo_post?tls=true&tlsCAFile=/app/certs/rds-global-bundle.pem&replicaSet=rs0&readPreference=primary&retryWrites=false
ELASTICSEARCH_URL=https://<certificate-san-dns>:9200
ELASTICSEARCH_API_KEY=<encoded-api-key>
NODE_EXTRA_CA_CERTS=/app/certs/elasticsearch-ca.pem
```

기존 Mongoose와 Node fetch가 각각 URI CA와 추가 신뢰 CA를 사용한다. 비즈니스 코드는 바꾸지 않았다.
클러스터 primary 연결과 트랜잭션을 검증한다. ES는 OpenSearch가 아니라 사용자 환경의 Elasticsearch
8.19.23이며 dense_vector(384, index:false), script_score cosineSimilarity, alias 전환 API를 검증한다.
API key는 대상 semantic 인덱스/별칭만 제한하고, 초기화/rebuild용 관리 권한은 운영 작업에만 부여한다.

**DocumentDB 엔진 버전은 미확인이다. 아래가 통과하기 전 Post 운영 배포를 차단한다.**

- 실제 major/patch와 query planner 버전을 기록한다. AWS 문서상 트랜잭션은 4.0+,
  retryable writes는 8.0.2+부터 지원되므로 버전 미확인 예시는 retryWrites=false를 유지한다.
  [트랜잭션](https://docs.aws.amazon.com/documentdb/latest/devguide/transactions.html),
  [재시도](https://docs.aws.amazon.com/documentdb/latest/devguide/retryable-writes.html).
- MongoosePostStore의 connection.transaction은 게시물/댓글/공감/카운터/Outbox를 함께 쓴다.
  1분 제한, 32MB 제한, 기존 collection 필요, transaction 내 cursor 제한, commit 결과 불명확/재시작
  경우를 실제 드라이버 9.0.0 Mongoose와 검증한다. 자동 commit retry를 무조건 안전하다고 가정하지 않는다.
- post.schemas.ts의 모든 collection/index를 먼저 생성하고 확인한다. 특히 댓글의
  `partialFilterExpression: {mutationId: {$type:'string'}}`은 AWS 문서의 지원 연산자에 포함되지 않는다.
  게시물·댓글 공감의 `{removedAt:null}` partial unique도 null/missing 동작과 재등록 경합을 검증한다.
  5.0 instance-based partial index 지원만으로 모든 조건의 호환성을 보장할 수 없다.
  [공식 partial index 지원 범위](https://docs.aws.amazon.com/documentdb/latest/devguide/partial-index.html).
- `$type`을 `$exists`로 임의 변경하거나 unique 인덱스를 생략하지 않는다. 대상 엔진에서 거부되면
  기존 데이터 분포와 동일한 멱등성/유일성을 보존하는 별도 마이그레이션을 설계한 뒤 배포한다.
- 생성·삭제·만료, 투표/공감 경합, duplicate-key 재시도, rollback 후 Outbox 없음, commit 후 이벤트 전달을 확인한다.

## 임베딩 파일과 준비 상태

Post Docker build는 기존 prepare-model.js를 실행해 고정 revision
`761b726dd34fb83930e26aab4e9ac3899aa1fa78`의 config.json, tokenizer_config.json,
tokenizer.json, onnx/model.onnx를 /opt/wgo/models/e5에 넣는다. JSON 정규화/ONNX 바이트 SHA-256은
model-artifacts.ts를 사용한다. 다운로드 실패/체크섬 불일치는 이미지 빌드 실패다.
빌드에 Hugging Face outbound가 필요하며 런타임 다운로드는 하지 않는다. 모델 파일을 수동으로 미리
준비할 필요는 없다. `.cache`는 여전히 build context에서 제외되며 운영 파일로 오인하지 않는다.

이미지의 node 사용자로 시작 전에 전체 파일 읽기/해시를 검사한다. 실제 모델 load/warm-up과
ready 상태는 기존 provider가 확인하며 실패하면 추천은 unavailable이다. 앱 liveness 성공이 모델
ready를 의미하지 않는다. 시작 검사 우회를 위해 ECS command를 dist/main.js로 바꾸지 않는다.
기존 로컬 dev는 변경하지 않는다. CPU 아키텍처별 ONNX 추론, 메모리/CPU, startup 시간을 별도로 측정한다.
`SEMANTIC_THRESHOLD`는 한국어 품질 평가 후에만 설정한다. 모델 활성화만으로 alias/backfill/threshold
완료가 되지는 않으며 semantic:init, backfill/rebuild, 추천 API 검증이 필요하다.

## Redis 이벤트 연결

node-redis와 ioredis 모두 rediss URL의 TLS·AUTH를 사용하며 TLS 검증 해제 옵션은 추가하지 않는다.
Gateway URL 오류에는 변수 이름만 출력한다. URL의 AUTH는 percent-encoding하고 로그에 전체 URL을 남기지 않는다.
노드 기반 ElastiCache의 **primary endpoint**, 클러스터 모드 비활성화, TLS/AUTH 설정을 사용한다.

| 경로 | endpoint/DB/stream 관계 |
| --- | --- |
| Post → Map/Notification/Moderation/WS/semantic | 모두 같은 endpoint와 논리 DB의 post:events. consumer group은 서비스별 유지 |
| Moderation → Post | Moderation REDIS_URL과 Post MODERATION_REDIS_URL 일치; MODERATION_EVENT_STREAM=moderation:events 일치 |
| User → User 이벤트 소비자 | user:events 생산자와 해당 소비자의 endpoint/DB 일치 |
| Gateway rate-limit / User session | 이벤트 DB와 꼭 같을 필요는 없지만 공용 Redis이면 키 namespace/ACL 유지 |

공용 Redis 예시 `rediss://:<encoded-auth-token>@<primary-endpoint>:6379/0`.
Map post-map, Notification post-notification, semantic 버전별 group 등 기존 그룹을 합치지 않는다.
논리 DB는 메모리/eviction 격리가 아니다. noeviction 등 운영 정책과 Stream 보존, DLQ, XAUTOCLAIM,
GEO/Lua 다중 키 명령, 장애 조치·재연결을 검증한다. 클러스터 모드로 전환하려면 별도 설계가 필요하다.

## IAM·최초 운영 검증 순서

1. Execution Role: ECR pull, 지정 CloudWatch logs, 서비스 Secret의 고정 VersionId 읽기,
   필요 시 해당 KMS decrypt. DB/Keyspaces/DynamoDB 앱 권한을 이 역할에 넣지 않는다.
2. Map Task Role: 위 Keyspaces 최소 CQL 권한. Notification Task Role: 지정 3개 table 및 필요한
   index ARN에 GetItem/PutItem/UpdateItem/DeleteItem/Query/Scan과 트랜잭션 구성 작업에 필요한 권한.
   TransactWriteItems는 그 구성 PutItem/UpdateItem/DeleteItem/ConditionCheckItem 권한을 검토한다.
   EFS 사용 서비스만 제한된 ClientMount를 추가한다. RDS/DocumentDB는 DB 사용자, Redis는 AUTH,
   ES는 API key를 사용하며 AWS 데이터 API 권한을 임의로 추가하지 않는다.
3. CA 볼륨 공급/권한·DNS·SG·NAT/VPC endpoints 확인. Keyspaces 9142, RDS 5432,
   DocumentDB 27017, Redis 6379, ES 9200은 해당 앱 SG에만 허용한다.
4. User 같은 이미지/환경으로 `node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js`.
   `pg_stat_ssl` 또는 서버 세션으로 TLS 연결 확인. 잘못된 CA/호스트로 실패하는지도 확인한다.
5. Keyspaces 기존 schema/TTL를 대조하고 LWT/읽기·쓰기/paging/credential rotation 검증.
6. DocumentDB 버전·컬렉션·인덱스 및 위 transaction 호환성 차단 조건 해소.
7. Notification 기존 테이블 키/GSI/TTL를 create-local-tables.mjs와 대조하되 그 스크립트를 운영에 실행하지 않는다.
   실제 SDK 기본 chain으로 알림/구독/이벤트 상태 transaction을 검증한다.
8. ES 인증·SAN·모델 warm-up·alias/backfill·평가된 threshold 확인 후 end-to-end 이벤트 smoke.
9. 초기 ECS Service 생성 후에만 기존 GitHub CD 시작. 내부 주소는 localhost 대신
   USER_SERVICE_URL=http://user-service:3001, POST_SERVICE_URL=http://post-service:3002,
   MAP_SERVICE_URL=http://map-service:3003, NOTIFICATION_SERVICE_URL=http://notification-service:3004,
   MODERATION_SERVICE_URL=http://moderation-service:3005, MAP_GRPC_ADDRESS=map-service:50051.
   Gateway HOST=0.0.0.0, User USER_GRPC_HOST=0.0.0.0. localhost는 같은 컨테이너 health check에만 사용한다.

AWS TLS handshake, IAM, CA 배포, 실제 Keyspaces schema, DocumentDB engine, 운영 추론 부하 및
threshold 품질은 로컬 단위 테스트/이미지 빌드로 검증 완료라고 표현하지 않는다.

## 이번 변경의 로컬 검증 기록

- Node 24.21.0에서 영향받은 5개 앱 typecheck/build 통과. 별도 lint script는 이 앱들에 정의되어 있지 않다.
- 루트 npm run format 및 format:check, git diff --check 통과. 무관한 포맷 변경 없음.
- User: 로컬 PostgreSQL/Redis 포함 226 통과, 1 skip. 최초 DB 미기동 실패 후 준비해 재실행했다.
  중간 실행의 기존 scheduler/user-lock 경합 테스트 1건은 401/201 불일치였고 개별 25개 및 전체 재실행은 통과했다.
- Map: 로컬 Cassandra/Redis 포함 86 통과. 신규 테스트는 TLS 설정/CA 누락/기본값/실제 Client 구성,
  SigV4 새 연결의 토큰 교체/credential 실패 callback을 확인한다. AWS IAM 갱신 통합 테스트는 아니다.
- Post: MongoDB/Cassandra/Redis/로컬 Elasticsearch 8.19.4 포함 169 통과, 11 skip.
  AWS DocumentDB 및 운영 Elasticsearch 8.19.23 HTTPS 검증으로 대체할 수 없다.
- Notification: 52 단위 테스트 + DynamoDB Local/Redis 통합 32 통과.
- HTTP Gateway: Redis 포함 52 통과. 변경 전 rediss 거부/HTTP Redis 허용 회귀 2건 실패를 재현했다.
- CD: AWS 없는 fake CLI/버전 고정/rollback 테스트 14 통과. workflow·CD 스크립트는 변경하지 않았다.
- Post 최종 Docker 이미지 빌드 통과(linux/arm64). network=none, UID 1000에서 모델 load/warm-up,
  한국어 입력 추론 성공: ready=true, dimensions=384, vector norm=1. ECS 부하·amd64 실행은 미검증.
- 기존 skip된 테스트(별도 모델 회귀·WS 등)의 전체 검증을 주장하지 않는다. 모델 이미지 smoke는 별도로 수행했다.

IAM 참고: [Keyspaces system-table 권한](https://docs.aws.amazon.com/keyspaces/latest/devguide/security_iam_service-with-iam.html).
드라이버 discovery에는 해당 계정/리전의 `arn:aws:cassandra:<region>:<account>:/keyspace/system*` Select가 필요하다.
인증서 볼륨 참고: [ECS/EFS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html),
Fargate Linux platform 1.4.0 이상과 접근점 권한을 확인한다.
