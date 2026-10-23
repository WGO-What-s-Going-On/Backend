# QA-10 로컬 성능 baseline

순차 배타 실행. SLO 없음: BASELINE ONLY. 실제 Redis/DynamoDB Local 및 production consumer/HTTP handler, 외부 provider는0ms 로컬대역이다. synthetic XADD는 Post commit이 아니다.

| 작업 | 동시성 | 반복 | N | p50 ms | p95 ms | p99 ms | max ms | 달성 RPS | 오류% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| XADD_to_durable_observation | 1 | 1 | 1000 | 10.594 | 14.636 | 18.032 | 38.361 | 91.353 | 0 |
| XADD_to_durable_observation | 5 | 1 | 1000 | 48.157 | 58.319 | 71.928 | 84.677 | 102.164 | 0 |
| XADD_to_durable_observation | 20 | 1 | 1000 | 259.44 | 312.326 | 368.706 | 398.845 | 75.876 | 0 |
| XADD_to_durable_observation | 1 | 2 | 1000 | 10.688 | 14.28 | 17.76 | 22.961 | 91.765 | 0 |
| XADD_to_durable_observation | 5 | 2 | 1000 | 47.906 | 58.912 | 68.216 | 94.704 | 102.058 | 0 |
| XADD_to_durable_observation | 20 | 2 | 1000 | 277.114 | 417.709 | 559.783 | 596.988 | 67.552 | 0 |
| XADD_to_durable_observation | 1 | 3 | 1000 | 10.419 | 13.931 | 17.205 | 75.02 | 92.981 | 0 |
| XADD_to_durable_observation | 5 | 3 | 1000 | 48.257 | 58.992 | 77.5 | 121.864 | 100.855 | 0 |
| XADD_to_durable_observation | 20 | 3 | 1000 | 254.143 | 309.859 | 660.496 | 715.201 | 74.156 | 0 |
| hot_post_XADD_to_durable | 20 | 1 | 100 | 172.624 | 201.315 | 211.586 | 214.074 | 114.104 | 0 |
| http_list | 1 | 1 | 100 | 1.373 | 81.226 | 146.199 | 156.682 | 90.813 | 0 |
| http_list | 1 | 2 | 100 | 1.135 | 1.949 | 2.511 | 3.056 | 799.99 | 0 |
| http_list | 1 | 3 | 100 | 0.917 | 1.647 | 2.176 | 2.75 | 984.122 | 0 |
| http_unread | 1 | 1 | 100 | 74.898 | 81.27 | 144.454 | 174.246 | 12.865 | 0 |
| http_unread | 1 | 2 | 100 | 75.315 | 79.934 | 91.692 | 98.297 | 13.154 | 0 |
| http_unread | 1 | 3 | 100 | 75.699 | 83.869 | 88.231 | 91.537 | 13.118 | 0 |
| http_markRead_idempotent | 1 | 1 | 100 | 1.928 | 3.346 | 4.079 | 5.187 | 457.445 | 0 |
| http_markRead_idempotent | 1 | 2 | 100 | 1.965 | 2.919 | 3.21 | 6.423 | 468.803 | 0 |
| http_markRead_idempotent | 1 | 3 | 100 | 1.545 | 2.931 | 3.609 | 3.8 | 571.629 | 0 |
| http_subscription_upsert | 1 | 1 | 100 | 2.692 | 3.731 | 4.014 | 4.696 | 355.655 | 0 |
| http_subscription_upsert | 1 | 2 | 100 | 3.15 | 5.197 | 7.078 | 8.742 | 298.568 | 0 |
| http_subscription_upsert | 1 | 3 | 100 | 3.419 | 4.844 | 6.114 | 6.492 | 284.695 | 0 |

표본: 이벤트 N1000/부하/반복, 3회; HTTP N100/작업/반복. p99는 탐색값으로 회귀합격선을 만들지 않는다. 20건워밍업 후 표본예산방식이며 계획의30초/120초고정시간을 축소했다. Closed-loop c1/5/20이며 고정도착률/coordinated omission 교정·최대처리량 검증은 미실행.

측정경계: event XADD 호출 시작→실제 DB event marker 또는 moderation result 조회완료. 2ms polling+DB조회오차가 포함되며 관측조회가 부하를 추가한다. Node측정은 부하생성기+consumer 합산 CPU/RSS이다. HTTP는 실제Nest 소켓요청→본문전부수신, 로컬X-User-Id 계약으로 측정.

데이터: 9020 distinct posts +100 comments hot post; author1; data grows across repetitions.

종료 group 상태: `[{"name": "post-notification", "consumers": 2, "pending": 0, "last-delivered-id": "1792742009227-0", "entries-read": 9120, "lag": 0}]`.

Dynamo SDK 명령 횟수(관측조회 포함): `{"GetCommand": 366141, "TransactWriteCommand": 18441, "QueryCommand": 10921, "UpdateCommand": 9321, "ScanCommand": 12}`.

외부 FCM 대신 로컬 PushSender 호출시점까지의 별도분포. 실제단말도착 N/A.

| 동시성 | 반복 | N | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 1000 | 14.487 | 19.073 | 23.406 | 44.813 |
| 5 | 1 | 1000 | 51.870 | 61.845 | 77.146 | 88.785 |
| 20 | 1 | 1000 | 264.132 | 318.182 | 375.801 | 403.431 |
| 1 | 2 | 1000 | 14.587 | 18.921 | 21.962 | 29.435 |
| 5 | 2 | 1000 | 51.322 | 63.358 | 73.402 | 98.078 |
| 20 | 2 | 1000 | 282.507 | 422.698 | 570.326 | 606.604 |
| 1 | 3 | 1000 | 14.283 | 18.246 | 23.135 | 84.054 |
| 5 | 3 | 1000 | 51.867 | 63.047 | 83.850 | 128.277 |
| 20 | 3 | 1000 | 258.467 | 315.727 | 683.050 | 719.128 |

원시자료: metrics.json, metrics-raw.jsonl, phase-raw.jsonl, performance.log. 반복별p99를평균하여전체p99로표현하지않았다. DB pool/lock 대기·개별네트워크phase·운영외부provider성능은수집하지않아N/A.

해석: 이벤트동시성20에서대기·관측조회부하와p99가증가한다. 소비루프의순차처리와2ms DB관측부하를포함한테스트결과이며운영최대처리량으로일반화하지않음. 첫HTTP목록반복은앱기동복구Scan과겹친cold구간; 이후warm반복과분리해해석한다.
