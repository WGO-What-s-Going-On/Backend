# GKE 개발 저장소 초기화와 복구

MongoDB·Redis·Cassandra를 각각 단일 StatefulSet과 독립 PVC로 운영한다.
Elasticsearch 8.19.4는 ECK로 관리한다. 단일 노드는 고가용성이 아니며 노드 교체 중 중단이 발생한다.
모든 저장소 Service는 내부 headless Service이고 TLS와 인증을 요구한다.
`storageResources(config)`는 operator가 처음 적용할 저장소 리소스를 반환한다.
앱 CD마다 저장소와 초기화 Job을 다시 적용하지 않는다.

## 새 저장소를 준비한다

1. GKE namespace와 Secret Manager·Cloud SQL 인프라를 먼저 준비하고 Backup for GKE addon을 활성화한다. ProtectedApplication CRD가 설치되어야 저장소 manifest를 적용할 수 있다.
2. 검토한 ECK operator와 CRD를 `elastic-system`에 설치한다. Autopilot에서 privileged init container를 추가하지 않는다.
3. 아래 명령으로 private material을 저장소 밖에서 만들고 Kubernetes Secret에 넣는다. OpenSSL과 JDK의 keytool이 필요하다.

```sh
bash scripts/gcp-storage-secrets.sh wgo-demo /secure/wgo-demo-storage
```

이미 `wgo-storage-credentials`가 있으면 명령은 중단한다. 복원 후 새 비밀번호를 생성하지 않는다.
90일 server 인증서는 만료 전에 동일 CA로 재발급하고 각 DB를 순차 재시작한다.
CA 자체 교체 시 앱과 서버에 old/new CA를 함께 배포한 후 이전 CA를 제거한다.
개발용 CA private key는 암호화된 제한 접근 저장소에 보관한다. 일반 Git과 CI artifact에는 올리지 않는다.

4. 앱별 Secret Manager JSON에 아래 연결값과 생성한 각 비밀번호를 넣는다. 파일의 값을 CI 로그에 출력하지 않는다.

| 서비스 | 연결값 |
| --- | --- |
| Post MongoDB | `mongodb://wgo_post:PASSWORD@mongodb-0.mongodb:27017/wgo_post?authSource=wgo_post&replicaSet=rs0&tls=true&tlsCAFile=/app/certs/mongodb-ca.pem` |
| Redis 참여 앱 | `rediss://:PASSWORD@redis:6379/0` |
| Map Cassandra | `CASSANDRA_MODE=direct`, `CASSANDRA_CONTACT_POINTS=cassandra`, `CASSANDRA_DATACENTER=datacenter1`, `CASSANDRA_USERNAME=wgo_map`, `CASSANDRA_PASSWORD=PASSWORD`, `CASSANDRA_TLS_MODE=verify-full`, `CASSANDRA_CA_PATH=/app/certs/cassandra-ca.pem`, `CASSANDRA_TLS_SERVER_NAME=cassandra` |
| Post Elasticsearch | `ELASTICSEARCH_URL=https://elasticsearch-es-http:9200`, 발급한 `ELASTICSEARCH_API_KEY` |

`NODE_EXTRA_CA_CERTS`는 앱 bootstrap이 준비한 Redis CA를 가리킨다. Post는 Redis CA와 ECK CA를 합친 trust bundle을 사용한다.
공유 Redis의 stream 이름과 namespace를 유지한다. Post `MODERATION_REDIS_URL`도 같은 Redis DB를 명시한다.
MongoDB·Redis·Cassandra private key는 앱 mount 대상이 아니다. `wgo-storage-tls`에는 공개 CA만 있다.

5. 렌더링한 저장소 리소스를 적용한다. MongoDB는 localhost exception으로 처음 한 번 `rs0`와 root·wgo_post 사용자를 만든다.
6. Cassandra는 관리자 비밀번호를 바꾸고 `schema.cql` 및 `wgo_map` 제한 권한을 생성한다. 기존 사용자 비밀번호를 임의 갱신하지 않는다.
7. 세 StatefulSet과 ECK가 준비되면 `bash scripts/gcp-storage-smoke.sh wgo-demo`를 실행한다.

MongoDB는 모든 데이터와 journal을 `/data/db`, Redis는 AOF와 RDB를 `/data`, Cassandra는 commitlog와 SSTable을 `/var/lib/cassandra` PVC에 저장한다.
Redis `appendfsync always`와 `noeviction`은 demo에서 이벤트·세션의 조용한 유실을 막기 위한 선택이다. 디스크 포화는 쓰기 오류로 드러난다.

