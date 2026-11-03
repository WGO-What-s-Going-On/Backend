# User 칭호·지역 랭킹 연동 완료 보고

기준일: 2026-11-03. 작업 브랜치 `feat/user-activity-rewards`, 시작 HEAD `dd0dfba`.
이번 변경은 User Service에 한정한다. 기존 GCP/Cloud SQL/GCS, JWT/Gateway 경계, 크레딧/성장 재화, API 및 Outbox를 보존했다. 실제 .env, Post/Notification 소스, 운영 DB는 수정하지 않았다.

## 조사 결과와 구현 범위

현재 origin/dev 포함 여부와 깨끗한 시작 상태를 확인했다. Post 계약·mongoose-vote·vote command·실제 serializer, User rewards 전체·기존 migration·Outbox·Gateway 허용 목록/Swagger/테스트를 대조했다.
이전 User는 미구현 PostRegionResolved/postRegion 제안에 의존했고 후보 이벤트를 받지 않았으며 승리 1건을 1점으로 계산했다. 실제 Post는 candidate.regionCode/vote.regionCode를 발행한다. Post 문서의 과거 User 후속 작업 설명과 최신 후보/지역 절의 시점 차이를 실제 생산 코드로 확인했다.

| 영역 | 최종 변경 |
| --- | --- |
| 입력 | PostVoteCandidateSelected 파서, 실제 regionCode 검증, null/누락 구분, selectedAt/closedAt 사용 |
| 원본 저장 | 댓글별 후보·승리 사실과 이벤트별 지역/출처·공감 감사 값 저장 |
| 멱등성 | Inbox eventId와 후보/결과 업무 키 유지, 작성자·시각·지역 충돌 격리, 삭제 선도착/지연 처리 |
| 랭킹 | 후보 +1·승리 +2, 사용자/게시물 후보 상한1, 사건별 지역, KST 창 및 N 경계 |
| 정책 | wgo-titles-v2 신설, 기존 v1 정의/원장/랭킹/지급 이력 보존 |
| 복구 | 기존 durable input_revision/head·정책/지역 잠금·사용자 row lock 및 Pending/Outbox 재시도 재사용 |
| API | 기존 경로 유지, nullable regionName, 점수 부족량 필드 추가와 기존 alias 유지, 정책별 최신성 검사 |
| 문서 | WGO_TITLE_POLICY, REWARDS_CONTRACT, README를 실제 계약으로 갱신 |

소식통은 유효 활동10회, 리포터는 각각 타인 AGREE10명 이상인 본인 댓글10개, 특파원은 서로 다른 유효 승리5건으로 유지한다. 후보 점수로 특파원을 대체하지 않는다.
천리안은 현재 ACTIVE 특파원 중 해당 행정동의 최근30일 양의 점수 실적이 있는 경쟁자 N에 대해 N<10이면0명, 그 외 floor(N/10)명이다. 여러 지역을 동시에 보유할 수 있다.
원본 후보는 댓글별 보존하되 점수에서는 게시물·사용자당 최대1점을 인정한다. 패배 추가점수는 없고 실제 승리에 +2를 더한다. scoreAtSelection은 공감 수의 감사 값이며 점수가 아니다.
승리 선도착은 +2만 인정하고 가짜 후보를 만들지 않는다. 늦은 후보는 실제 selectedAt/지역으로 계산한다. 명시적 삭제는 제외하고 자연 만료는 유지한다.

동점은 점수 DESC → 실제 계산에 포함된 후보/승리 사실의 마지막 시각 ASC → 숫자 userId ASC다. DB의 기존 last_selected_at 이름을 유지한다. 중복 제거된 후보의 더 늦은 시각은 동점 순위를 바꾸지 않는다. 선택 후보 삭제 후 남은 후보로 대체되면 그 실제 시각을 사용한다.

## PostgreSQL 전환

1. `1793650000000-StoreVoteActivitySnapshots`: 후보 종류, source_region_code/state/event_id 및 score_at_selection, 부분/유니크 인덱스, 유효 활동 view 확장.
2. `1793651000000-ApplyRegionalTitlePolicyV2`: 랭킹 유니크 키에 policy_version 추가, 입력 revision 증가. PostgreSQL 자동 제약명은 실제 컬럼 정의로 조회한다.

