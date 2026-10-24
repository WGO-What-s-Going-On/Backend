# QA-02 User 인증·프로필·약관·탈퇴·Outbox

기준6975fb3, 로컬 PostgreSQL17 / Redis7 / Node24.21.0. FUNCTIONAL **PASS (명시한 범위)**. 전체 User suite203/203 PASS/skip0 중 User RPC 검증도 포함되어 QA-03과 숫자를 중복합산하지 않는다.

## 케이스

|Case|상태|검증/근거|
|---|---|---|
|A 신규/재로그인·동시 최초로그인|PASS|auth integration62 cases에 unique제약/계정 재사용/상태거부 포함. 실제 Postgres, Redis, Kakao DI stub|
|A 닉네임/프로필/온보딩·이벤트 조건|PASS|users integration66 cases: 경계/중복/알수없는필드/동시 row lock/USER_CREATED1회/USER_PROFILE_UPDATED 및 rollback|
|B refresh rotation/CAS/TTL/logout|PASS|동시 old token1승자, 기존expiry, 다른sid소유권/다른기기유지/미존재멱등/Redis실패; auth integration|
|C 최신필수약관/과거미래/재동의/배지|PASS|users66+terms6: 정렬·동률·필수약관·큰ID문자열·활성미회수 배지·Outbox 없음|
|D 탈퇴/복구/최종탈퇴경쟁|PASS|auth + finalization25(일부QA03): 정확deadline/30일고정·Redis실패rollback·2scheduler·복구경쟁 양순서·비식별화·관계정리·신규ID|
|E PostgreSQL commit→Outbox→Streams|PASS|outbox19: 실제Redis XADD·SKIP LOCKED·network proxy 재연결·commit 실패 동일eventId재전달·rollback이벤트없음|
|E 실제HTTP 전체앱 발행|PASS|live-stack.mjs 전체AppModule+Gateway. eventId37d72327-eaf1-43e2-bb80-ba7c97d6f921; requestId/correlationId486ffdbc-4f8c-44c2-b3b8-d6d59f5ee960; DBPUBLISHED attempts1=stream1792740282532-0. live-results.json|
|E User 이벤트 최종 소비|BLOCKED|실제 downstream User consumer 없음. 발행까지만PASS|
|운영 사용자 인증|BLOCKED|Gateway/User REST Bearer 검증 미구현. 잘못된Bearer+X-User-Id 프로필200; 기존명시된gap|

Kakao 실제 네트워크 호출0: DI 대역이 authorizationCode→providerId를 반환. Kakao client4개 unit tests는 fetch mock. 내부 HTTP/gRPC/Postgres/Redis는 실제이며 User app port15431, gateway15433, DB15432, Redis16400/0. 로그인토큰을 결과에 저장하지 않았다.

테스트는 각 전용DB 생성/삭제, test Redis13/14/15만 사용. 기존6379/포트6381은 건드리지 않고 artifacts config에서16400으로 치환. 최초실행에서 cwd proto경로/TCPproxy6379 치환누락으로 발생한 harness실패는 `initial-harness-errors.log`에 남겼고 교정 후203/203 재실행했다. 제품 결함으로 집계하지 않는다.

`pnpm typecheck`, `pnpm build` PASS; lint script없음. 제품파일 수정없음. 로그에는 의도한DB constraint failure가 포함되나 최종 테스트PASS이고 테스트 fixture데이터뿐이다.

PERFORMANCE: 순차 측정 완료. direct/gateway profile, login local stub, refresh, profile update, terms, actual gRPC 및 독립계정 탈퇴와 이벤트 관측을 측정했다. scheduler 처리량과 정확한 commit 시각 기준 지연은 N/A.


## 최종 성능 상태

PERFORMANCE **BASELINE ONLY 완료**. `../QA-02/performance.md`, `../QA-02/metrics.json`, `../QA-02/samples.jsonl`에실측원자료. 90,000기본요청+600상태변경/전파표본,오류0. 동시성1/5/20단계별N1000×3; p99탐색값. 실제100distinct users batch측정. 상태변경은N100×3. auth/DB lock등개별구간과scheduler처리량은N/A.

## 정리

전체 성능 측정 후 PID59651에 SIGTERM을 전달했다. User15431/Gateway15433 접속 거부로 종료 확인. 다만 Redis16400 컨테이너가 먼저 중지되어 종료 중 harness Redis 연결의 MaxRetriesPerRequestError로 exit1이 발생했다. 따라서 graceful shutdown PASS로 기록하지 않는다. 측정 종료 후의 정리 순서 문제이며 성능 표본에는 포함하지 않았다. Docker 자원은 총괄이 중지하고 보존했다.