## 기존 Cassandra에 이동 상태 테이블을 적용한다

Map의 이동 상태 기능은 `wgo_map.user_movement_state`를 사용한다.
앱 CD와 ConfigMap 갱신은 실행 중인 Cassandra에 CQL을 적용하지 않는다.
`cassandra-start.sh`는 DB 시작 시에만 schema를 실행하므로, 기존 환경에는
테이블을 먼저 적용한 뒤 해당 기능을 배포한다. 이미 배포된 환경은 아래 순서로 복구한다.

1. 대상 프로젝트·클러스터·namespace와 Map image digest를 확인한다.
   `system_schema.tables`와 `system_schema.columns`로 기존 테이블 유무와 타입을 확인한다.
   이미 존재하는 테이블의 정의가 다르면 중단한다. `IF NOT EXISTS`는 타입 차이를 수정하지 않는다.
2. `services/map-service/schema.cql`에서
   `CREATE TABLE IF NOT EXISTS wgo_map.user_movement_state` 문장만 추출하여 적용한다.
   기존 테이블의 변경·삭제나 이력 backfill은 하지 않는다. TTL도 추가하지 않는다.
   이동 차단 상태는 관측된 정지로만 해제해야 하므로 자동 만료시키면 안 된다.
3. `cassandra-0` 내부의 `cqlsh --ssl`을 사용한다. `/tmp/cqlshrc`는
   SELECT/MODIFY 전용 앱 계정이므로 DDL에 사용하지 않는다.
   Pod에 이미 마운트된 `/credentials/cassandra-admin-password`와 `/tls/ca.pem`으로
   권한 600의 임시 관리자 설정을 만들고, 비밀번호를 출력하거나 CLI 인자로 전달하지 않는다.
   실행 성공·실패 모두 임시 설정을 삭제한다. 앱 계정에 CREATE 권한을 추가하지 않는다.
4. 앱 계정으로 새 테이블의 조회와 조건부 쓰기(LWT)를 확인한다.
   기존 keyspace SELECT/MODIFY 권한이 새 테이블에도 적용되는지 확인한다.
   검증 전용 행을 사용했다면 해당 행만 정리한다.
5. 운영 `wgo-storage-bootstrap` ConfigMap의 `data["schema.cql"]`만 수정된 파일로 갱신한다.
   다른 bootstrap 파일, Secret, StatefulSet과 PVC는 유지한다.
   ConfigMap을 다시 읽어 새 정의가 포함됐는지 확인한다. Cassandra 재시작은 필요하지 않다.
6. 정상 인증된 테스트 계정으로 위치 갱신 API의 200을 확인한 뒤, 같은 위치에서
   게시물 작성과 생성된 게시물 조회를 확인한다. 이동 차단 응답이 나오면 배포된
   정지 확인 규칙에 따라 위치를 갱신하며 재검증한다. 인증·이동 검증을 우회하지 않는다.
   요청 correlation ID로 Map/Post/Gateway 로그를 대조하여 503 해소를 확인한다.
   생성한 테스트 게시물은 서비스의 정상 삭제 API로 정리한다.

추가 테이블은 기존 코드와 공존할 수 있다. 앱 rollback이 필요해도 테이블은 보존하고,
새로 저장된 이동 상태를 삭제하는 `DROP TABLE`을 rollback 절차로 사용하지 않는다.

## Elasticsearch 키와 snapshot을 준비한다

ECK의 `elasticsearch-es-elastic-user` 비밀번호는 관리 작업에서만 사용한다.
Post에는 `post-semantic-*` 인덱스의 `all` 권한과 필요한 `monitor` cluster 권한을 가진 API key를 발급한다.
검색 index 생성·alias 전환은 기존 Post semantic CLI로 수행한다. 초기 alias가 없는 상태에서 search-ready를 주장하지 않는다.

ECK Pod는 `elasticsearch-snapshot` KSA와 `<namespace>-es-snapshots@<project>.iam.gserviceaccount.com` GSA를 사용한다.
GSA에 `<project>-<namespace>-es-snapshots` GCS 버킷의 객체 권한을 부여한다.
`elasticsearch-snapshot-config` Job이 GCS repository와 일일 SLM을 설정한다. 리포지토리 검증에 실패하면 Job도 실패한다.
GCS snapshot 파일을 수동 수정하거나 삭제하지 않는다. 수명은 SLM으로 관리한다.
Elasticsearch PVC 파일 복사만으로는 지원되는 백업을 만들 수 없다.

