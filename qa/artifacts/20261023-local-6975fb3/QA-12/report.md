# QA-12 WebSocket 결과

FUNCTIONAL: 자체 및 총괄 통합 실행 범위 PASS, 미구현/미실행 하위 항목 별도.

기준: `6975fb3` (2026-10-23). 제품 코드 변경 없음. 테스트 도중 `qa/`만 untracked. Node 24.21.0. 실제 외부 FCM/OpenAI 호출 없음. 이 보고서는 실행한 범위만 PASS로 판정한다. 실제 Post producer 연결은 QA-07/QA-13 결과와 함께 판정해야 한다.

환경: Redis 8-alpine 127.0.0.1:16404/15. 기존integration은 실제 Redis Streams→Pub/Sub→두 Gateway 인스턴스 injectWS이며, PostClient와 authenticator는 DI대역이다. 이를 실제Post/User 연결성공으로 해석하지 않는다.

| Case | 상태 | 기대와 실제/근거 |
|---|---|---|
| A-1 실제JWT verifier header/cookie/만료/issuer/aud/signature | PASS | auth-boundaries.json 8케이스; synthetic HS256 token, missing/빈subject 포함 |
| A-2 실제User로그인JWT→WS | PASS | QA13 functional.json 13-A-user-login-profile/cross-replica-comment: 실제User로그인발급토큰, 두WS에 동일issuer/audience/secret 설정. 외부Kakao만DI대역 |
| A-3 heartbeat pong누락실제timeout/네트워크disconnect 정리 | PASS | reconnect-boundaries.json: 19083별도실제WS, interval100ms/timeout30ms, autoPong:false 종료1006·connections0, autoPong:true 350ms연결유지. 종료+readiness관측 총1040ms는 heartbeat단독지연 아님 |
| B-1 join/leave/room권한·post.get/comments/create 위임 | PASS | app/subscription unit, 도메인허가PostClient는대역 |
| B-2 serviceJWT로실제Post internal HTTP | PASS | QA13 stack.mjs 실제HttpPostClient 및 Post서비스. join/comment.create command.result 확인 |
| B-3 Map 위치제한 | BLOCKED | 현재board.join은ACTIVE만, 위치인가후속계약 |
| C-1 네생성이벤트 두Gateway룸전달/타룸차단 | PASS | actual Redis + two gateways; producer는synthetic XADD |
| C-2 consumer중단후PEL회수→수신→Pending0 | PASS | integration post-events의실제XREADGROUP/XAUTOCLAIM |
| C-3 실제comment.create→Mongo/Outbox→상대WS | PASS | QA13 13-A-cross-replica-comment eventId evt_09df6d72-f98b-4000-bd66-23d103e3fbff, 반대replica수신+실제알림/검사결과 |
| D-1 같은mutationId 재전송 DB1개 | PASS | QA13 actual WS 같은연결에서2회전송→Mongo댓글1개. 재접속은이증거에포함안됨 |
| D-1b 실제disconnect/reconnect+pagination 복구 | PASS | reconnect-boundaries.json: 실제User JWT·WS19081→disconnect→중단중4댓글→WS19082재접속·재join·post.get·limit2 3페이지, 기대5개누락/중복없음. 같은mutationId재전송후Mongo5개유지 |
| D-2 PubSub단절중자동영속replay | BLOCKED | PubSub영속replay 없음; 계약은재join+post.get/comment.list 조회복구 |
| E-1 잘못된JSON 응답·연결유지/room수제한 | PASS | app/subscription unit |
| E-2 큰메시지/연속joinleave | PASS | reconnect-boundaries.json: 65537byte→1009, 파이프라인join/leave/get 순서보존·최종NOT_JOINED |
| E-2b 느린client/replica프로세스재시작 | NOT RUN | 연결재접속과heartbeat는실행, slow-reader buffer압력/replica프로세스kill은미실행 |
| E-3 삭제후기존room post.get | PASS | QA13 13-B-delete-expire-convergence: WS_POST_REJECTED, Post404. 신규HTTP댓글403 |
| E-3b 만료후기존room 모든후속command | NOT RUN | 삭제조회외모든명령분기전수는미실행 |
| E-4 취소/삭제이벤트/사용자별알림전달 | BLOCKED | PostEvents는생성4종만전달; Notification사용자룸계약없음 |

검증: 기본unit14PASS+integration2SKIP, RUN_INTEGRATION=1 전체16PASS. 두명령에서동일14개반복은고유테스트합산안함. 추가JWT경계8/8. build/typecheck PASS. lint script 없음.

확인된 제품 결함: 이 실행범위에서는 없음. 기존 scripts/benchmark.ts는 port3302/Mongo27017/Redis6380 고정를쓰므로격리QA에서실행하지 않았다. 과거P95를현재p99로보고하지 않는다.

증거: unit.log, integration.log, auth-boundaries.mjs/json/log, build.log, typecheck.log, commands.log.

성능: 실제Post→WS구간은총괄QA13자료를참조. 자체suite의몇초실행시간은APIp99가아니다.

총괄 교차증거: ../QA-13/functional.json, stack.mjs, ../QA-07/wire-events.json. 4 consumer groups Pending0/lag0, post-realtime replica2 확인.

추가 기능 하네스: reconnect-boundaries.mjs/json/log. 5개 케이스 모두PASS. 기존기능로그와별도로재현가능하며새실제User와게시물은QA통합스택안에서만생성했다.

## 최종 통합 성능
실제 Post→Outbox→다른 WS replica 9000건 중 1건 command.error. C20 성공 표본 p99는 응답475.98~1005.76ms, 다른 replica479.27~1009.78ms. DB 개수/활성4group drain은 9/9 PASS. 전체 무오류 PASS가 아니며 상세·원시 자료는 ../QA-13/performance.md 및 performance.json 참조.
