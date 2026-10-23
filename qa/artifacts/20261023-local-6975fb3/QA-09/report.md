# QA-09 유사도·E5·ES — 기본설정 기능 FAIL

기준: 6975fb3 · 2026-10-23 · 로컬 전용 Mongo8 replica set17017, Cassandra4.1:17042, Redis7:16401, ES8.19.4:17200. 기존 데이터 변경 없음. Post/Map build 및 typecheck 성공, 두 패키지 lint 스크립트 없음. 제품 코드 수정 없음. 테스트 복사본의 포트와 Mongo directConnection만 QA 환경에 맞게 변경했다. Map dist는 클래스 identity 보존을 위해 실제 복사했다.

판정은 실행 단위이며 계획 A~E 전체 PASS를 뜻하지 않는다. PASS인 단위/대역 테스트도 실제 서비스 연결 증거와 구분한다.

## 기능 케이스

|Case ID|케이스|상태|실행·근거 / 범위|
|---|---|---|---|
|QA-09-01|A 실제Mongo/Redis/Cassandra/MapRPC/ES fixture|PASS|semantic integration rerun7/7|
|QA-09-02|A checksum고정 실제E5 CPU FP32|PASS|embedding-model3/3, realE5 HTTP/rebuild/worker1case|
|QA-09-03|A 모델/threshold없을때503·worker미시작|PASS|Postintegration 및 semantic unit; 원격모델API호출없음|
|QA-09-04|B 위치인가→Map후보→Mongo→E5/ES→Mongo재검증|PASS|실제201Post생성·Outbox·후보·realHTTP테스트|
|QA-09-05|B no후보·category비필터·score미노출·미저장|PASS(단위)|semantic/api tests. 모델속도와fixture속도는 분리|
|QA-09-06|C no후보·200/201후보·limit1/invalidlimit·시간/상태/hash/version·partial|PASS|200+1 실제페이지+동률·INDEX_LAG 실제; 나머지semantic unit|
|QA-09-07|D ESHTTPtimeout/shard·queuecancel/fairness·ready|PASS(단위/대역)|semantic-es/embedding-provider. 실제ES/Mongo장애는 NOT RUN|
|QA-09-08|E outbox→실제semantic group→ES→ACK·Pending회수·lease·watermark/alias·retentionfail|PASS|semantic integration7cases + unitDLQ보조|
|QA-09-09|E 실제OS프로세스kill/trim중복합경합|NOT RUN|테스트주입은실행했으나 강제프로세스중단전용미실행|
|QA-09-10|한국어품질 precision/recall@k|NOT RUN|독립labelled 정답셋없음. 고정벡터순위/실제모델동일문구일치는품질성능주장아님|

## 증거

integration-rerun-results.json, integration-rerun.log, integration-results.json, ../QA-05/unit.log

## 성능

배타순차측정완료. [performance.md](performance.md)와 metrics.json에실제E5/HTTP의195표본·p50/p95/p99·RPS·오류·CPU/RSS·10초Mapdeadline차이를기록했다. 전부성공이나SLO미정 BASELINE ONLY.

## 한계

서비스모든경로PASS/운영안전성을 선언하지 않는다. 외부Kakao/OpenAI/FCM 미호출. 실제모델 관련성 평가와 운영배포부하는 별도다.

추가 범위 제한: 후보 정확1개/limit10 성공 경계와 모든 시간 등호 조합을 각각 독립한 케이스로 실행하지 않았다(NOT RUN).

## 기본500ms 후속 검증 — FAIL

후보200 실제HTTP503 3/3, 제품RPC DEADLINE_EXCEEDED 3/3. 빈GEO는HTTP200 3/3이나직접RPC1/3이deadline. 확장10초에서측정한성공성능과기본500ms결과를분리해야한다. [findings.md](findings.md), [default-deadline.json](default-deadline.json).
