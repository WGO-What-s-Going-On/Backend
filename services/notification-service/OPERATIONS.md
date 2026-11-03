# Notification 운영 절차

## 보존과 배포 순서

1. 기존 PostgreSQL 백업/스키마/행 수, Redis stream·group·PEL을 기록한다. 운영 데이터를 초기화하지 않는다. Notification은 전용 DB/IAM DB 사용자, TLS 또는 Cloud SQL 자동 IAM Proxy의 기존 설정을 유지한다.
2. 새 이미지를 빌드하고 이전 consumer/delivery worker를 drain한 뒤 migration Job에서 `pnpm db:migrate`를 실행한다. 앱은 자동 DDL하지 않는다. v1 유지, v2 stream Inbox/업무 키/별도 delivery scope 및 nullable 실제 post FK, v3 댓글/상태 projection 보강, v4 위치 구독/영속 fanout 추가다. 기존 notification/read/preferences/subscriptions/처리 이력과 delivery를 보존한다. advisory lock으로 migration 경쟁을 막는다. deliveries PK 변경에는 테이블 잠금이 필요하므로 실제 크기·실행 시간을 사전 검증한다.
3. **생산자 전환 전에** `pnpm events:prepare`로 다섯 stream/group의 시작 ID를 PostgreSQL에 기록하고 group을 준비한다. 읽거나 ACK하지 않는다. 기존 group/PEL은 그대로 유지하며 새 group은 last-generated-id에서 시작한다. 준비 이후 이벤트는 Consumer 배포가 늦어도 group에 남는다. 재실행은 같은 시작점을 재사용한다.
4. User의 `USER_NOTIFICATION_TRUSTED_JWKS`, Post의 `POST_MODERATION_TRUSTED_JWKS` 공개키를 먼저 등록한다. Notification/Moderation에는 각자의 별도 private JWK·전체 내부 URL을 공급한다. Gateway private key를 재사용하지 않는다. 서비스 간 네트워크/2초 timeout/404·401·503을 검증한다.
5. 새 Notification Consumer를 배포하고 readiness(DB v4 + 실행하는 모든 stream 연결), PEL/DLQ/delivery를 확인한다. User/Moderation 기능 flag가 false인 환경에서도 먼저 prepare해 시작점을 보존한 후 true로 활성화한다. Post 기존 group은 유지한다.
6. Post 답글 부모 작성자 문맥과 Moderation 버전/실제 예정 시각 생산자 확장을 배포한다. 과거 v1은 호환하지만 없는 수신자/시각을 추정하지 않는다. 과거 projection이 필요한 대상은 명시적으로 원본 재조정 후 제한된 재처리 대상으로 선정한다.
7. 주변 알림은 기본 `NEARBY_NOTIFICATIONS_ENABLED=false`. 명시적 opt-in·별도 위치 목적 동의 UI, HTTPS 위치 권한, User 차단 인가 키와 설정을 검증한 후 true로 전환한다. 기존 약관/참여/거주 지역으로 동의를 대체하지 않는다. 기본 사용자별 최소 예약 간격600초, 허용60..86400초다.

운영 Secret·DB·Redis·GCP 배포는 이 작업에서 수정/실행하지 않았다. 이전 버전으로 단순 이미지 rollback해 새 기능을 계속 처리하지 않는다. 새 기능을 먼저 OFF하고 drain한 뒤 스키마를 보존해 이전 동작으로 복구한다. schema down/drop이나 group 재설정은 하지 않는다.

## 재시도와 재처리

모든 stream은 독립 group, XREADGROUP/XAUTOCLAIM cursor, transaction receipt 후 XACK를 사용한다. malformed는 즉시, 일반 입력 처리 실패는5회 후 DLQ다. busy delivery lease는 Pending 유지한다. ACK 장애는 poison 입력 횟수와 별개이며 DLQ하지 않는다. DLQ XADD와 XACK는 같은 Redis Lua 연산이다. Redis Cluster의 cross-slot Lua는 지원하지 않으므로 현재 standalone/cluster-mode-disabled 계약을 유지한다.

