# Map 주변 검색의 제한된 병렬 조회 측정

## 변경과 측정 범위

기준 커밋 `1a3bced`의 순차 조회(이미 Cassandra 후속 페이지 처리가 반영된 버전)와 이번 변경을 비교했다.
후보 검증 및 H3 Cell·Shard 탐색에 요청당 최대 8개 worker를 사용한다. 같은 후보의 위치 → 상태 조회,
같은 파티션의 후속 페이지는 순차로 유지한다. 전체 후보를 읽고 정렬한 뒤 기존 API cursor/limit을 적용한다.
오류가 나면 새 후보·파티션 작업 배정을 중단하고 이미 실행한 작업이 정리된 뒤 요청을 실패시킨다.

8은 이번 비교에 사용한 보수적인 시작값이며 최적값을 탐색한 결과는 아니다. 요청별 총 조회량·시간 예산,
이미 실행 중인 DB 작업 취소, 인스턴스 전체/여러 인스턴스의 동시성 제한은 아직 적용하지 않았다.

## 측정 환경과 방법

- 로컬 macOS arm64, Node 24, Cassandra 4.1 및 Redis 7 Docker. AWS 운영 부하 측정이 아니다.
- 실제 Cassandra·Redis를 호출하는 `PostIndex.nearby()` 실행 시간. HTTP/gRPC 인증·네트워크·직렬화 구간은 제외한다.
- 별도 임시 Cassandra keyspace와 작업용 Redis DB14를 사용하고 종료 시 정리했다.
- 후보 0/20/200/1,000개, 모두 ACTIVE·만료 없음. 중심은 (37.5, 127), 반경 250m, 응답 limit 20.
- 후보 위도는 37.5 + (n % 100) × 0.00001, 경도는 127로 설정해 모든 후보가 반경 내에 있고 거리 동률도 포함한다.
- GEO 모드는 인덱스를 유지하고, fallback 모드는 GEO 키만 지워 동일한 Cassandra 데이터에서 대체 검색을 수행한다.
- 조건·구현별 2회 워밍업 후 10회 측정. 매 라운드 선행 구현을 교대로 바꿨고 모든 라운드에서 items 및 nextCursor가 동일한지 비교했다.
- Cassandra `execute()` 호출 수와 최대 동시 실행 수도 함께 측정했다. median은 nearest-rank p50, p95도 nearest-rank이며 표본이 10개라 p95는 이 표본의 최대값이다.
- 반환 지연과 DB 호출량을 분리해 해석해야 한다. DB CPU·디스크·QPS·다중 사용자 포화 성능은 측정하지 않았다.

## 결과

| 후보 수 | 경로 | 순차 p50 / p95 (ms) | 병렬8 p50 / p95 (ms) | DB 호출 수 (양쪽 동일) |
| --- | --- | --- | --- | --- |
| 0 | empty-fallback | 464.96 / 574.18 | 42.99 / 52.72 | 304 |
| 20 | geo | 52.88 / 64.1 | 6.98 / 11.06 | 40 |
| 20 | fallback | 567.21 / 693.53 | 49.1 / 55.91 | 344 |
| 200 | geo | 630.94 / 866.3 | 53.94 / 79.67 | 400 |
| 200 | fallback | 1195 / 1414.14 | 94.78 / 224.23 | 704 |
| 1000 | geo | 3916.75 / 4365.71 | 274.26 / 338.82 | 2000 |
| 1000 | fallback | 4564.95 / 5055.39 | 327.63 / 383.49 | 2304 |

모든 측정에서 items·nextCursor가 동일했다. 최대 동시 Cassandra 조회는 순차 1, 병렬 8로 확인했다. 총 호출 수는 줄지 않았고, 로컬 워밍업된 단일 요청의 대기 시간은 감소했다. 위 p95는 운영 지연 분포를 대표하지 않는다.

## 검증

- 수정 전 동시성 회귀 테스트 2건 실패를 확인하고 수정 후 통과했다.
- `RUN_INTEGRATION=1 pnpm --dir services/map-service test`: 실제 Cassandra·Redis 통합 테스트 포함 45개 통과, skip 없음.
- 기존 후속 페이지·API cursor 회귀 테스트, 동시 실행 상한·실패 후 작업 정리 테스트 통과.
- Map typecheck/build, 루트 format, `git diff --check` 통과.

## 재현 방법

[benchmark.mjs](./benchmark.mjs)와 [results.json](./results.json)에 측정 코드와 결과를 남겼다.
벤치마크는 Redis DB14를 비우므로 반드시 전용 일회용 Docker 환경에서만 실행한다. 운영·개인 데이터가 있는 Redis에는 실행하지 않는다.

1. 기준 커밋 `1a3bced`를 별도 checkout에서 빌드하고 `services/map-service/dist/post-index.js`를 현재 checkout의 `services/map-service/dist/post-index-baseline.js`로 복사한다. baseline은 동일한 현재 dist의 location.js를 사용하며 해당 파일은 이번 변경 대상이 아니다.
2. 현재 checkout에서 `pnpm --dir services/map-service build`를 실행한다. baseline 파일은 별도로 유지한다.
3. 루트에서 `node scripts/ci-dependencies.mjs start map-service`로 전용 DB를 준비한다. 9042·6381 포트에 다른 서비스가 없어야 한다.
4. `WGO_BENCH_ISOLATED=1 node docs/performance/map-nearby-2026-10-25/benchmark.mjs`를 실행한다. 결과 JSON을 갱신한다.
5. `node scripts/ci-dependencies.mjs stop map-service`로 측정용 컨테이너·볼륨을 정리한다.

같은 로컬 환경에서도 Docker 부하·캐시·JIT에 따라 수치는 달라진다. 이번 결과만으로 운영 응답시간 보장이나 DB 부하 감소를 주장하지 않는다.