## 백업과 복원을 구성한다

```sh
export GCP_PROJECT_ID=your-project
export GKE_CLUSTER=wgo-demo
export K8S_NAMESPACE=wgo-demo
bash scripts/gcp-storage-backup.sh create-plan
bash scripts/gcp-storage-backup.sh backup-now before-upgrade
```

Backup for GKE는 wgo-databases ProtectedApplication의 MongoDB·Redis·Cassandra 리소스·Secret·볼륨을 매일 UTC 18시에 보관하며 14일 보존한다.
이 PV 백업은 MongoDB·Redis·Cassandra의 crash recovery 대상이다. 서비스 간 일관된 한 시점의 논리 백업은 아니다.
계획된 복구 기준점은 앱 쓰기를 중단하고 Mongo journal, Redis AOF, Cassandra flush를 완료한 뒤 만든다.
Elasticsearch는 이 PV 백업에서 제외되며 SLM snapshot을 사용한다. 앱 설정은 Git과 Secret Manager에서 다시 구성한다. Cloud SQL과 GCS는 별도 백업·버전 관리 대상이다. 전체 환경 복원 시 outbox·dedup 상태의 시간 차이도 검사한다.

1. 같은 프로젝트의 별도 Autopilot 복원 검증 클러스터를 준비한다. ECK CRD·operator, Workload Identity, CSI 및 필요한 네트워크를 먼저 구성한다.
2. 소스와 다른 클러스터 이름으로 restore plan을 만든다. 기존 namespace가 있으면 복원을 거부하도록 구성되어 있다.
3. 아래 명령으로 복원을 시작한다. 실제 복원 전에 사용할 backup의 `SUCCEEDED` 상태를 확인한다.

```sh
bash scripts/gcp-storage-backup.sh create-restore-plan wgo-restore-test
bash scripts/gcp-storage-backup.sh restore-test before-upgrade restore-check-1
```

4. 복원 범위는 wgo-databases에 한정한다. 앱 Deployment·KSA·SecretProviderClass·migration Job과 Elasticsearch snapshot writer는 복원하지 않는다. 검증 클러스터의 앱은 정지 상태로 유지하고 별도 Cloud SQL DB·미디어 버킷·Secret Manager 값으로 구성하기 전에는 시작하지 않는다.
5. Elasticsearch는 빈 ECK 클러스터에 GCS snapshot repository를 `readonly=true`로 등록하고 snapshot API로 `post-semantic-*`를 복원한다. 운영 writer와 같은 repository를 동시에 수정하지 않는다. 검색은 MongoDB 원본으로 재구축할 수도 있다.
6. 원래 관리하던 DB 사용자·비밀번호·CA와 앱 Secret Manager 버전 참조를 복원한다. 원본 credentials를 새로 생성하지 않는다.
7. Mongo 트랜잭션, Redis pending reclaim, Cassandra tombstone·LWT, 알림 dedup, ES 검색 결과를 검증한다.
8. 백업 이름·복원 시간·복원 전후 sentinel ID와 데이터 수를 결과에 기록한다. PVC 생성 성공만으로 복원 완료를 표시하지 않는다.

## 확인한 범위

로컬 Docker에서 실제 Mongo TLS·인증·단일 replica set transaction의 commit·rollback과 재시작을 확인했다.
Redis TLS·인증·AOF 및 Stream 데이터가 재시작 후 유지되는 것을 확인했다. Cassandra TLS·제한 계정·schema 초기화와 LOCAL_QUORUM 및 LOCAL_SERIAL LWT를 확인했다.
GKE Autopilot admission, ECK Workload Identity snapshot, Backup for GKE 실제 restore는 GCP 환경에서 실행해야 한다.

## 근거

- [ECK Autopilot 설정](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/deploy-eck-on-gke-autopilot).
- [ECK GCS Workload Identity snapshot](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/cloud-on-k8s).
- [Elasticsearch 지원 백업](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/snapshot-restore.html).
- [Backup for GKE backup plan](https://docs.cloud.google.com/kubernetes-engine/docs/add-on/backup-for-gke/how-to/backup-plan).
- [Backup for GKE restore plan](https://docs.cloud.google.com/kubernetes-engine/docs/add-on/backup-for-gke/how-to/restore-plan).
