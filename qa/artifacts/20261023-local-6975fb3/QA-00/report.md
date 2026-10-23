# QA-00 로컬 환경 준비

상태: PASS (로컬 검증 환경 준비). 성능은 준비/시작 단발 관측이며 p99 N/A.

- 기준 커밋 `6975fb3f140a0bca049b3ff2a6ded671aa0129fa`. 계획 기준4104986 이후 변경은 아키텍처 이슈 문서1개뿐. 시작시 tracked/untracked clean.
- Apple M5 10cores, RAM24GiB, macOS kernel25.6.0, Node24.21.0. Docker29.2.1 linux/aarch64, 10vCPU/7.65GiB. 상세 environment.json.
- Docker Desktop은 시작시 정지상태여서 시작함. 기존 실행컨테이너0, 기존이미지/볼륨 보존. wgoqa-* 전용컨테이너/포트/DB/table만 사용.
- User15431/15452, Postgres15432, Redis16400. Post/Map store: Mongo17017 replicaSet rs0/directConnection, Cassandra17042, ES17200, Redis16401. 소비자Redis16402/3/4, Dynamo18002. 통합Redis16405/2, Gateway19080, WS19081/2, Post19302, Map19303/gRPC19551. 통합DB/keyspace/table명 QA-13/stack-manifest.json.
- 각 suite의 하드코딩된 default DB주소는 QA전용 Vitest transform/test복사에서만 치환. 제품 소스나 assertion을 완화하지 않음. 초기 하네스 import/symlink/기대값 오류는 교정·재실행했고 제품결함과 별도 구분.
- 내부HTTP/gRPC/실제DB/Redis 사용. Kakao·FCM·OpenAI는 로컬DI 대역. 임베딩은 실제로 준비된 E5 FP32 모델 사용(QA09). 외부서비스/운영AWS/단말FCM 호출0.
- 3개 에이전트 기능 병렬, DB분리. 성능은 총괄 토큰으로 User/Gateway→Post/Map→Notification/Moderation→통합WS 순차.
- 모든 서비스 typecheck/build, 정의된 tests 실행. lint script 없음은 N/A. 루트 format 및 format:check exit0. 최종 tracked diff 없음. 정리내역 validation.md 참조.
- readiness/health와 실제호출 별개: Map health는존재하지않는 경로를 새로만들지않음. 연결은 실제성공요청·DB·stream으로 확인.

로컬throughput은 운영성능/독립프로세스부하/ECS SLO로 일반화하지 않는다. 해당 서비스 기본폴링은 idle 상태로 남아있어 완전히 유휴호스트 측정은 아니다. 각성능하네스의 표본예산/워밍업 차이를 보고서에 명시한다.