기존 적용 migration을 수정하지 않았다. KNOWN/NULL/MISSING/LEGACY를 구별하며 기존 게시물 지역을 사건 지역으로 복사하지 않는다. 지역명·버전을 생성하지 않는다. 기존 사용자/정책/원장/칭호/랭킹 snapshot/Outbox는 DDL로 삭제하거나 덮어쓰지 않는다. 새로운 두 migration은 destructive down 대신 forward migration을 요구한다.
실제 PostgreSQL 이전 테스트에서 옛 정책·원장·지급/이력·랭킹·지역 projection이 그대로 유지됨을 확인했다. 원본으로 확인된 LEGACY 사실 보충과 기존 원장 불변도 검증한다.
미확인 지역/시각은 그 사실만 지역 점수에서 제외하며 전역 승리 실적이나 다른 지역의 알려진 점수를 바꾸지 않는다. API는 제외 건수와 READY_WITH_EXCLUSIONS를 제공한다.

## Git 작업 단위

| 커밋 | 범위 |
| --- | --- |
| cc47313 — feat(user): integrate vote candidate and region events | 입력 파서·실제 Post serializer 소비 계약 테스트 |
| 481877a — feat(user): persist candidate selection activities | 후보/지역 영속화·멱등성·신규 schema·이전 테스트 |
| e7ceb04 — feat(user): apply regional ranking scoring policy | v2 점수·랭킹·API/Swagger·경계 테스트 |
| test(user): verify title and regional ranking integration | 본 보고서·Redis/PostgreSQL/Outbox 통합 검증·마지막 경계/조회 범위 보강 |

각 커밋 전에 관련 테스트와 User 타입 검사를 실제 실행했다. 마지막 커밋 SHA와 최종 상태는 `git log dd0dfba..HEAD --oneline`, `git status`로 확인한다. push/PR/merge/배포는 수행하지 않는다.

## Notification 인계

Stream은 `user:events`, Redis 필드는 eventId/eventType/data다. data 내부는 기존 `type/version/payload` User envelope이며 Post의 eventType/schemaVersion으로 바꾸지 않는다.

| type | 의미와 소비 시 주의 |
| --- | --- |
| USER_BADGE_GRANTED / USER_BADGE_REVOKED | 실제 상태 전환만 발행. 공식 badgeId/code/name/stage, policyVersion, userId/sourceEventId. 천리안은 regionCode/rank/score/rankingRunId/window/competitors/slots/reason 등 포함 |
| USER_LEVEL_CHANGED | 최초/상승/하락을 changeType INITIAL/UP/DOWN으로 구분 |
| USER_CREDIT_CHANGED | 실제 원장 증감에 ledgerId/delta/잔액/성장 점수 포함 |

정확한 필드 이름은 REWARDS_CONTRACT를 따른다. 즉시 계정/특파원 자격 상실 회수는 기존 runId/지역/사유를 사용하고 미계산 순위/점수를 만들지 않는다. regionName은 null이다.
전송은 at-least-once다. Notification은 독립 group/Inbox에서 eventId 중복 제거와 알림 DB commit 후 XACK, Pending 회수/DLQ가 필요하다. sourceEventId는 regional-ranking:runId 등 운영 작업 ID일 수도 있다. 같은 상태 재계산은 새로운 획득 알림을 만들지 않는다. 복수 지역의 지급/회수는 지역별 전환이다. Notification Service와 FCM 연동은 별도 작업이다.

## GCP 배포 전 운영 인계 및 미검증

