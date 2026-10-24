# QA-11 로컬 성능 baseline

순차 배타 실행. SLO 없음: BASELINE ONLY. 실제 Redis 및 production Moderation consumer, 외부 provider는0ms 로컬대역이다. synthetic XADD는 Post commit이 아니다.

| 작업 | 동시성 | 반복 | N | p50 ms | p95 ms | p99 ms | max ms | 달성 RPS | 오류% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| XADD_to_durable_observation | 1 | 1 | 1000 | 5.17 | 9.215 | 13.956 | 57.924 | 185.58 | 0 |
| XADD_to_durable_observation | 5 | 1 | 1000 | 21.614 | 31.245 | 49.032 | 88.1 | 225.325 | 0 |
| XADD_to_durable_observation | 20 | 1 | 1000 | 89.398 | 151.574 | 193.222 | 231.283 | 211.952 | 0 |
| XADD_to_durable_observation | 1 | 2 | 1000 | 4.628 | 7.984 | 10.241 | 53.94 | 210.071 | 0 |
| XADD_to_durable_observation | 5 | 2 | 1000 | 20.531 | 30.035 | 36.154 | 47.139 | 237.529 | 0 |
| XADD_to_durable_observation | 20 | 2 | 1000 | 84.774 | 119.602 | 145.96 | 148.387 | 227.638 | 0 |
| XADD_to_durable_observation | 1 | 3 | 1000 | 4.591 | 8.103 | 10.428 | 29.163 | 212.203 | 0 |
| XADD_to_durable_observation | 5 | 3 | 1000 | 21.626 | 34.092 | 44.821 | 83.425 | 219.789 | 0 |
| XADD_to_durable_observation | 20 | 3 | 1000 | 88.442 | 133.375 | 184.133 | 200.947 | 212.043 | 0 |

표본: 이벤트 N1000/부하/반복, 3회; HTTP 측정은이시나리오에해당없음. p99는 탐색값으로 회귀합격선을 만들지 않는다. 20건워밍업 후 표본예산방식이며 계획의30초/120초고정시간을 축소했다. Closed-loop c1/5/20이며 고정도착률/coordinated omission 교정·최대처리량 검증은 미실행.

측정경계: event XADD 호출 시작→실제 DB event marker 또는 moderation result 조회완료. 2ms polling+DB조회오차가 포함되며 관측조회가 부하를 추가한다. Node측정은 부하생성기+consumer 합산 CPU/RSS이다. 이시나리오의끝점은Redis검사결과저장이다. 활동CAS/ACK은이후에완료되며별도CAS분포와최종Pending0으로확인.

데이터: 1000 comments per fresh post per stage; one hot post per stage.

종료 group 상태: `[{"name": "post-moderation", "consumers": 1, "pending": 0, "last-delivered-id": "1792742118171-0", "entries-read": 9020, "lag": 0}]`.

DynamoDB는하네스의공통생성단계에만사용되며Moderation측정에는접근하지않았다.

Redis CAS transition 별도관측 N=9020, p50=1.010ms/p95=2.309ms/p99=3.018ms/max=14.027ms. 이phase p99를event p99에더하지않는다.

원시자료: metrics.json, metrics-raw.jsonl, phase-raw.jsonl, performance.log. 반복별p99를평균하여전체p99로표현하지않았다. DB pool/lock 대기·개별네트워크phase·운영외부provider성능은수집하지않아N/A.

표의 durable 명칭은코드내operation식별자이며Redis의물리내구성검증을의미하지않는다. 실제측정은Redis검사결과관측이다.
