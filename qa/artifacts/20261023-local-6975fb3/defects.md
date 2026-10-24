# 확인된 제품 결함 7건 및 별도 관측

기준 6975fb3, 실제 로컬 검증. 신규 회귀 여부는 이전 버전과 비교하지 않았으며 기존 WGO-ARCH-04의 Map 문제도 포함한다. 제품 수정은 하지 않았다.

|심각도|문제|근거/재현|수정 방향|
|---|---|---|---|
|High|Gateway 표준 start 실패|package.json:13, dist/server.js 없음. QA-01/start.log|실제 dist/src/server.js와 일치|
|High|Gateway bodyLimit 우회|app.ts:63/189;128B설정/267BJSON→200,2/2|streaming byte limit 및 chunked 회귀|
|High|부분 GEO 유실 시 검색 누락|Map post-index.ts:297; 원본2/GEO1이면 결과1, rebuild후2. QA-08/findings.md|부분누락 감지/원본 기반 복구|
|High|Map 기본500ms 후보조회 deadline 실패|post-index.ts:367; 후보200 HTTP5033/3, 직접RPC code4 3/3. QA-09/default-deadline.json|순차 Cassandra 조회비용/후보상한/별도예산 개선|
|Medium|Gateway GET503 과도한 retry|app.ts:195;maxRetries1에도11upstreamcalls,2/2|replyOptions 경로와0값 처리|
|Medium|Gateway timeout502오매핑|app.ts:203;40ms설정/1500msupstream, 기대504 실제502|wrapped 오류 code/status/cause 매핑|
|Medium|Notification 잘못된 구독입력500|push-subscription.service.ts:22/24; 공백token/unknown platform 각각2/2|BadRequest 및 enum/nonblank 경계검증|

상세 기대/실제, 파일·라인, 재현 명령, 영향과 차단 여부: QA-01/report.md, QA-08/findings.md, QA-09/findings.md, QA-10/defects.md. High는 해결/재검증 전 출시 차단 권고; Medium은 API 계약·장애 호출 증폭 영향에 따라 처리한다.

별도 성능 관측: QA-13 9000건 중 1건 command.error 약2005.6ms, 해당 회차 댓글 DB1030/1030 저장. 오류 payload 미보존으로 원인 미확정; QA-13/findings.md 분석과 performance.md 참조. 확정 결함 7건에 추정 원인을 추가 합산하지 않았다.

미구현 연결은 결함 7건과 별도 BLOCKED: Gateway 사용자 인증, Post/WS 실제 User gRPC client, Moderation→Post, 사용자별 Notification WS, 공개 주변 검색 조합, 일부 알림/투표 이벤트, WS 위치 인가 및 durable replay. connection-matrix.md 참조.
