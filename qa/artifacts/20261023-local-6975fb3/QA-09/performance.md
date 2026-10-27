# QA-09 실제 E5·Semantic 성능 — BASELINE ONLY

배타토큰 postmap-exclusive-20261023, 실제 CPU FP32 E5-small 384차원·Mongo/Cassandra/Redis/Map gRPC/ES. 상시 HTTP서버17012. 임베딩 fixture 속도가아니다. 동시성1, 작업별3회warmup, 예산상 짧은추론/HTTP는20표본×3회, 장문은5표본×3회. p99는 표본이적어사실상최대값에가깝고회귀합격판정불가.

|operation|N|p50 ms|p95 ms|p99 ms|max ms|RPS|error %|반복 p99범위 ms|
|---|---:|---:|---:|---:|---:|---:|---:|---|
|real-E5-long-Korean-5000chars|15|1324.14|1343.33|1343.33|1343.33|0.75|0.00|1335.35–1343.33|
|real-E5-short-Korean|60|6.64|8.55|21.12|21.12|140.01|0.00|6.59–21.12|
|real-HTTP-similar-200-candidates|60|615.94|684.44|803.30|803.30|1.62|0.00|687.41–803.30|
|real-HTTP-similar-zero-candidates|60|441.18|500.95|555.23|555.23|2.24|0.00|491.38–555.23|

신규 E5 session 초기화+warmup: 1088.75ms, N=1, p99=N/A. OS파일캐시는warm일수있으며디스크cold측정이아니다.

해석: 5000자윈도우추론은약1.3초로짧은한국어문장보다크다. 후보0 API도약0.44초 중앙값인데 Map 빈GEO가 H3 19cell×16shard=304개순차조회fallback으로이어지는구현과부합한다. 후보200 API는Map측200후보(원본상태필터후199개일수있음)이며약0.62초중앙값. 정확한phase별span을수집하지않아지연원인을수치로분해했다고주장하지않는다.

**중요설정 차이:** 이원본semantic통합fixture는 MAP_GRPC_TIMEOUT_MS=10000을설정한다. 후속기능반복검증에서기본500ms의200후보API503 3/3 및직접RPCcode4 3/3을확인했다. 빈GEO직접RPC도1/3deadline. default-deadline.json참조. 처음에는전체API지연만으로추론했으나후속직접RPC검증으로모델/ES이전후보조회deadline실패를분리확인했다. 설정차이없이운영SLO충족으로해석하면안된다.

N/A/NOT RUN: 후보20단계, 동시성5/20실제모델부하, 장문+200후보API, queue occupancy/전용phaseRPC·ES·Mongo span, peak DockerRSS, timeout강제부하, 인덱싱처리량/지연분포, precision/recall@k(독립라벨셋없음). 본측정은0error인관측baseline이며최대처리량시험이아니다.

원시표본/반복별CPU·RSS: performance.json. 실행로그: performance-run.log, assertions7PASS: performance-run-results.json.
