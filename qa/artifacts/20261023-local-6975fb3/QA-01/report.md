# QA-01 HTTP Gateway

기준 6975fb3, 2026-10-23, 로컬 Node24.21.0. FUNCTIONAL **FAIL**: 기존 23/23 테스트는 PASS이나 추가 실제 HTTP 검증에서 4개 결함 재현. 제품 코드는 변경하지 않았다.

## 하위 케이스

|Case|상태|expected / actual / 근거|
|---|---|---|
|A1 Gateway→실제 User 로그인·프로필·requestId|PASS|로그인201, 프로필200, requestId=User Outbox correlationId=Redis envelope. `../QA-02/live-results.json`|
|A2 실제 Post/Map/Notification/Moderation 경로|NOT RUN|총괄 QA-13 통합 스택 결과에서 보완; 이 작업의 단독 경로 PASS로 합산하지 않음|
|A3 path/query/body/status/header|PASS|실제 TCP stub upstream에서 동일 path/query/body와 Gateway가 생성한 requestId 관측. `probe-results.json`|
|B1 없는 경로/connection refused|PASS|기존 app test와 실제 terms404; connection refused502|
|B2 큰 본문|FAIL|128B 제한에 267B JSON이 upstream 도달200. 2/2 재현|
|B3 GET503 retry 한도|FAIL|maxRetries=1인데 11회 upstream 도달. 2/2 재현|
|B4 비멱등 POST503|PASS|upstream1회. HEAD503도1회(라이브러리 기본503retry는 GET전용)|
|B5 upstream header timeout 오류계약|FAIL|timeout40ms, upstream1500ms delay에 504가 아닌502/GATEWAY_BAD_UPSTREAM. 1회 재현. 150ms 지연은 타이머 분해능상200이므로 별도 결함 단정하지 않음|
|C1 위치 공유 제한|PASS|실제 Redis16400 DB1, Gateway2개 번갈아61회→60개만 upstream,61번째429; global100/101도100개만 upstream. 2/2|
|C2 Redis 검사 실패|PASS (주입)|기존 integration test Redis eval reject→503, upstream 증가없음. 실제 컨테이너 강제중단은 NOT RUN|
|D1 문서 병합/실패 기존파일보존/production 숨김|PASS (fixture)|openapi15 tests PASS. 실제 User docs200. 4개 실제 서비스 수집은 총괄 실행 필요|
|D2 terms·Moderation 문서 범위|PASS|terms 미라우팅404 관측. Moderation 미수집 현재 계약|
|E JWT 신뢰경계|BLOCKED (알려진 미구현)|잘못된 Bearer와 X-User-Id에도 프로필200. 로컬헤더의 성공은 인증 PASS 아님|
|실행 package start|FAIL|빌드 성공 뒤 pnpm start exit1 MODULE_NOT_FOUND|

## 발견사항

### [High] 빌드 후 start 스크립트가 존재하지 않는 파일을 실행
- `gateways/http-gateway/package.json:13`, `tsconfig.json:8`: 출력은 dist/src/server.js이지만 start는 dist/server.js.
- 재현: 서비스 디렉터리에서 `pnpm build && pnpm start`. 실제 build PASS/start exit1, `start.log`.
- 로컬 표준 실행 명령 사용 불가. Dockerfile CMD는 dist/src/server.js이므로 동일 컨테이너 실패로 확대하지 않음.
- 수정 방향: start 대상과 컴파일 rootDir/output을 일치시키고 실행 smoke test 추가.

### [High] 프록시 요청에서 Gateway 본문 크기 제한이 적용되지 않음
- `gateways/http-gateway/src/app.ts:63`, `:189`: Fastify bodyLimit을 설정하지만 http-proxy 기본 streaming parser가 제한된 body parsing을 거치지 않음.
- 재현 `node qa/artifacts/20261023-local-6975fb3/QA-01/probe.mjs`; 설정128B, 본문267B, 기대413 및 upstream0, 실제200 및 body 전체전달. 2회 동일.
- 모든 프록시 prefix에서 Gateway 자원/요청 크기 경계가 downstream 제한에 의존. 수정은 streaming byte limit 또는 지원되는 payload 검증 경로 적용 및 chunked 포함 검증.

### [Medium] GET503 재시도 설정이 무시되어 장애 upstream에 11회 요청
- `gateways/http-gateway/src/app.ts:195`: maxRetriesOn503를 http-proxy top-level에 전달하나 설치된 reply-from12.6.5는 reply.from options(`replyOptions`)에서 읽음.
- maxRetries1 기대 최대2 calls, 실제11, 2/2. `probe-results-first.json`, `probe-results.json`.
- 장애시 호출증폭/지연. 올바른 옵션 경로 및 zero retry 설정 처리 확인 필요(라이브러리 `||10` 기본값도 유의). 기능 안정성 개선 전 차단 권고.

### [Medium] Header timeout을 504 대신502로 응답
- `gateways/http-gateway/src/app.ts:203`: library는 UND_ERR_HEADERS_TIMEOUT을 FST_REPLY_FROM_GATEWAY_TIMEOUT(status504)으로 감싸 전달하나 매핑은 원본 UND_ERR만 검사.
- 설정40ms/응답1500ms 지연, 실제502/GATEWAY_BAD_UPSTREAM. `probe-results.json` timeout 케이스.
- 오류 계약·timeout 관측 왜곡. library error.code/statusCode/cause를 고려한 매핑과 실제 timeout 회귀 검증 필요.

## 검증/한계

`pnpm typecheck`, `pnpm build` PASS. lint script 없음(N/A). 테스트23 PASS/0skip. 테스트 Redis 고정6381을 QA전용 Vitest pre-transform으로16400 변경; assertions/제품동작은 변경없음. upstream stub은 장애/프록시 행위만 검증하며 실제 다서비스 E2E로 보고하지 않음. 초기 harness 경로 오류는 교정 후 재실행 완료.

PERFORMANCE: 순차 측정 완료. direct User와 Gateway profile을 비교했으며 목표 미정으로 BASELINE ONLY 판정. 상세 수치는 마지막 성능 절 참조.


## 최종 성능 상태

PERFORMANCE **BASELINE ONLY 완료**. `../QA-02/performance.md`, `../QA-02/metrics.json`, `../QA-02/samples.jsonl`에실측원자료. 90,000기본요청+600상태변경/전파표본,오류0. 동시성1/5/20단계별N1000×3; p99탐색값. 실제100distinct users batch측정. 상태변경은N100×3. auth/DB lock등개별구간과scheduler처리량은N/A.