group이 유실되면 DB의 최초 cutoff로 재생해 Inbox/기존 Post marker로 중복을 막는다. 이전부터 존재한 group의 시작 checkpoint는0-0으로 보존해 오래된 PEL을 건너뛰지 않는다. 단순 Redis 재시작에서 group/PEL이 보존되면 그대로 재개한다. stream 원문 자체가 유실되면 PostgreSQL Inbox가 생산자 원문 복원을 대신하지 않는다. 승인된 생산자 Outbox 재발행 또는 Redis 백업 복구가 필요하며 원본 eventId를 유지한다.

기존 Post Consumer는 과거 미지원 댓글 공감/투표/PostUpdated를 receipt 없이 ACK했으므로 `post-notification/features-v2`라는 **DB 경계 행**도 최초 준비 시 stream tail로 고정한다. Redis consumer group은 추가하지 않는다. 복구 시 이 경계 이전의 신규 유형은 상태·취소·버전과 receipt만 반영하고 새 알림/Push를 만들지 않는다. 원래 지원하던9종의 미완료 PEL은 계속 처리한다. 이 구분으로 기존 Pending 보존과 과거 신규 알림 폭주 방지를 함께 유지한다. 과거 답글의 부모 문맥이 없는 경우 Post 소유 원본에서 부모/자식의 현재 삭제 상태와 작성자 문맥을 확인·재조정한 뒤 원본 ID로 제한 재처리한다.

DLQ 한 건은 먼저 다음 명령으로 검증한다. 기본은 dry-run이다.

```sh
pnpm events:replay --stream user:events --entry 1730000000000-0
# 원인을 해결하고 승인된 해당 건에만 적용한다.
pnpm events:replay --stream user:events --entry 1730000000000-0 --apply
```

CLI는 원본 payload·eventId를 검증해 같은 source stream에 추가하며 DLQ를 삭제하지 않는다. 잘못된 producer payload는 원본 소유 서비스가 수정/재발행해야 한다. 임의 수신자/ID를 새로 만들지 않는다. 과거 일괄 backfill은 기간·대상·수신/Push 정책을 승인한 별도 run/group으로 제한하고 DurableStreamConsumer.startId를 명시한다. 운영 group을 rewind하지 않는다. 기본 실행은 과거 전체 알림을 발송하지 않는다.

FCM 작업은 PostgreSQL PENDING/SENDING/60초 lease/SENT/FAILED/CANCELED다. 시작/30초 주기 drain, transient backoff 최대5분, lease ID completion fencing, 실패 token만 재시도한다. 성공 token과 invalid token은 재전송 대상에서 제외한다. 알려지지 않은 외부 응답/receipt 유실은 같은 notificationId로 재시도할 수 있다. 물리적 exactly-once는 보장하지 않으며 클라이언트가 notificationId로 중복 표시를 막는다. FAILED는 자동 무한 재시도하지 않고 원인·수신자 설정·만료를 확인한 후 별도 운영 결정을 따른다.

## 보존과 관측

알림은 생성 후30일 논리 TTL, 목록/unread가 항상 DB 원본으로 검증된다. `pnpm db:cleanup`을 CronJob으로 반복해1000행씩 물리 정리한다. 처리 Inbox/업무 키/삭제 tombstone은 임의 만료하지 않는다. 주변 좌표는 최대15분만 유효하며 구독/만료 job을1분 주기1000행 batch로 정리한다. 작업 완료/취소 좌표도 정리한다. backlog와 physical expiry를 감시한다. 로그에는 원문·토큰·JWK·좌표를 출력하지 않는다. DLQ 원문에는 댓글/개인정보가 있을 수 있으므로 접근을 제한한다.

모니터링 대상: stream lag/PEL oldest age/deliveriesCounter, DLQ 건수·증가, DB Inbox commit 실패·lock 대기·pool 사용률, delivery 상태별 건수/due age/lease 만료/FCM partial retry·invalid·permanent 결과, unread DB-캐시 편차, 위치 구독 만료 backlog, fanout PENDING/RUNNING age·페이지 크기·인가 실패·사용자 throttle. GCP FCM 권한/실수신·Redis failover/RPO·실제 Cloud SQL 재연결·GKE 다중 Pod 종료 유예는 배포 환경에서 별도로 검증한다.
