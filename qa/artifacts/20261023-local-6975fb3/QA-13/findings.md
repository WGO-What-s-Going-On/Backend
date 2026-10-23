# QA-13 WS 성능 중 command.error 1건 후속 판정

판정: 클라이언트 결과가 불확실해진 요청 1건이 확인됐다. **2초 Post HTTP deadline이 작동한 상황과 강하게 일치하지만, 원본 오류 envelope가 보존되지 않아 TimeoutError로 단정할 수 없다. 댓글·카운터·Outbox 멱등성 위반이나 데이터 유실은 확인되지 않았고, 해당 요청의 같은 mutationId 재전송은 실제로 안전하게 성공했다.** 확인된 제품 결함으로 별도 승격하지 않고 성능 오류 관측에 남긴다.

## 확인된 증거

- 원본: `performance-raw.jsonl` 8960번째 행, concurrency20 / repeat3 / index846. 약2005.61ms 뒤 `command.error`를 수신했다. 전체9000건 중1건(0.0111%), 해당단계1000건 중1건(0.1%). 응답오류를 성공표본에 합치지 않는다.
- 대상게시물: `post_801ef262-f776-4e60-8e76-ae68792ad490`.
- 실제Mongo 조회에서 content=`QA-3-846`, authorId=3인 댓글은 정확히1개. commentId=`comment_6994b975-adc2-48fa-ae34-a52fe0debd74`, mutationId=`3c1d130a-e1a6-44c0-ab15-c5512ebfaf39`.
- 해당댓글의 실제Outbox eventId=`evt_9c766505-cea7-49bb-9223-baf67727fbbf`, status=PUBLISHED, totalAttempts=1, streamId=`1792742265300-0`. Redis의해당Stream ID에도같은eventId/commentId가존재한다.
- Outbox createdAt=07:57:43.196Z, publishedAt=07:57:45.301Z, 차이2105ms. 이createdAt은명령에서만든시각으로 **commit시각이아니다**. 따라서2105ms를commit→publish지연이나DBtransaction실행시간으로부르지않는다.
- 부하를재실행하지않고원래mutationId/content/userId로실제WS에한번재전송했다. 약10.645ms 뒤기존commentId의command.result를받았다.
- 재전송전후동일: 댓글총수1030, 같은mutationId댓글1, commentCount카운터1030, 원본Outbox1개. 새댓글·카운터증가·추가Outbox발행없음.
- 증거: `timeout-followup.mjs`, `timeout-followup.json`, `timeout-followup.log`. 기존부하raw는수정하지않았다.

## 코드와 일치하는 설명

`gateways/ws-gateway/src/realtime/post-client.ts:58`의실제HTTP요청은`AbortSignal.timeout(2000)`를사용한다. `src/app.ts:290`의catch는Post의명시적인4xx를`WS_POST_REJECTED`, 그외네트워크/timeout/5xx를`WS_POST_UNAVAILABLE`로변환한다. HTTP응답기다림을중단하는것은서버의Mongo트랜잭션취소나롤백을보장하지않는다.

`services/post-service/src/post/application/commands.ts:120`은같은(postId,authorId,mutationId)의기존댓글을먼저반환하며, 동시유일키충돌도기존결과로회복한다(:154). `post.schemas.ts:74`의partial unique index가이키를보호한다. 이번원본실패요청의재시도에서도이규칙이실제로작동했다.

## 확정하지 못한 부분

원본`performance.mjs`는`reply.type`검증실패를AssertionError로만저장하고reply.code/message/requestId, 당시mutationId를raw에남기지않았다. WS logger도false이고catch에서해당upstream예외를별도로로깅하지않으므로정확한원오류는복구할수없다. 따라서원본이정확히`TimeoutError`였다고하거나응답코드가반드시`WS_POST_UNAVAILABLE`였다고확정하지않는다.

다른성공요청의응답도최대1894.411ms까지늘어났으며, 해당게시물은bucket0의단일commentCount를갱신한다. 동시20명령의트랜잭션/카운터경합, 같은QA Node프로세스에동거하는서비스의event-loop대기등이후보원인이다. DB profiler/transaction retry계수/요청별구간trace를수집하지않았으므로근본병목을특정하지않는다.

## 보고 및 후속 방향

- 기능상태와별도로성능표에timeout부근command.error1건, 관측오류율, 원본2005.61ms를남긴다. 오류1건을숨겨전체9000건성공으로표현하지않는다.
- 성공8999건의p99는성공분포이며timeout이포함된전체지연분포가아니다. 실패요청의원래다른replica수신시각도하네스가기록하지않았으므로새수치를만들지않는다.
- 이번판정은2초deadline을없애거나임의로늘리라는권고가아니다. 운영SLO가없어단발결과만으로성능합격/불합격선을정하지않는다.
- 사용자는결과불확실시에같은mutationId로재전송하고조회로상태를확인해야한다. 이미문서화된재연결계약과일치하며이번단건에서검증했다.
- 후속측정에서는하네스가mutationId/requestId/전체command.error envelope를보존하고Post처리·Mongo retry·WS HTTP구간을연결해야한다. 이는원인분석의증거보강이며현재제품수정은수행하지않았다.
