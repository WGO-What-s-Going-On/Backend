# QA-06 댓글 후보 투표

기준: 6975fb3 · 2026-10-23 · 로컬 전용 Mongo8 replica set17017, Cassandra4.1:17042, Redis7:16401, ES8.19.4:17200. 기존 데이터 변경 없음. Post/Map build 및 typecheck 성공, 두 패키지 lint 스크립트 없음. 제품 코드 수정 없음. 테스트 복사본의 포트와 Mongo directConnection만 QA 환경에 맞게 변경했다. Map dist는 클래스 identity 보존을 위해 실제 복사했다.

판정은 실행 단위이며 계획 A~E 전체 PASS를 뜻하지 않는다. PASS인 단위/대역 테스트도 실제 서비스 연결 증거와 구분한다.

## 기능 케이스

|Case ID|케이스|상태|실행·근거 / 범위|
|---|---|---|---|
|QA-06-01|A 30분전/후·후보2개미만NONE·점수정렬·스냅샷|PASS|post integration887/991/1101; voteAt는fixture로 조정, 실제대기30분아님|
|QA-06-02|A 정확30분경계·복수worker동시선정·legacyNONE|NOT RUN|전체작업경합 별도실험 미실행|
|QA-06-03|B GET/PUT/DELETE·동일선택·변경·취소·후보밖/위치거부|PASS|post integration vote3cases|
|QA-06-04|B PUT실제Map RPC·DELETE위치갱신불필요|PASS|QA04 real-map3. 실제Map/Cassandra/Redis로 확인|
|QA-06-05|B 동일사용자동시표이동|NOT RUN|순차이동만 실행|
|QA-06-06|C 만료/삭제 winner유지·tie null·후보삭제CANCELLED|PASS|post integration vote3cases|
|QA-06-07|C 투표/종료 barrier경합·0표단독검증|NOT RUN|별도재현 미실행|
|QA-06-08|D 투표event 미발행|PASS(계약/코드)|현 계약 comment-vote.md; 실시간투표연결은 BLOCKED|

## 증거

../QA-05/integration-results.json, ../QA-04/real-map-results.json, ../QA-04/real-map-traces.jsonl

## 성능

배타순차측정완료. [performance.md](performance.md)에N/p50/p95/p99/max/RPS/error/반복편차/자원과한계를기록했다. SLO미정 BASELINE ONLY.

## 한계

서비스모든경로PASS/운영안전성을 선언하지 않는다. 외부Kakao/OpenAI/FCM 미호출. 실제모델 관련성 평가와 운영배포부하는 별도다.
