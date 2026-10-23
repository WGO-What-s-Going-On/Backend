# QA-10 Notification 결과

FUNCTIONAL: FAIL — Push 구독 잘못된 입력에 HTTP500 재현. 나머지 실행 범위 PASS, 일부 BLOCKED/NOT RUN.

기준: `6975fb3` (2026-10-23). 제품 코드 변경 없음. 테스트 도중 `qa/`만 untracked. Node 24.21.0. 실제 외부 FCM/OpenAI 호출 없음. 이 보고서는 실행한 범위만 PASS로 판정한다. 실제 Post producer 연결은 QA-07/QA-13 결과와 함께 판정해야 한다.

환경: Redis 8-alpine 127.0.0.1:16402/15, DynamoDB Local 127.0.0.1:18002. UUID 테이블 및 자체 Redis key만 생성/정리. integration suite의 producer는 synthetic XADD이며 FCM은 DI 대역이다.

| Case | 상태 | 기대와 실제/근거 |
|---|---|---|
| A-1 Stream→실제 DynamoDB transaction→알림/unread→FCM 대역→ACK | PASS | integration/events: consumer group 생성, count1, unread1, push1, pending0 |
| A-2 자기 행동 제외/5 공감 종류 | PASS | CURIOUS/STILL_HAPPENING/HELPFUL/ENDED/legacy LIKE, 자신은0·타인1; ENDED를 종료로 해석하지 않음 |
| A-3 legacy recipient projection·참여 비구독·잘못된 입력 | PASS | 작성자 projection 없으면 pending, projection 이후 처리; 참가자를 구독자로 만들지 않음; malformed DLQ |
| A-4 실제 Post 명령→Outbox→소비 | PASS | QA13 functional.json: 실제WS comment.create→Post→Mongo/Outbox→알림행count1·commentId일치, post-notification pending0/lag0. 9종 실제이벤트 wire별DBoutbox streamId일치 |
| B-1 첫 저장/Push·후속count·event dedup·Redis snapshot 유실 | PASS | integration/events, DB 원본으로 count2/Push1 유지 |
| B-2 2분 고정window 119999/120000/120001ms | PASS | window-boundaries.json; 각각 알림행1/2/2, 총count2. 실제Dynamo+주입시각 |
| B-3 취소/삭제 역순·재등록·terminal·count0 제외 | PASS | integration/events, version tombstone·중복 차감방지·미전송 취소 |
| C-1 사용자격리/cursor/TTL30일/물리삭제전 필터 | PASS | integration/persistence 5테스트에 포함; owner partition+최신순+페이지 채움 |
| C-2 읽음멱등/unread 원본검증/Redis없음 | PASS | integration/persistence 및 events; stale snapshot 교정 |
| C-3 다중기기/소유권/legacytoken/invalid정리 | PASS | 실제 Dynamo transaction 및 production Firebase adapter + SDK대역 |
| D-1 transaction 실패/응답유실/commit이후 중단/ACK실패 | PASS | injection은 코드 수준 실패대역, 실제DB commit 확인. count 중복없음·notificationId 유지 |
| D-2 PEL 회수/DLQ 쓰기실패/5회 poison/동시CAS | PASS | 실제Redis XAUTOCLAIM 및 DynamoCAS; busy delivery pending 유지 |
| D-3 delivery PENDING/SENDING lease/부분실패/재전송 | PASS | integration/events; 일시실패만 retry·permanent FAILED·성공token 제외 |
| D-4 FCM500 batch/invalid 정리실패/receipt유실 | PASS | unit firebase adapter의 >500 chunk 및 integration 실제구독·SDK대역. 외부단말 전송 증명 아님 |
| D-5 프로세스 SIGKILL/네트워크단절 중 Dynamo commit 결과불명 | NOT RUN | 기존suite의 오류 injection으로만 실패구간 검증, 실제 OS kill은 미실행 |
| E-1 production 신원미연동 503 / 로컬헤더검증 | PASS | controller unit test. 실제 Gateway인증 연결을 뜻하지 않음 |
| E-2 댓글공감/답글/주변150m/종료/사용자별WS | BLOCKED | 현재 이벤트/수신자/상태적용 계약과 구현 없음. README 외부계약 blocker 확인 |

검증: unit 51/51, integration 32/32, 별도 window 3/3, invalid cleanup 실패 1/1. build/typecheck PASS. lint script 없음. 같은 테스트 중복 실행수를 별도 고유케이스 수로 합산하지 않았다.

확인된 제품 결함: [Medium] 잘못된 Push 구독 입력이 HTTP400 대신500을 반환한다. 아래 defects.md 및 http-validation.json 참조. 미구현 연결은 상기 BLOCKED로 분리한다. Notification 저장소는 DynamoDB이며 root의 PostgreSQL 목표와 다르다.

증거: unit.log, integration.log, window-boundaries.json/log, invalid-cleanup.json/log, build.log, typecheck.log, commands.log. integration 테스트 이름/기대값은 services/notification-service/test/integration/ 원본을 함께 참조.

성능 완료: performance.md 및 metrics.json / metrics-raw.jsonl. 이벤트 N9000, hot post N100, 실제HTTP 4종 각N300 모두오류0. 실제단말도착지연N/A.

총괄 장애 보강: ../QA-13/fault-results.json — Redis XADD 응답 timeout 후 같은eventId 재발행, Notification count1 유지. injected 응답유실과 실제XADD를 결합한 실패구간검증.

실제HTTP입력 추가: 누락token400·정상token/web200 각2/2 PASS. 공백token/unknown platform 각2/2 FAIL(500). product 원인행은 PushSubscriptionService.upsert의일반Error이며기존controller는typeof만검증한다.

PERFORMANCE 판정: BASELINE ONLY. event동시성1/5/20×N1000×3회, warming20건. p99 탐색값으로 SLO 통과판정하지않음. 원시샘플 유지. CPU/RSS는 consumer와부하생성기합산이며2ms상태관측이추가부하를만든다. DB물리디스크지속성/운영장애복구는이benchmark범위가아니다.

HTTP 목록1회차는Nest앱시작직후의recoveryScan과겹친cold상태(p99 146.199ms), 2·3회차warm은2.511/2.176ms. 이를동일warm회귀비교로평균하지않음. event각동시성단계의데이터는계속누적되며같은표본조건반복이아닌순서효과가있음.
