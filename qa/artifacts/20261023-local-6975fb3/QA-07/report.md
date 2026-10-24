# QA-07 실제 이벤트 발행·fan-out 검증

상태: 실행범위 PASS, 일부정밀 장애주입 NOT RUN. 정상 producer를 synthetic XADD로 대체하지 않았다.

|Case|상태|근거|
|---|---|---|
|A 9개 Post domain event|PASS|QA13/functional.json 07-A, wire-events.json. 실제HTTP/WS와 PostLifecycle.scheduleExpiration/expire 명령으로9종발행|
|B Outbox/Stream envelope/ID|PASS|10개Outbox row의 PUBLISHED·streamId와Redis실제ID일치. 외부/내부eventId·eventType·schemaVersion1·producer 일치|
|C Map/Notification/Moderation/Realtime|PASS|QA13 실제사용자→Gateway→Post/MapRPC→각소비자. durable 결과+조회+Pending0/lag0. WS replica2|
|C Semantic realE5|PASS|semantic-helper.mjs, semantic-evidence.json. 같은통합DB/Redis의실제PostCreated→E5384→ES, PostDeleted→ES제거→ACK. helper종료후새이벤트의semantic lag는inactive시험consumer이며자동처리됐다고주장하지않음|
|D commit전rollback|PASS (실DB+오류주입)|QA05/integration-results.json: appendEvent실패→domain/counter/status rollback|
|D XADD실패·timeout후같은ID중복|PASS (실제Redis pause)|QA13/fault-results.json: HTTP201+durablePENDING, unpause후같은eventId PUBLISHED, wire중복가능·알림count1·Moderation결과불변|
|D lease/reclaim·복수worker·staleowner|PASS (기존suite 범위)|Post/Event suite reclaim와ID유지, QA10/11 CAS/owner분기. 실제OSkill로모든타이밍을전수재현한것은아님|
|E malformed/poison/DLQ실패/Pending회수|PASS (소비자suite)|QA10/11/12 실제Redis 통합테스트. 서비스별supported/ignored 정책구분|
|E FAILED Outbox재처리|PASS|QA05 publishes all nine contracts and safely replays quarantined events with the same ID|
|D XADD완료직후PUBLISHED저장전OSkill·모든소비자DBcommit직후OSkill|NOT RUN|코드수준실패주입/Redis응답유실로일부구간확인, OS중단전수실험은미실행|
|E PUBLISHED이후Stream전체유실 자동복구|BLOCKED|현재원본재구축/운영재처리절차영역. 자동재발행보장없음|

## 소비자별 계약

- Map: PostCreated 공간투영, PostDeleted/Expired terminal 상태. 나머지 활동은 ignored ACK.
- Semantic: 생성인덱싱/삭제·만료제거. 활동은 인덱싱대상아님.
- Notification: 작성자댓글·공감과취소/삭제/version/terminal처리. 참가자를새구독자로만들지않음.
- Moderation: 생성projection·댓글검사·활동/취소/version·terminal. provider판단과Post원본변경은별도미연결.
- Realtime: 생성4종만PubSub/room전달, 취소·삭제·만료미지원은사용자전달PASS아님.

## 성능 경계

통합WS client send→다른replica receipt는QA13. User이벤트는QA02, consumer 자체지연QA10/11, SemanticQA09에분리. commit→XADD·consumer 시작/내부ACK시각의전구간분해p99는현재코드계측이없어 N/A. Outbox createdAt/publishedAt 또는polling시각을commit timestamp로바꾸어쓰지않는다. 전체지연은부분p99를더해계산하지않는다.
