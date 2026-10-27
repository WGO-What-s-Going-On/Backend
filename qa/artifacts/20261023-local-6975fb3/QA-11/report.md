# QA-11 Moderation 결과

FUNCTIONAL: 실행 범위 PASS, 후속 제품 연결 BLOCKED.

기준: `6975fb3` (2026-10-23). 제품 코드 변경 없음. 테스트 도중 `qa/`만 untracked. Node 24.21.0. 실제 외부 FCM/OpenAI 호출 없음. 이 보고서는 실행한 범위만 PASS로 판정한다. 실제 Post producer 연결은 QA-07/QA-13 결과와 함께 판정해야 한다.

환경: Redis 8-alpine 127.0.0.1:16403/15 (suite), /12 (재시작 실험). provider는 DI 대역이며 실제 OpenAI smoke suite를 실행하지 않았다.

| Case | 상태 | 기대와 실제/근거 |
|---|---|---|
| A-1 댓글 Stream→검사대역→Redis 결과→활동CAS→ACK | PASS | integration moderation/consumer-safety. synthetic producer 입력 |
| A-2 provider timeout/빈결과/429·500/400 | PASS | unit adapter: 정상판정저장 없이 retryability 구분 |
| A-3 검사중삭제/삭제후생성·활동역전 | PASS | integration lifecycle-activity; 감사결과보존, 활동반영 차단 |
| A-4 이전owner 완료/실패가 새lease 훼손·ACK 방지 | PASS | consumer-safety succeeds=true/false, successor 유지·Pending1 |
| A-5 malformed/DLQ저장실패/poison5회 | PASS | 실제Redis; DLQ실패시 Pending유지 |
| A-6 10초 heartbeat가 실제30초 넘는검사 lease 연장 | NOT RUN | owner상실분기는 실행했으나 장시간 실제timer 연장 자체는 미실행 |
| B-1 최초1시간/30분비활성/10분유예 경계 | PASS | unit+integration의 injected clock; 정책시간과 runtime측정 구분 |
| B-2 새활동/과거지연활동/terminal | PASS | snapshot·staleAt 이전활동·CLOSED/원본삭제·만료 검증 |
| B-3 실제10분 scheduler polling 최악지연 | NOT RUN | 스캔 메서드 검증만 실행, 10분 실시간 대기실험은 미실행 |
| C-1 ENDED4/5,5of8,7of10,10분window | PASS | lifecycle-activity 실제Redis. 정확70% 진입 증거 |
| C-2 분모0·중복/다종류·취소재등록·legacy·고정snapshot | PASS | unit lifecycle+integration. 유예종료경계취소가CLOSED보다 우선 |
| D-1 동시CAS/전이별출력1개/WRONGTYPE 선행검사 | PASS | cas-atomicity 및 concurrent scans; 부분commit 없음 |
| D-2 shutdown중 in-flight저장·ACK 완료 | PASS | consumer-safety integration |
| D-3 checkpoint SAVE→전용Redis restart→PEL회수 | PASS | checkpoint-restart.json: projection/dedup/PEL보존, pending0, 출력 STALE/CLOSED 각1 |
| D-4 crash/volume전체유실 내구성 | NOT RUN | SAVE+graceful restart와 다른보장; 본실험은 전체유실복구를 검증하지 않음 |
| E-1 moderation:events 발행 | PASS | real Redis XADD BOARD_STALE/BOARD_CLOSED 증거 |
| E-2 판단→Post원본→Map검색제외/종료알림 | BLOCKED | consumer/인가API/상태매핑·확정이벤트 계약 부재. CLI로 우회하지 않음 |
| E-3 flagged 댓글 자동삭제/게시글본문검사 | BLOCKED | CONTENT_MODERATION_DECIDED 계약 및 본문조회권한 부재 |

검증: unit 42/42, integration 37PASS+1SKIP. 원래재시작테스트는6383/compose하드코딩 때문에 skip했으며 별도 격리하네스 2/2 PASS로 보완. build/typecheck PASS. lint script 없음.

재시작 1회 관측: restartReady 517.586ms (helper 새테이블준비 포함), PEL 회수관측 51.795ms (50ms polling, idle 강제30001ms). p99 N/A. 정책시각은 가상clock이며 실제10분대기가 아님.

확인된 제품 결함: 실행한 범위에서 없음. 구현미연결은 BLOCKED. Redis snapshot보존 결과로 영속전체유실복구를 주장하지 않는다.

증거: unit.log, integration.log, checkpoint-restart.json/log/mjs, build.log, typecheck.log, commands.log.

성능 완료: performance.md / metrics.json / metrics-raw.jsonl / phase-raw.jsonl. 이벤트N9000 오류0, 최종Pending/lag0. 외부모델 실제성능/품질 N/A.

총괄 실제 producer 보강 PASS: ../QA-13/functional.json 의 실제Post→Outbox→PostCommentCreated→Moderation 결과 eventId/commentId 일치, post-moderation Pending0/lag0. ../QA-13/fault-results.json 의 동일eventId 재발행에서 검사결과 멱등성 확인. synthetic suite와 구분한다.

PERFORMANCE 판정: BASELINE ONLY. event동시성1/5/20×N1000×3회, warming20건. p99 탐색값으로 SLO 통과판정하지않음. 원시샘플 유지. CPU/RSS는 consumer와부하생성기합산이며2ms상태관측이추가부하를만든다. DB물리디스크지속성/운영장애복구는이benchmark범위가아니다.

Moderation 측정끝점은Redis의검사결과가보이는시점이며이어지는활동CAS/ACK완료시점과다르다. CAS분포를별도로수집했고최종Pending/lag0을확인했다. 가상clock정책테스트와실제event측정은분리. scheduler batch/실시간10분poll전이lag·provider실제HTTP지연은이번성능에서N/A.
