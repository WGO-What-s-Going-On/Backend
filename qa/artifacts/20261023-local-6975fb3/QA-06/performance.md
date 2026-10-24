## 배타 순차 성능 결과 — BASELINE ONLY

실제 로컬 저장소·gRPC, 상시 HTTP서버(17002), loopback closed-loop. 각작업/동시성1·5·20별1000표본×3반복. 워밍업은작업당10회로축소, 30초+120초×3 시간기준실험이 아니다. 아래N3000은동일조건3반복의원시표본을합쳐직접계산한값이며 p99를평균내지않았다. 반복별 p99 범위도함께기록한다. 표본/시간이제한되어탐색baseline이며운영SLO합격/최대처리량을주장하지않는다.

|operation|C|N|p50 ms|p95 ms|p99 ms|max ms|RPS|error %|반복 p99범위 ms|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
|QA06/vote-delete-idempotent|1|3000|2.00|3.90|6.05|20.23|438.63|0.00|4.99–6.36|
|QA06/vote-delete-idempotent|5|3000|8.43|38.00|57.88|113.95|388.42|0.00|54.39–60.21|
|QA06/vote-delete-idempotent|20|3000|48.70|215.67|342.52|804.98|271.95|0.00|307.62–374.70|
|QA06/vote-get|1|3000|0.81|2.22|4.53|47.93|922.04|0.00|2.43–5.78|
|QA06/vote-get|5|3000|1.50|2.63|3.64|6.19|3048.08|0.00|3.27–4.04|
|QA06/vote-get|20|3000|3.75|6.44|8.20|11.37|4890.52|0.00|6.48–9.37|
|QA06/vote-put-same|1|3000|3.37|5.50|7.02|20.28|277.97|0.00|6.76–7.34|
|QA06/vote-put-same|5|3000|7.70|40.22|62.68|127.21|373.97|0.00|58.74–67.14|
|QA06/vote-put-same|20|3000|62.12|279.76|477.92|990.43|215.39|0.00|364.90–593.55|

원시자료: ../QA-04/performance.json (전체99,000개표본), performance-progress.json(반복별CPUuser/system·RSS·RPS), docker-performance-start/end.txt. eventloop delay p99 전체측정값 11.313ms이며 operation별수치가아니다.

제약: Node RSS는 테스트driver+Post+Map이함께있는프로세스값이다. Docker별정밀peak/DB pool·lock wait/transaction retry 횟수/개별RPC phase는 N/A(별도instrumentation없음). closed-loop라예정발사시각을갖는open-loop 지연·coordinated omission 보정은 NOT RUN. 의도4xx와5xx/transport실패는원시 status로분리했다.

dataset: 합성로컬좌표, API fixture기반. create/comment는측정중데이터가늘어난다. hot한게시물1개의댓글/투표와작은Map후보집합을사용했다. 1천/1만Map후보검색·sparse/dense·rebuild중 부하·고정도착률1/5/20RPS·캐시완전cold실험은 NOT RUN. Mapconsumer는부하중pump하지않아fan-out 처리량을측정한것이아니며 Post Outbox발행worker만실행했다.

cache-miss 측정은 Redis DEL+store.get 전체구간이다. C1은Cassandra fallback, C5/20은동시cache재충전으로hit/miss가섞일수있다. votePUT은같은선택, DELETE는반복취소로멱등경로를포함한다. 반응/참여/삭제별단독p99와후보선정/종료scan처리량은 NOT RUN.

측정 하네스 첫시도는 app.init 상태 Supertest 자동listen/close로C5에transport오류10.8%가발생해중단했다. 상시listen으로수정한재측정99,000개는오류0이다. 최초자료(initial-harness-performance.json)는비교baseline/제품결함집계에서제외하고보존했다.

관측된 경합 신호: 같은사용자/게시물의동일선택PUT은 C1 p99 7.02ms/RPS278.0→C20 p99 477.92ms/RPS215.4, 반복DELETE는 C1 p99 6.05ms/RPS438.6→C20 p99 342.52ms/RPS271.9였다. 오류0이지만동시성이늘며처리량이감소한다. DB conflict/lock을별도계측하지않아경합의정확한원인·기여율은미확정이다. 서로다른사용자·게시물/실제표이동패턴은미측정이다.
