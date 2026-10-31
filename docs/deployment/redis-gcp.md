# GKE Redis 연결과 복구

단일 Redis StatefulSet을 사용하며 Cluster client나 hash-slot 분산은 사용하지 않는다.
모든 이벤트 생산자·소비자는 같은 Redis DB 0을 사용한다. 서비스 소유 키 prefix와 consumer group은 기존 구현을 유지한다.
Post `MODERATION_REDIS_URL`도 Moderation `REDIS_URL`과 일치시킨다.
TLS URL은 `rediss://:<percent-encoded-password>@redis:6379/0`이다.
앱은 `NODE_EXTRA_CA_CERTS=/app/certs/redis-ca.pem`을 시작 전에 읽는다.
Post는 ECK와 Redis CA를 합친 `/trust/ca.pem`을 사용한다. 설정 JSON으로 이 값을 덮어쓰지 않는다.

## 실제 대상의 명령 호환성을 검증한다

Map 의존성을 설치한 뒤 `REDIS_URL`과 필요하면 `REDIS_CA_PATH`를 지정하고
`node scripts/redis-gcp-verify.mjs`를 실행한다. 임의 UUID prefix의 검사 데이터만 삭제한다.
TLS·인증, noeviction, GEO, Lua lease, 미ACK 이벤트 회수·ACK, Pub/Sub를 검사한다.
로컬 Redis 검증은 `REDIS_VERIFY_ALLOW_LOCAL=1`을 명시해야 한다.
이 검사는 서버 restart나 디스크 복원을 검증하지 않는다.

## Pod 교체와 복원을 검증한다

1. 게시물 생성 후 outbox와 consumer pending 상태를 기록한다.
2. staging Redis Pod를 교체하고 동일 PVC가 다시 연결됐는지 확인한다.
3. client reconnect, pending reclaim, 알림 중복 방지, WS 재연결·재인가를 확인한다.
4. 별도 복원 환경에서 Backup for GKE 복원을 실행하고 같은 데이터를 읽는다.

AOF `appendfsync everysec`는 마지막 약 1초의 쓰기 유실 가능성이 있다.
Redis Streams의 보존과 PVC는 절대 유실 방지를 보장하지 않는다.
noeviction 상태에서 메모리가 가득 차면 쓰기가 실패하므로 메모리와 outbox lag를 모니터링한다.
GEO는 Cassandra에서 재구축하고 Post 검색은 MongoDB에서 재구축한다.
Moderation의 현재 Redis 저장 상태와 User 세션은 단순 캐시가 아니므로 Redis를 비우는 복구를 금지한다.
