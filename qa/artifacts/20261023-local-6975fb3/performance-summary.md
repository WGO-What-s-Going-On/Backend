# 로컬 순차 성능 요약

모든 값 ms. 사전 합의 SLO 없음: baseline only. 기본적으로 C1/5/20, 단계별N1000×3회이며 아래 예외/측정경계를 반드시 함께 본다. 각 반복 p99 범위와 원시 표본 통합 p99를 혼동하지 않았다. 실패는 별도로 집계한다.

|시나리오|핵심 관측|표본/경계/해석|
|---|---|---|
|QA00|p99 N/A|준비·시작 단발|
|QA01|Gateway profile C20 p99 6.17~6.71|반복 범위; HTTP 응답 body완료|
|QA02|direct profile3.47~5.04; login16.78~35.69; refresh8.80~18.71; update12.44~20.94; terms9.50~13.03|User/Gateway 총90600표본 오류0; 인증 제공자 로컬대역|
|QA03|단일프로필 RPC3.18~6.25,100명batch11.55~13.53|C20 반복범위,JWT서명제외RPC호출~callback|
|QA04|cachehit1.12/cachemiss9.61/put6.76|C20각N3000합산; direct store, HTTP아님. miss는DEL+get,동시성에서mixedhit|
|QA05|Post생성28.28/댓글생성532.22/목록16.54/detail8.62|C20각N3000합산, 실제 HTTP; Post생성은실제MapRPC. hot댓글C1 p997.99→C20 532.22,처리량291.5→169.9RPS|
|QA06|vote PUT477.92/DELETE342.52/GET8.20|C20각N3000합산. hotpost공유경쟁. Post/Map11ops전체99000오류0|
|QA07|UserHTTP시작→Stream관측51.10~55.14|N300,50ms폴링; DBcommit시점아님. Post→각consumer 독립commit지연 p99는N/A,QA10~13별도경계|
|QA08|일반 nearby RPC9.19|C20N3000합산,작은후보fixture. 밀집후보에일반화금지|
|QA09|유사검색후보200 803.30/후보0 555.23|각N60,C1,실제HTTP+E5,deadline10000ms. 기본500ms에선200후보HTTP3/3실패|
|QA09 embedding|짧은한국어21.12/긴5000자1343.33|N60/N15,실제E5. cold session준비1088.75ms N1,OScache가능. p99≈max|
|QA10|XADD→Dynamo관측 C20 p99 368.7~660.5|N9000,반복범위,2ms폴링. 실제HTTP4opsN300씩+cold100 포함총10300 오류0. unread88.2~144.5/listwarm2.2~2.5/read3.2~4.1/subscribe4.0~7.1. coldlist회복중146|
|QA11|XADD→결과관측C20 p99 146~193.2|N9000오류0,OpenAI0ms대역. CAS9020관측p993.018 별도내부표본|
|QA12/13|WS응답C20 p99475.98~1005.76 / 다른replica479.27~1009.78|9000건중1error(0.0111%); 각반복성공표본p99범위. 실제Post/DB/Outbox/Redis 경유|

QA13 C1 다른replica p9913.43~23.08ms→C20 479.27~1009.78ms. 성공표본만의 지연과 오류율을 함께 본다. DB1030/1030 및 활성4consumer lag/pending0은9회모두확인. 중단한Semanticconsumer lag는잔류하고0이라고보고하지않는다.

환경: AppleM5/24GiB, Docker10vCPU/7.65GiB, Node24.21.0,localhost. CPU/RSS/eventloop와run시각은각metrics/performance JSON. 부하agent는순차였지만서비스idleworker/hostbackground는존재한다. QA13은하나의QA Node프로세스의productioncomponents+실제network/storage다.

원래장기warmup30초/측정120초대신표본예산으로실행. 10000미만단계의p99는탐색값이고운영SLO/최대처리량/누수판정이아니다. open-loop과500connection/장기부하NOT RUN. 로컬대역외부지연은포함안됨. 부하별데이터분포/조회범위가달라서비스순위를직접비교하면안된다.

원시자료: QA-02/metrics.json 및 samples.jsonl, QA-04/05/06/08 metrics.json, QA-09/performance.json/default-deadline.json, QA-10/11 metrics.json/metrics-raw.jsonl, QA-13/performance.json/performance-raw.jsonl. 개별performance.md에p50/p95/p99/처리량/오류/환경/한계정리.
