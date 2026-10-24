## 배타 순차 성능 결과 — BASELINE ONLY

실제 로컬 저장소·gRPC, 상시 HTTP서버(17002), loopback closed-loop. 각작업/동시성1·5·20별1000표본×3반복. 워밍업은작업당10회로축소, 30초+120초×3 시간기준실험이 아니다. 아래N3000은동일조건3반복의원시표본을합쳐직접계산한값이며 p99를평균내지않았다. 반복별 p99 범위도함께기록한다. 표본/시간이제한되어탐색baseline이며운영SLO합격/최대처리량을주장하지않는다.

|operation|C|N|p50 ms|p95 ms|p99 ms|max ms|RPS|error %|반복 p99범위 ms|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
|QA05/comment-create|1|3000|3.19|5.36|7.99|24.06|291.52|0.00|5.97–8.71|
|QA05/comment-create|5|3000|14.12|38.98|58.14|159.80|295.53|0.00|51.85–62.49|
|QA05/comment-create|20|3000|78.77|347.27|532.22|1282.67|169.91|0.00|459.99–624.42|
|QA05/comment-list|1|3000|1.64|3.03|4.47|13.49|532.69|0.00|3.46–4.96|
|QA05/comment-list|5|3000|3.17|5.17|6.90|11.25|1471.44|0.00|6.30–7.31|
|QA05/comment-list|20|3000|8.50|12.68|16.54|22.21|2241.68|0.00|13.69–19.33|
|QA05/post-create-real-map|1|3000|4.79|8.68|12.28|25.14|190.05|0.00|10.08–13.43|
|QA05/post-create-real-map|5|3000|6.99|10.00|14.38|21.70|685.61|0.00|11.18–16.36|
|QA05/post-create-real-map|20|3000|19.99|24.79|28.28|33.68|985.90|0.00|26.19–29.16|
|QA05/post-detail|1|3000|0.76|1.37|1.95|4.75|1193.50|0.00|1.92–2.02|
|QA05/post-detail|5|3000|1.48|2.55|3.79|7.76|3069.21|0.00|3.54–4.51|
|QA05/post-detail|20|3000|3.91|6.32|8.62|12.85|4783.92|0.00|7.20–11.72|

원시자료: ../QA-04/performance.json (전체99,000개표본), performance-progress.json(반복별CPUuser/system·RSS·RPS), docker-performance-start/end.txt. eventloop delay p99 전체측정값 11.313ms이며 operation별수치가아니다.

제약: Node RSS는 테스트driver+Post+Map이함께있는프로세스값이다. Docker별정밀peak/DB pool·lock wait/transaction retry 횟수/개별RPC phase는 N/A(별도instrumentation없음). closed-loop라예정발사시각을갖는open-loop 지연·coordinated omission 보정은 NOT RUN. 의도4xx와5xx/transport실패는원시 status로분리했다.

dataset: 합성로컬좌표, API fixture기반. create/comment는측정중데이터가늘어난다. hot한게시물1개의댓글/투표와작은Map후보집합을사용했다. 1천/1만Map후보검색·sparse/dense·rebuild중 부하·고정도착률1/5/20RPS·캐시완전cold실험은 NOT RUN. Mapconsumer는부하중pump하지않아fan-out 처리량을측정한것이아니며 Post Outbox발행worker만실행했다.

cache-miss 측정은 Redis DEL+store.get 전체구간이다. C1은Cassandra fallback, C5/20은동시cache재충전으로hit/miss가섞일수있다. votePUT은같은선택, DELETE는반복취소로멱등경로를포함한다. 반응/참여/삭제별단독p99와후보선정/종료scan처리량은 NOT RUN.

측정 하네스 첫시도는 app.init 상태 Supertest 자동listen/close로C5에transport오류10.8%가발생해중단했다. 상시listen으로수정한재측정99,000개는오류0이다. 최초자료(initial-harness-performance.json)는비교baseline/제품결함집계에서제외하고보존했다.

관측된 경합 신호: 같은게시물 댓글생성은 C1 p99 7.99ms/RPS291.5에서 C20 p99 532.22ms/RPS169.9로꼬리지연이커지고처리량이감소했다. 오류는0이다. 단일hot post의트랜잭션경합이의심되지만 lock/transaction retry카운터를계측하지않아원인확정은아니다. 운영SLO가없어단순수치만으로결함판정하지않고 hot/distributed post 동등데이터대조를후속으로권한다.
