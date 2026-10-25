# 빈 GEO 검색의 DB 호출 감소 측정

## 변경 내용

기준은 `a095eaa`(후속 페이지 처리 및 요청당 병렬8 적용)다. 이번에는 실행 중인 동일 Cell·Shard 조회를 PostIndex 인스턴스 안에서 공유한다. 조회 완료 후 Promise를 제거하므로 완료 결과 캐시는 아니며, 나중의 독립 요청은 다시 조회한다. 좌표·반경·상태 검증·정렬·API cursor는 각 요청에서 따로 적용한다.

재구축 완료, 미완료 쓰기 없음, 스캔 중 쓰기 revision 불변, 스캔한 GEO 대상 수와 staging 멤버 수 일치를 인증 조건으로 삼는다. 조회 시 활성 포인터·인증 키·멤버 수 및 미완료 쓰기를 Redis Lua로 함께 검사한다. 인증된 빈 GEO는 Cassandra 대체 검색을 건너뛴다. 실패·미확인·재구축 중·멤버 유실이면 일부 후보가 남아 있어도 Cassandra로 보완한다.

## 측정 조건

- macOS arm64, Node 24, 실제 Docker Cassandra 4.1 / Redis 7. 단일 머신이며 운영 부하 테스트가 아니다.
- 테스트 전용 임시 Cassandra keyspace, 작업용 Redis DB14. 측정 후 정리했다.
- 실제 게시물이 없는 지역, 기본 (37.5, 127)에서 요청마다 위도를 0.0000001도씩 이동하여 같은 Cell 안의 서로 다른 좌표를 사용. 반경 250m, limit 20.
- 배치당 동시 요청 20개. 조건·구현별 배치 1회 워밍업 후 5배치 측정, 먼저 실행하는 구현을 교대했다.
- 기준 구현도 이미 병렬8이 적용되어 있다. 이번 호출 감소를 이전 순차→병렬 개선과 혼동하지 않는다.
- `nearby()` 내부 실제 DB 호출 수와 개별 요청 시간을 측정한다. HTTP/gRPC 인증·전송·직렬화는 포함하지 않는다.
- 모든 응답이 동일한 빈 items 및 null cursor인지 검사했다. 표의 p50/p95는 조건·구현당 요청 100개의 nearest-rank 값이다.
- 두 인스턴스 조건은 같은 프로세스의 독립 PostIndex·Cassandra/Redis 클라이언트 2개에 요청을 10개씩 분배한다. 공유 범위 확인이며 실제 다중 ECS Task 성능 측정은 아니다.

## 결과

| 조건 / 동시 요청 20개 | 기존 DB 호출 | 변경 후 DB 호출 | 감소율 | 기존 p50/p95 ms | 변경 후 p50/p95 ms |
| --- | --- | --- | --- | --- | --- |
| 미확인 GEO, 인스턴스 1개 | 6,080 | 304 | 95% | 99.06 / 108.66 | 42.86 / 43.11 |
| 인증된 빈 GEO, 인스턴스 1개 | 6,080 | 0 | 100% | 99.2 / 113.05 | 0.78 / 1 |
| 미확인 GEO, 인스턴스 2개 | 6,080 | 608 | 90% | 84.59 / 94.15 | 43.53 / 46.96 |

이 수치는 읽기 호출 횟수 감소를 확인한 것이며 DB CPU·디스크·운영 QPS 감소율을 측정한 것은 아니다. 상태 추적을 위해 이벤트 쓰기 경로에는 Redis 명령이 추가된다. 인증된 GEO에서도 후보가 존재하면 위치·상태 DB 검증은 유지한다. 임의 지역 전체의 요청량·대기열을 제한하는 기능은 이번 범위에 없다.

## 정확성 검증 및 운영 조건

- 실제 Cassandra·Redis를 포함한 Map 테스트 57개 통과, skip 없음. typecheck/build/루트 format 및 diff check 통과.
- 공유 실패 후 재요청, 완료 후 새 조회, 서로 다른 좌표·반경·cursor, 두 인스턴스의 인증 상태 공유를 검증했다.
- 멤버 일부/전체 키/포인터/메타데이터 유실, Redis 조회 오류, 이벤트 쓰기 실패 및 동일 이벤트 재시도, 재구축 중 쓰기·staging 유실·재구축 실패를 검증했다.
- 운영 전 모든 Map writer를 새 프로토콜로 교체하고 `pnpm rebuild:posts`로 인증한다. CLI의 ready=true를 확인한다. 쓰기 중인 스캔은 보수적으로 인증을 보류하므로 조용한 구간에 재실행할 수 있다.
- 미완료 쓰기 토큰은 실패를 숨기지 않기 위해 남는다. 실패 이벤트 재처리 후 재구축한다. 정상성을 강제로 설정하거나 토큰을 임의 삭제하지 않는다.
- 장애 시 자동으로 Cassandra fallback을 수행한다. 자동 주기 재구축 scheduler나 범용 DLQ replay 도구를 추가한 것은 아니다.
- 멤버 수가 유지되는 임의 교체·좌표 변조·직접 Cassandra 수정은 이 검사만으로 탐지하지 못한다. 원본 대조와 재구축이 별도로 필요하다. 아직 도착하지 않은 Post 이벤트까지 Map이 알고 있다는 의미도 아니다.

## 재현

[benchmark.mjs](./benchmark.mjs), [원시 샘플 및 집계](./results.json).

1. 기준 커밋 `a095eaa`를 별도 checkout에서 빌드하고 그 `services/map-service/dist/post-index.js`를 현재 checkout의 `services/map-service/dist/post-index-sharing-baseline.js`로 복사한다. location.js는 이번 변경 대상이 아니다.
2. 현재 checkout에서 `pnpm --dir services/map-service build`를 실행한다.
3. 루트에서 `node scripts/ci-dependencies.mjs start map-service`로 전용 DB를 준비한다. 포트 9042·6381에 개인/운영 DB가 없어야 한다.
4. `WGO_BENCH_ISOLATED=1 node docs/performance/map-fallback-sharing-2026-10-25/benchmark.mjs`를 실행한다. Redis DB14를 비우므로 반드시 일회용 환경에서만 실행한다.
5. `node scripts/ci-dependencies.mjs stop map-service`로 컨테이너·볼륨을 정리한다.