- 기존 Cloud SQL Auth Proxy/Workload Identity/마이그레이션 계정 권한, DB_CONNECTION_MODE/DB_POOL_MAX, Redis ACL, Gateway/JWT/GCS 설정을 유지한다.
- 먼저 `USER_REGIONAL_RANKING_ENABLED=false`로 지역 작업을 일시 중단하고 백업·신규 migration·LEGACY 원본 점검·필요한 승인 replay를 진행한 뒤 활성화한다. 현재 지역 자격은 새 정책 재평가에서 회수될 수 있으나 과거 지급 기록은 보존한다.
- `USER_TITLES_ENABLED=true`, `USER_TITLE_REGION_CONTRACT=vote-region-v1`을 확인하고 준비 후 `USER_REGIONAL_RANKING_ENABLED=true`로 전환한다. none은 지역 랭킹 중단 계약 옵션이다. USER_REWARD_POLICY_JSON은 별도 승인된 크레딧 설정이며 새 금액을 승인한 것은 아니다.
- Post 게시물 지역 백필은 과거 Outbox를 바꾸지 않으며 후보를 소급 발행하지 않는다. 근거 없는 후보를 만들거나 NULL/MISSING 사건을 현재 게시물 지역으로 바꾸지 않는다.
- LEGACY 보충은 승인된 원본 확인 replay만 사용하고 기존 Inbox/원장을 지우지 않는다. 처리된 eventId는 중복 제거되므로 새 승인 eventId와 원본 근거를 관리해야 한다. 원본이 없으면 지역 미확인으로 남긴다.
- User 스키마/소비자 준비 후 Post 실제 생산자를 연결한다. Pending/DLQ·입력 revision·랭킹 head·Outbox 지연·Swagger 수집 artifact를 확인한다.
- 실제 GCP 배포/Cloud SQL IAM·Proxy 장애, 운영 데이터 백필, HA/대규모 부하, MongoDB 생산 트랜잭션부터의 운영 E2E는 이번 로컬 검증에 포함하지 않았다.
- 로컬 계약 테스트는 실제 Post 이벤트 생성기/직렬화 함수를 실행한다. MongoDB 생산자 프로세스를 실행했다고 주장하지 않는다.

## 최종 실제 실행 결과

Node 24.13.0 / pnpm 10.33.0, 일회용 PostgreSQL 18·Redis 8에서 실행했다. User 테스트는 파일별 임시 DB를 생성/삭제한다. Redis DB10~15와 Gateway 전용 6381 포트는 별도 테스트 인스턴스이며 운영 Redis를 사용하지 않았다.

| 검증 | 실제 결과 |
| --- | --- |
| User 전체 테스트 | 26개 파일, 505개 전부 통과, skip 없음 |
| User typecheck / build | 모두 통과 |
| HTTP Gateway 전체 테스트 | 5개 파일, 88개 전부 통과, Redis 통합 포함 |
| HTTP Gateway typecheck / build | 모두 통과 |
| 기존 Post 후보/지역 생산 계약 테스트 | 36개 전부 통과 |
| Post serializer → User 파서 계약 | User 전체 테스트에 포함, 실제 Post 생성/직렬화 코드 사용 |
| 포맷 | 루트 npm run format 실행, 무관한 포맷 변경은 원래 내용으로 복원 |

User 전체 실행은 `RUN_GATEWAY_INTEGRATION=1`, `RUN_REWARDS_GATEWAY_INTEGRATION=1`, 전용 테스트 컨테이너 `USER_REWARDS_RESTART_CONTAINER`를 설정한 `pnpm test --maxWorkers 1`이다. 실제 Redis 재시작과 다른 Redis 테스트가 겹치지 않도록 순차 실행했다. 교차 인증 검증에 필요한 WS Gateway 빌드도 실행해 통과했다.
Post 로컬 node_modules가 없으므로 기존 User Vitest/config에 Post를 root로 지정하여 Post의 `test/vote-candidate-event.test.ts` 자체를 실행했다. Post 소스/의존성 파일을 변경하거나 MongoDB 통합을 실행하지 않았다. 별도 lint 스크립트는 두 대상 서비스에 없다.

추가 검증은 후보1/승리2/합계3, 복수 후보 상한/일부 삭제, 중복 eventId/업무 키, 승리·삭제 선도착, 지역 정상/null/누락/오류 및 사건별 다른 지역, selectedAt/closedAt 창 경계, 특파원4/5승, N9/10/19/20, 동점·생존 후보 시각, 다중 지역, 지급/회수/재획득, 중복 Outbox 방지, commit rollback/Pending 복구/워커 재실행, 기존 데이터 이전 보존을 포함한다.
실패 주입 테스트의 PostgreSQL/Nest ERROR 로그는 의도한 rollback 경로이며 최종 테스트 종료 코드는 0이다. 실행 로그는 작업 공간의 `.runtime/user-title-v2/`에 보관한다.
