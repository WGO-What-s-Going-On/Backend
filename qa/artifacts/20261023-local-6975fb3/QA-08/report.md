# QA-08 Map 공간검색·재구축

기준: 6975fb3 · 2026-10-23 · 로컬 전용 Mongo8 replica set17017, Cassandra4.1:17042, Redis7:16401, ES8.19.4:17200. 기존 데이터 변경 없음. Post/Map build 및 typecheck 성공, 두 패키지 lint 스크립트 없음. 제품 코드 수정 없음. 테스트 복사본의 포트와 Mongo directConnection만 QA 환경에 맞게 변경했다. Map dist는 클래스 identity 보존을 위해 실제 복사했다.

판정은 실행 단위이며 계획 A~E 전체 PASS를 뜻하지 않는다. PASS인 단위/대역 테스트도 실제 서비스 연결 증거와 구분한다.

## 기능 케이스

|Case ID|케이스|상태|실행·근거 / 범위|
|---|---|---|---|
|QA-08-01|A 실제Post생성→Outbox→Map→Cassandra/GEO|PASS|QA04 real-map1 및 QA09 semantic realfixture; 테스트XADD단독과분리|
|QA-08-02|A 150/250/350경계·동률·극지·날짜변경선|PASS|Map post-index suite12cases; 추가polar/date-line2좌표. radiusoracle±1m|
|QA-08-03|A 모든H3 cell경계 exhaustive|NOT RUN|선별좌표만 확인|
|QA-08-04|B HTTP JWT·RPC ES256·limit·cursor binding/손상·끝페이지|PASS|Mapserver unittransport, semantic real201후보페이지200+1|
|QA-08-05|B HTTP실storage pagination|NOT RUN|동일nearby구현의 실제DB 직접호출/RPC는 실행; HTTP계층저장소통합 별도미실행|
|QA-08-06|C 삭제/만료·역순생성·중복·GEO제외|PASS|post-index status test257; producer actual상태전파는 총괄QA07/13|
|QA-08-07|D GEO완전유실 재구축·진행중생성이중쓰기·pointer|PASS|Mapintegration213/234|
|QA-08-08|D 부분GEO손실|PASS(알려진한계재현)|유효한후보1개남으면 누락된1개검색안됨, rebuild후복구. 서비스요구사항상완전성결함 별도기록|
|QA-08-09|D Redis실제stop·rebuildkill/동시lock·진행중삭제|NOT RUN|모의GEO실패 fallback은PASS; 실제프로세스장애/경합은 미실행|
|QA-08-10|E Gateway공개주변검색조합|BLOCKED|현계약에 후속작업명시; 내부RPC통과를 공개E2E로해석하지않음|

## 증거

integration-results.json, integration.log, ../QA-04/real-map-traces.jsonl, ../QA-09/integration-rerun-results.json

## 성능

배타순차측정완료. [performance.md](performance.md)에N/p50/p95/p99/max/RPS/error/반복편차/자원과한계를기록했다. SLO미정 BASELINE ONLY.

## 한계

서비스모든경로PASS/운영안전성을 선언하지 않는다. 외부Kakao/OpenAI/FCM 미호출. 실제모델 관련성 평가와 운영배포부하는 별도다.
