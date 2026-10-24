# QA-13 통합 실행 결과

FUNCTIONAL: 구현된연결범위 PASS, 제품전체E2E BLOCKED/일부실험NOT RUN. 시나리오를완성한것처럼빈연결을대역으로메우지않았다.

- 실제User로그인(외부Kakao만대역)→프로필→Gateway위치→Map Cassandra→Post ES256 gRPC→Mongo/Outbox→Redis→Map/Notification/Moderation/WS 확인. User발급토큰으로두WS연결. 전체서비스통합에약관/vote를한여정으로추가하지않았지만QA02/06에서실제검증.
- 실제WS comment.create→Post serviceJWT/내부HTTP→댓글1개→OutboxeventId→반대replica수신, Dynamo알림count1, ModerationeventId결과. 같은mutationId재전송중복없음.
- 9종이벤트발행은최초10개Outbox/Stream확인. 만료는productionLifecycle.scheduleExpiration/expire명령으로실행. 직접DB상태강제변경이나정상경로XADD아님.
- 삭제/만료→Mapterminal/검색제외, 삭제후publicGET404/새댓글403/기존WS post.get WS_POST_REJECTED. Moderationprojection CLOSED.
- Semantic은같은통합Mongo/Redis/실제Post요청을별도productionSemanticConsumer+실제E5모델로연결. QA-07/semantic-evidence.json. 모델준비뒤생성/삭제/ES/ACK증거. 다른4소비자와계약별fanout관측.
- 실제MapgRPC중단→Post503/Outbox무추가, restart후약1051ms에생성201. reconnectbackoff는실패로단정하지않고재시도관측.
- 실제Redispause→댓글201/OutboxPENDING→unpause→약1643ms에PUBLISHED/활성4group backlog0. 같은eventId wire2개(at-least-once)지만알림row/count1. 중복재전달후Moderation결과동일. 이수치는N1장애관측이며p99아님.
- semantichelper종료뒤발생한event는그group에lag가남는다. 이는중단한시험consumer이며모든새event의5group동시drain을주장하지않음. fault회복기준은실제활성4group으로고정.

증거: functional.json, traces.jsonl, stack-manifest.json, fault-results.json, ../QA-07/wire-events.json, ../QA-07/semantic-evidence.json. 초기하네스잘못된ws import/삭제GET200기대는교정했고제품defect로집계하지않음.

NOT RUN: 각외부의존성별OS SIGKILL을DBcommit/ACK의정확한사이에전수주입, 트래픽중서비스별SIGTERM후동일DB재시작회복, 모든엔드포인트의전체journey결합. consumer저장/ACK실패의코드주입실험은QA10/11/12에별도실행. lifecycle10분실시간대기/volume전체유실복구/500WS연결과느린네트워크장기부하는미실행.

BLOCKED: publicGatewayidentity, 실제UsergRPC제품client, moderation판단→Post, 사용자별notificationWS, 댓글공감·투표이벤트, 공개주변검색전체조합. 부분GEO누락/기본500ms밀집검색은별도확인된FAIL.

PERFORMANCE: 실제WS→Post→Outbox→반대replica구간을배타권으로측정후 performance.json/performance-raw.jsonl 기록. 모든요청은localloopback이며동일QA Node프로세스의productioncomponents라는한계를공개한다.

## 최종 통합 성능
실제 Post→Outbox→다른 WS replica 9000건 중 1건 command.error. C20 성공 표본 p99는 응답475.98~1005.76ms, 다른 replica479.27~1009.78ms. DB 개수/활성4group drain은 9/9 PASS. 전체 무오류 PASS가 아니며 상세·원시 자료는 performance.md 및 performance.json 참조.
