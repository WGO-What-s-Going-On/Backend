# QA-05 Post 활동 정합성

기준: 6975fb3 · 2026-10-23 · 로컬 전용 Mongo8 replica set17017, Cassandra4.1:17042, Redis7:16401, ES8.19.4:17200. 기존 데이터 변경 없음. Post/Map build 및 typecheck 성공, 두 패키지 lint 스크립트 없음. 제품 코드 수정 없음. 테스트 복사본의 포트와 Mongo directConnection만 QA 환경에 맞게 변경했다. Map dist는 클래스 identity 보존을 위해 실제 복사했다.

판정은 실행 단위이며 계획 A~E 전체 PASS를 뜻하지 않는다. PASS인 단위/대역 테스트도 실제 서비스 연결 증거와 구분한다.

## 기능 케이스

|Case ID|케이스|상태|실행·근거 / 범위|
|---|---|---|---|
|QA-05-01|A 생성/상세/댓글/공감/참여/취소/이탈/삭제·입력·소유권·상태|PASS|Post integration+event integration 38개 전부통과, 실제Mongo트랜잭션/Redis|
|QA-05-02|B 동시반응 종류유일·댓글반응중복·참여재가입·legacy/bucket|PASS|post-events test 99~528, 571,764 및 post integration699|
|QA-05-03|C 동일사용자·게시물 mutationId재시도·재연결|PASS|post integration824; DB 댓글1개|
|QA-05-04|C 삭제된댓글동일mutationId·다른사용자/게시물scope|NOT RUN|독립 명시적 추가케이스 미작성|
|QA-05-05|D ACTIVE snapshot경합 댓글/반응/댓글반응/참여|PASS|post-events deletion-commit barrier 4 케이스|
|QA-05-06|D Outbox실패 rollback·만료중복|PASS|post integration430/event625,737|
|QA-05-07|D 만료와 활동의 실제 barrier경합|NOT RUN|삭제경합 및만료순차는 실행; 만료전용경합은 미실행|
|QA-05-08|E 정적cursor·legacy혼합·동률·반복삭제|PASS|integration512/615; event528/603|
|QA-05-09|E 페이지순회중삽입삭제 보장범위|NOT RUN|고정snapshot 계약아님, 명시실험 미실행|
|QA-05-10|댓글공감→Notification|BLOCKED|댓글공감 이벤트 미발행 계약. 저장 검증만통과|

## 증거

integration-results.json, integration.log, unit.log

## 성능

배타순차측정완료. [performance.md](performance.md)에N/p50/p95/p99/max/RPS/error/반복편차/자원과한계를기록했다. SLO미정 BASELINE ONLY.

## 한계

서비스모든경로PASS/운영안전성을 선언하지 않는다. 외부Kakao/OpenAI/FCM 미호출. 실제모델 관련성 평가와 운영배포부하는 별도다.
