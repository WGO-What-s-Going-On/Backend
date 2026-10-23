# QA-03 User gRPC

기준6975fb3. **RPC 서버 직접검증 PASS / 제품 호출 연결 BLOCKED**. `../QA-02/test-results.json`의 finalization-grpc25 tests 중 RPC14 tests 및 service-auth5 tests; 전체User203과 중복합산 금지.

|Case|상태|내용|
|---|---|---|
|A 실제 transport3 RPC|PASS|GetUserProfile/BatchGetUserProfiles/GetUserStatus TCP localhost 동적포트, 실제Postgres|
|A 프로필온보딩·탈퇴비노출/상태/optional|PASS|미완료FAILED_PRECONDITION, WITHDRAWN NOT_FOUND, enum1..4, nullable Timestamp, unavailableIDs|
|A batch0/1/100/101·중복/순서·상한|PASS|실제grpc, once-query spy로N+1없음 확인; longs:String 안전정수상한|
|B 서비스JWT/메서드권한|PASS|Post ES256 profile/batch, legacyHS256 caller별권한; WSstatus허용/다른RPC거부|
|B 잘못된JWT/metadata/JWKS|PASS|누락/중복/잘못된서명kid/iss/aud/sub/typ/alg/시간/긴TTL, ES256실패HS256fallback금지 unit+RPC혼합|
|C DB오류 응답 sanitization|PASS (주입)|실제서버 query spy 오류→UNAVAILABLE, 내부오류노출없음. 실제DB컨테이너중단은 미실행|
|C client deadline/종료중요청/port재시작|NOT RUN|기존suite shutdown cleanup은 실행했으나 in-flight deadline/포트재사용 assertion은 없음|
|D Post·WS 실제 UserRPC client|BLOCKED|소스 GetUserProfile/GetUserStatus/BatchGetUserProfiles/USER_GRPC 검색0. User README도 Postclient후속. 테스트caller 성공과 제품경로연결은 구분|

현재 ES256 trust list는 Postissuer만 허용하고 WS legacyHS256 별도허용; 임의로WS ES256지원했다고 보고하지 않는다. 내부JWT서버인증과 사용자AccessJWT는 다른계약이다.

PERFORMANCE: 단건/배치1·20·100 direct grpc benchmark 완료. auth/SQL/serialization 개별 instrumentation 미구현은 N/A. 서버 query가 단일findBy이므로 batch20/100은 실제서로다른ID를 준비해서 측정. 제품요청→UserRPC E2E지연은 연결부재로N/A.


## 최종 성능 상태

PERFORMANCE **BASELINE ONLY 완료**. `../QA-02/performance.md`, `../QA-02/metrics.json`, `../QA-02/samples.jsonl`에실측원자료. 90,000기본요청+600상태변경/전파표본,오류0. 동시성1/5/20단계별N1000×3; p99탐색값. 실제100distinct users batch측정. 상태변경은N100×3. auth/DB lock등개별구간과scheduler처리량은N/A.
