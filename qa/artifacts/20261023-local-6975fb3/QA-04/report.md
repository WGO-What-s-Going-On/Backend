# QA-04 위치·Post→Map

기준: 6975fb3 · 2026-10-23 · 로컬 전용 Mongo8 replica set17017, Cassandra4.1:17042, Redis7:16401, ES8.19.4:17200. 기존 데이터 변경 없음. Post/Map build 및 typecheck 성공, 두 패키지 lint 스크립트 없음. 제품 코드 수정 없음. 테스트 복사본의 포트와 Mongo directConnection만 QA 환경에 맞게 변경했다. Map dist는 클래스 identity 보존을 위해 실제 복사했다.

판정은 실행 단위이며 계획 A~E 전체 PASS를 뜻하지 않는다. PASS인 단위/대역 테스트도 실제 서비스 연결 증거와 구분한다.

## 기능 케이스

|Case ID|케이스|상태|실행·근거 / 범위|
|---|---|---|---|
|QA-04-01|A 위치 HTTP→history→cache, 동일좌표 반복·최신timeuuid·7일TTL|PASS|real-map 1, Map location-history 3; 실Cassandra/Redis|
|QA-04-02|A Gateway 경유|PASS(총괄 통합)|QA13/functional.json: 실제 Gateway→Map HTTP→Cassandra 및 Gateway→Post→MapRPC|
|QA-04-03|A UTC일 경계|PASS(단위)|store.test.ts의 이전UTC날조회; 실제 자정 경과 미실행|
|QA-04-04|B Post생성·참여 실제ES256 RPC 반영|PASS|real-map 1, traces의 Map store.get 및 eventId|
|QA-04-05|B 위치없음·반경밖·오래된위치 거부와 Post/Outbox 무변경|PASS|real-map 2; stale 캐시는 updatedAt/updatedAtMs 일치하게 주입|
|QA-04-06|B 5분/R 정확경계·입력/JWT|PASS(단위/transport)|location.test.ts/server.test.ts; 경계 oracle 고정clock, 서버storage대역|
|QA-04-07|C cachemiss Cassandra fallback·늦은cachewrite방지|PASS|real-map2/location-history2|
|QA-04-08|C Redis네트워크중단·Cassandra네트워크중단|NOT RUN|메서드오류단위검증 존재; 실제네트워크장애는 총괄QA13|
|QA-04-09|D gRPCdeadline/인증/거부 HTTP mapping·무저장|PASS(transport대역)|Post integration failure case 및 총괄QA13/fault-results.json 실제Map gRPC서버중단503/무저장→재시작201(관측복구1051ms). OS kill은미실행|

## 증거

integration-results.json, real-map-results.json, real-map-traces.jsonl, unit.log, real-map.log

## 성능

배타순차측정완료. [performance.md](performance.md)에N/p50/p95/p99/max/RPS/error/반복편차/자원과한계를기록했다. SLO미정 BASELINE ONLY.

## 한계

서비스모든경로PASS/운영안전성을 선언하지 않는다. 외부Kakao/OpenAI/FCM 미호출. 실제모델 관련성 평가와 운영배포부하는 별도다.
