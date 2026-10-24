## 배타 순차 성능 결과 — BASELINE ONLY

실제 로컬 저장소·gRPC, 상시 HTTP서버(17002), loopback closed-loop. 각작업/동시성1·5·20별1000표본×3반복. 워밍업은작업당10회로축소, 30초+120초×3 시간기준실험이 아니다. 아래N3000은동일조건3반복의원시표본을합쳐직접계산한값이며 p99를평균내지않았다. 반복별 p99 범위도함께기록한다. 표본/시간이제한되어탐색baseline이며운영SLO합격/최대처리량을주장하지않는다.

|operation|C|N|p50 ms|p95 ms|p99 ms|max ms|RPS|error %|반복 p99범위 ms|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
|QA04/location-cache-hit|1|3000|0.17|0.23|1.28|3.49|4919.89|0.00|1.04–1.30|
|QA04/location-cache-hit|5|3000|0.19|0.25|0.89|1.50|23570.38|0.00|0.66–1.31|
|QA04/location-cache-hit|20|3000|0.22|0.26|1.12|1.51|81806.47|0.00|0.26–1.51|
|QA04/location-cache-miss|1|3000|2.12|3.59|4.67|19.42|402.82|0.00|4.07–6.00|
|QA04/location-cache-miss|5|3000|2.05|3.15|5.02|15.34|2239.69|0.00|3.76–5.27|
|QA04/location-cache-miss|20|3000|2.15|3.81|9.61|12.04|7930.30|0.00|3.58–12.04|
|QA04/location-put|1|3000|2.54|4.03|5.29|35.72|384.37|0.00|4.65–6.94|
|QA04/location-put|5|3000|2.10|3.41|5.36|10.72|2180.03|0.00|4.43–5.61|
|QA04/location-put|20|3000|2.78|4.86|6.76|13.73|6723.85|0.00|5.48–9.86|

원시자료: ../QA-04/performance.json (전체99,000개표본), performance-progress.json(반복별CPUuser/system·RSS·RPS), docker-performance-start/end.txt. eventloop delay p99 전체측정값 11.313ms이며 operation별수치가아니다.

제약: Node RSS는 테스트driver+Post+Map이함께있는프로세스값이다. Docker별정밀peak/DB pool·lock wait/transaction retry 횟수/개별RPC phase는 N/A(별도instrumentation없음). closed-loop라예정발사시각을갖는open-loop 지연·coordinated omission 보정은 NOT RUN. 의도4xx와5xx/transport실패는원시 status로분리했다.

dataset: 합성로컬좌표, API fixture기반. create/comment는측정중데이터가늘어난다. hot한게시물1개의댓글/투표와작은Map후보집합을사용했다. 1천/1만Map후보검색·sparse/dense·rebuild중 부하·고정도착률1/5/20RPS·캐시완전cold실험은 NOT RUN. Mapconsumer는부하중pump하지않아fan-out 처리량을측정한것이아니며 Post Outbox발행worker만실행했다.

cache-miss 측정은 Redis DEL+store.get 전체구간이다. C1은Cassandra fallback, C5/20은동시cache재충전으로hit/miss가섞일수있다. votePUT은같은선택, DELETE는반복취소로멱등경로를포함한다. 반응/참여/삭제별단독p99와후보선정/종료scan처리량은 NOT RUN.

측정 하네스 첫시도는 app.init 상태 Supertest 자동listen/close로C5에transport오류10.8%가발생해중단했다. 상시listen으로수정한재측정99,000개는오류0이다. 최초자료(initial-harness-performance.json)는비교baseline/제품결함집계에서제외하고보존했다.
