# WGO 로컬 QA 결과 — 2026-10-23

3개 QA 에이전트로 기능을 병렬 검증하고 성능은 User/Gateway→Post/Map→Notification/Moderation→통합 WS 순차 실행했다. 기준 6975fb3. 결과는 전체 PASS가 아니다. 확인된 결함 7건(High4/Medium3), 미구현 연결 BLOCKED, 장기/운영 부하 NOT RUN을 구분한다.

기존 suite 561개 PASS: Gateway23+User203(직접 RPC 포함)+Post117+Map40+Notification83+Moderation79+Realtime16. 추가 경계/장애/통합 프로브는 별도 보고서에 기록했으며 suite 수에 중복 합산하지 않았다.

- QA00 환경 PASS; QA01 FAIL; QA02 실행범위 PASS; QA03 서버 PASS/client BLOCKED.
- QA04/05/06/07 실행범위 PASS; QA08 검색완전성 FAIL; QA09 기본deadline FAIL; QA10 입력계약 FAIL; QA11 실행범위 PASS/후속연결 BLOCKED.
- QA12/13 기능연결 실행범위 PASS/전체제품 E2E BLOCKED. 실제 WS 부하9000건 중1건 command.error; 무오류 성능 PASS가 아니다.

실제 User 로그인→위치→Post Map gRPC→Mongo Outbox→Redis Streams→Map/Notification/Moderation/두 WS replica를 확인했다. 같은 통합DB에서 실제 E5 consumer→Elasticsearch 생성/삭제도 검증했다. 내부 저장소·TCP를 사용했고 Kakao/FCM/OpenAI만 로컬 대역이다. 일부 production components가 한 QA Node 프로세스에 있으므로 독립 서비스 운영성능으로 일반화하지 않는다.

실제 Map 중단/복구, Redis pause 후 Outbox 재발행·at-least-once 중복과 소비자 멱등성, 재접속 후 다른 WS replica에서 댓글 페이지 복구도 확인했다. OS kill 정확시점 전수주입·장기500WS·독립배포/ECS·실제 외부제공자·전체 유실복구는 미실행이다.

보고서: [결함](defects.md), [성능 요약](performance-summary.md), [연결](connection-matrix.md), 각 QA-00~13/report.md 및 원시 JSON/JSONL/log. [Notion 페이지](https://app.notion.com/p/WGO-QA-Codex-402a935219018022bc80c8f98c379561).

제품 코드는 변경하지 않았으며 테스트 harness/증거는 qa/에 보존한다. 검증 명령 및 정리 완료 여부는 validation.md 참조.

산출물 보관: Git에는 Markdown 결과 문서만 포함한다. 보조 코드와 JSON·JSONL·로그·환경 설정 등 원본 증거는 `.gitignore`로 제외하고 실행한 로컬 환경에 보관한다. 따라서 이 문서의 비 Markdown 파일 참조는 저장소를 새로 clone한 환경에는 없으며, 다음 QA 실행 시 환경과 경로를 확인한 뒤 재사용해야 한다.
