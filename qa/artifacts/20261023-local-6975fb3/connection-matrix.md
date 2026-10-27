# 실제 서비스 연결 증거

모든 PASS는 아래 실행 범위에 한정한다. 단위 대역과 실제 transport를 구분한다.

|연결|상태|실행 증거와 한계|
|---|---|---|
|Gateway→User HTTP→Postgres Outbox→user:events|PASS|QA02/live-results.json requestId/correlationId·eventId 일치. Kakao만DI대역|
|Gateway→Post HTTP→Mongo transaction/Outbox|PASS|QA13/functional.json·traces.jsonl|
|Gateway→Map location HTTP→Cassandra/Redis|PASS|QA13 위치갱신, QA04 actualfixture|
|Post→Map create/participation gRPC|PASS|실제ES256 signer/server verifier, 상태별허용/거부. QA04/QA13|
|Post→Map SearchNearbyPosts gRPC|FAIL 일부조건|일반조회PASS. QA09 후보200기본500ms 503/DEADLINE_EXCEEDED 3/3. deadline10000측정과구분|
|Post/WS→User gRPC 제품client|BLOCKED|서버실제RPC/ACL PASS지만제품호출자연결없음 QA03|
|User발급JWT→WS verifier|PASS 설정일치조건|QA13 실제User토큰, localissuer/aud/secret일치. 기본배포인증정책전체PASS아님|
|WS→Post internal HTTP|PASS|실제serviceJWT+userId+mutationId, 댓글1개/반대replica전달 QA12/13|
|Post9종→Outbox→Redis actual wire|PASS|QA07/wire-events.json, HTTP/WS/공식domain command에서발행, matchingstreamId|
|Redis→Map 소유저장소/GEO→검색|PASS+결함|생성/삭제/만료전파PASS. 부분GEO유실검색완전성FAIL QA08|
|Redis→Semantic realE5→ES|PASS 별도worker|QA07/semantic-evidence.json 같은run생성/삭제/ACK. worker종료뒤새event의lag는inactive시험consumer|
|Redis→Notification Dynamo→조회/FCM대역|PASS|QA13 eventId/commentId/알림row/count, 실제FCM단말아님|
|Redis→Moderation Redis검사/projection→출력|PASS|QA11/13, OpenAI대역, 결과와원본상태변경구분|
|Redis→post-realtime→PubSub→다른WS replica|PASS|QA13 실제댓글; QA12 4종이벤트·room격리·재접속검증|
|Moderation→Post 상태적용|BLOCKED|소비자·계약·권한연결없음|
|Notification→사용자WS/주변·종료알림|BLOCKED|미구현/계약부족. 일반Postroom전달로대체안함|
|Gateway→Notification/Moderation HTTP전체|NOT RUN 전체조합|서비스단위HTTP/저장소suite는실행. 통합stack은productionconsumercomponents를직접기동|

통합stack는실제네트워크와저장소를사용하지만여러productioncomponents가하나의QA Node프로세스에있다. 개별서비스프로세스격리/ECS강제종료내구성을검증한것은아니다.
