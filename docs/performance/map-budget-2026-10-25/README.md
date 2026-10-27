# Map 검색 요청별 예산과 취소 검증

## 범위와 기준

기준 커밋은 `86ab150`이다. 이미 요청당 병렬8, 파티션 조회 공유, GEO 인증이 반영된 버전과 비교했다.
이번 변경은 검색 전체의 시간·논리 Cassandra 조회 횟수·고유 후보 수를 제한한다. 위치 인가의 기존 timeout은 바꾸지 않는다.

기본값은 내부 500ms, 조회 4,500회, 후보 2,000개, 개별 DB 읽기 250ms다. 기존 Post→Map deadline 500ms와 이전 1,000개 후보 측정을 기준으로 시작값을 잡았다. 4,500회는 2,000개 후보의 위치·상태 4,000회와 일반 지역 304개 파티션 및 일부 후속 페이지를 포함할 수 있는 상한이다. 성공 보장 수치나 운영 최적값이 아니다. 시간 예산이 먼저 소진될 수 있으며 환경변수로 조정한다.

## 실제 Cassandra·Redis 측정

- macOS arm64, Node 24, Docker Cassandra 4.1 / Redis 7. 운영 부하 테스트가 아니다.
- 별도 임시 keyspace와 전용 Redis DB14. 준비·재구축은 측정에서 제외하고 종료 시 정리했다.
- 후보 2,500개를 세 거리 그룹으로 배치했다. 반경 150m에는 1,000개, 250m에는 2,000개, 350m에는 2,500개가 포함된다. 모두 ACTIVE·만료 없음이고, 응답 limit은 20이다.
- 정상 인증된 GEO에서 구현·조건별 워밍업 1회 후 3회 측정했다. 표는 시간 중앙값과 실제 `db.execute()` 호출 횟수다. 표본이 작으므로 운영 p95로 해석하지 않는다.
- 이 표는 `nearby()` 실행 구간이며 HTTP/gRPC 전송은 포함하지 않는다. 별도의 실제 Post→Map gRPC 테스트는 아래에 구분했다.

| Scenario | Variant | Outcome | Median ms | DB calls |
| --- | --- | --- | --- | --- |
| 1000-geo | baseline | OK | 268.68 | 2000 |
| 1000-geo | default-budget | OK | 288.81 | 2000 |
| 2000-geo | baseline | OK | 561.62 | 4000 |
| 2000-geo | default-budget | DEADLINE_EXCEEDED | 500.48 | 3033-3503 |
| 2500-geo | baseline | OK | 695.49 | 5000 |
| 2500-geo | default-budget | RESOURCE_EXHAUSTED | 6.90 | 0 |
| 1000-query-cap32 | query-cap32 | RESOURCE_EXHAUSTED | 12.16 | 32 |
| 1000-caller-deadline20 | default-budget | DEADLINE_EXCEEDED | 20.34 | 64-96 |

모든 실패 표본에서 반환 직후와 300ms 후 DB 호출 횟수가 같았다. 예산 안에서 성공한 응답은 20개를 반환했다. 호출 수 제한 32 및 호출자 deadline 20ms는 중단 경계를 확인하기 위한 별도 테스트 설정이며 운영 기본값이 아니다.

2,000개 후보의 기준 실행은 기본 Post deadline 500ms보다 오래 걸렸다. 이번 변경은 그 검색을 더 빠르게 성공시키는 것이 아니라, 초과한 요청의 후속 작업을 끊고 오류를 반환한다. 성공 가능 후보 규모를 늘리려면 검색 사영·활성 인덱스 정리 등 조회량 자체를 줄이는 작업이 필요하다.

## 회귀 검증

- Map 전체 테스트: 실제 Cassandra·Redis 통합 테스트 포함. 페이지 처리, 예산 초과, 공유 대기자 일부/전체 취소, HTTP 오류 매핑을 확인했다.
- Post의 `map-budget.integration.test.ts`: 실제 Post 클라이언트·ES256 인증·TCP gRPC·Map 검색 코드로 검증했다. DB 응답만 제어해 성공, RESOURCE_EXHAUSTED, 기본 500ms DEADLINE_EXCEEDED, 명시적 CANCELLED와 후속 상태 조회 미실행을 확인했다.
- Post `nearby-grpc.test.ts`와 `semantic.test.ts`: 기존 cursor·후보 계약 및 의존성 실패 시 유사도 검색 실패 처리를 회귀 검증했다. 이 검증은 전체 Post 시스템 E2E를 의미하지 않는다.
- 타입 검사·Map 빌드·루트 포맷·CI 선택 스크립트·actionlint를 검증한다. 실행 결과는 작업 완료 응답에 기록한다.

## 제한과 운영 관측

- 시간 제한은 이벤트 루프가 동작하는 시점에 반영되므로 정확히 500.000ms 종료를 보장하지 않는다.
- Cassandra driver readTimeout은 서버에서 이미 실행 중인 쿼리를 강제로 취소하지 않는다. 재시도는 비활성화하며 새 호출과 후속 페이지를 중단한다. Redis의 이미 실행된 Lua도 롤백하거나 강제 중단하지 않는다.
- 공유 페이지는 남은 대기자가 있을 때 유지한다. 늦게 참여한 요청에도 앞서 읽은 페이지와 후보를 논리 예산에 포함한다. 논리 조회 수와 실제 물리 DB 호출 수는 다를 수 있다.
- GEO COUNT는 응답 후보 수를 제한하지만 Redis 내부 검색 CPU 전체에 대한 상한은 아니다.
- 인스턴스 전체 동시성 제한은 별도 후속 작업이다. 검색 예산 초과 로그의 code/logicalQueries/candidates/elapsedMs를 관측해 기본값을 조정한다.

## 재현

[benchmark.mjs](./benchmark.mjs)와 [원시 측정값](./results.json).

1. 기준 커밋을 별도 checkout에서 빌드하고 `dist/post-index.js`를 현재 Map `dist/post-index-budget-baseline.js`로 복사한다. 기준 모듈은 현재 location.js와 GEO 상태 스크립트를 사용한다. GEO 스크립트의 COUNT 인자를 생략하면 기존 검색처럼 충분히 큰 상한을 사용하도록 호환했다.
2. 현재 Map을 빌드하고 `node scripts/ci-dependencies.mjs start map-service`로 일회용 DB를 준비한다.
3. 루트에서 `WGO_BENCH_ISOLATED=1 node docs/performance/map-budget-2026-10-25/benchmark.mjs`를 실행한다. Redis DB14를 비우므로 개인·운영 DB에는 실행하지 않는다.
4. `node scripts/ci-dependencies.mjs stop map-service`로 측정용 컨테이너·볼륨을 정리한다.
