# WGO User 확정 칭호 정책 구현·검증 보고서

기준: 2026-10-31. 현재 브랜치 `feat/user-activity-rewards`, HEAD `de72f1e` 위의 로컬 변경을 보존·확장했다. commit/push/PR/merge/배포는 수행하지 않았다.

**소식통·리포터·특파원은 성장 점수와 분리하여 기본 자동 평가 ON으로 구현했다. 천리안의 지역별 계산·저장·지급/회수는 User 측에서 구현·검증했지만, 실제 Post 이벤트의 행정동 수신 계약이 없어 현재 운영 지역 연동은 미완료다.**

상세 정책·이벤트 예시·외부 계약 인계·운영 절차는 [WGO_TITLE_POLICY.md](WGO_TITLE_POLICY.md), 기존 입력/출력 계약은 [REWARDS_CONTRACT.md](REWARDS_CONTRACT.md)를 참조한다.

## 1. 이번 확정 정책의 구현 상태

| 칭호 | 실제 구현 조건 | 현재 자격 회수 / 과거 달성 |
| --- | --- | --- |
| 소식통 | 유효 작성·댓글·공감 참여 10회 | 취소·삭제로 10회 미만 또는 비활성 계정이면 회수; 과거 달성 보존 |
| 리포터 | 서로 다른 본인 댓글 10개가 각각 서로 다른 타인 AGREE 10개 이상 | 기준 충족 댓글이 10개 미만 또는 비활성 계정이면 회수; 최초 달성·최고 단계 보존 |
| 특파원 | 서로 다른 postId/resultId의 유효 대표 의견 선정 5건 | 게시물/댓글 삭제로 5건 미만 또는 비활성 계정이면 회수; 과거 달성 보존 |
| 천리안 | 각 행정동에서 최근 30일 실적이 있는 ACTIVE 특파원 N>=10 중 floor(N/10) | 지역 순위 이탈·특파원 자격 상실·계정 비활성·지역 귀속 철회 등으로 지역별 회수. 다른 지역 자격과 특파원 자격은 별도 유지 |

사용자 추가 답변에 따라 자연 만료된 게시물의 실적은 유지한다. 현재 자격과 과거 달성 이력을 구별했다. 칭호는 각 조건을 독립 판정하며, 특파원에 리포터 보유를 추가 필수 조건으로 붙이지 않았다.

소식통 참여는 게시물/댓글 고유 ID와 사용자별 공감 대상 ID로 집계한다. 공감 종류를 바꾸거나 취소·재공감해도 같은 대상의 참여를 중복 계산하지 않는다. PostParticipantJoined/Left는 기존 상태 projection으로 보존하되 칭호 카운터에 더하지 않아 댓글과 동반되는 입장 이벤트를 이중 계산하지 않는다.

Post README/상태 문서, CommentReactionType enum과 PR #72 wire 계약에서 AGREE=맞아요를 대조했다. HELPFUL/DIFFERENT와 자기 공감은 리포터에 합산하지 않는다. 단일 댓글의 AGREE 100개는 리포터의 조건 충족 댓글 1개다.

## 2. 기존 방식에서 바뀐 점과 스위치

- 공식 네 칭호의 점수 임계값 판정을 제거하고 실제 활동 지표를 계산하는 TitleService로 분리했다. 임의 code의 기존 테스트/레거시 badge 규칙과 credit/growth 계산은 보존했다.
- 기존 Consumer/Inbox/Projection/원장/Growth/Outbox 및 멱등성·역순 방어를 재사용했다. UserRewardEvent emitter를 공유하여 기존 envelope를 유지했다.
- 소식통/리포터/특파원은 credit 지급 OFF여도 평가·부여·회수한다.
- `USER_TITLES_ENABLED=true`가 기본이며 명시적 false만 평가를 중단한다.
- `USER_REGIONAL_RANKING_ENABLED=true`가 기본이다. 지역 계약 준비 상태는 별도 검증한다.
- `USER_TITLE_REGION_CONTRACT=none`이 기본이며 현재 실제 지역 수신은 불가하다. `post-region-v1`은 제안 생산자가 구현·검증된 뒤에만 설정한다.
- `USER_REWARD_POLICY_JSON`이 없으면 credit/growth 지급은 계속 OFF다. 실제 지급량·일일 한도·레벨 임계값의 새 승인 근거는 없으므로 운영 수치를 발명하지 않았다.

현재 기존 미커밋 작업 트리를 확인·백업한 뒤 진행했다. 다른 브랜치로 이동하거나 reset/rebase하지 않았다. User 테이블에 거주지·선호 지역·소속 지역 필드를 추가하지 않았다. 실제 .env도 변경하지 않았다.

## 3. 지역별 랭킹·재현성·동시성

지역은 대표 의견으로 선정된 **게시물의 행정동 H snapshot**이다. 현재 사용자 GPS/프로필 이동으로 과거 실적을 재귀속하지 않는다. 한 사용자가 여러 행정동 천리안을 동시에 보유할 수 있다.

KST 자정 T의 `[T-30일,T)`에서 `vote.closedAt` 기준 대표 의견 1건=1점이다. 득표수 가중치는 없다. 유효 선정 5건으로 특파원 자격이 있고 해당 지역 창에 최소1건 있는 ACTIVE 사용자만 경쟁 인원이다. 5/9명→0명, 10/19명→1명, 20명→2명, 50명→5명, 100명→10명을 선정한다.

동률은 기존 팀 합의가 확인되지 않아 **점수 DESC → 마지막 선정 시각 ASC → userId ASC** 초안을 적용했다. 같은 점수를 먼저 달성한 사용자를 우선하며, 같은 시각까지 동률이면 작은 ID가 우선한다. 이때 오래된 계정에 유리할 수 있다는 영향을 명시했다.

계산 결과는 날짜·입력 revision·정책·창·경쟁/선정 인원과 개별 resultId/postId/commentId/closedAt/regionVersion 근거를 불변 snapshot으로 저장한다. 새 revision으로 정정할 때도 과거 snapshot을 덮어쓰지 않는다. User에 없는 전체 원본 과거 변경 이력을 복원했다고 주장하지 않는다.

DB advisory lock·지역 job lock·정렬된 사용자 row lock과 트랜잭션으로 중복 scheduler와 지급/회수를 보호한다. 동일 결과 재평가는 이벤트를 추가하지 않는다. 1초 주기 최대20개 지역 배치이며 오래된 checkpoint부터 처리하여 지역 starvation을 방지한다. 재시작 시 최신 한국 자정 창으로 catch-up한다. 지연 이벤트·계정 상태·삭제·정정은 재계산을 요청하며 과거 날짜 작업이 최신 지급 상태를 덮어쓰는 것은 거부한다.

활동 평가에서는 해당 입력으로 지표가 바뀌는 사용자만 칭호를 재평가하여, 공감이 많은 댓글에서 무관한 참여자를 매번 평가하던 비용을 줄였다. 집계/랭킹 SQL·부분 인덱스·지역 배치도 추가했다. 대규모 운영 부하/HA 검증은 아직 수행하지 않았으며 정책 전역 fence의 직렬화 비용은 운영 전 측정 대상이다.

## 4. 지역 정보 출처와 실제 외부 연동 상태

| 항목 | 확인 결과 |
| --- | --- |
| Post 원본 지역 | PostRecord/PostSchema에 선택적 region `{code,name}` 존재 |
| Post의 지역 저장 | POST_REGION_ENABLED=true에서 기존 Map ResolveRegion 후 저장 |
| Map ResolveRegion | 좌표→행정동 H. Post ES256 호출자 전용이며 User의 postId 조회가 아님 |
| Post 기존 지역/랭킹 REST | 현재 사용자 좌표 조회 또는 다른 정책의 집계. 원본 선정 게시물 지역 수신 계약으로 재사용 불가 |
| PostVoteWon | 확인한 PR #72 계약에 행정동 없음 |
| User→Post/Map 인증 조회 | 선정 postId→보존 행정동을 User가 조회할 기존 계약 없음 |

PR #72는 조사 시 open/unmerged이며 SHA `70f35ac2142da954a07417a4355d2a2106880200`을 확인했다. 댓글 공감/선정의 실제 운영 공급도 이 Post 생산자 배포에 의존한다.

**최소 추가 연동은 PostRegionResolved 이벤트 한 종류**다. postId별 H 행정동 code/name/version과 postAuthorId를 기존 Post envelope로 발행하고, 신규/과거 글 backfill·정정·명시적 철회를 전달해야 한다. 선택적으로 PostVoteWon 최상위 postRegion을 추가해 지연을 줄일 수 있다. User 수신·검증·멱등 저장·역순 방어는 구현했지만 Post 생산자는 이번에 만들지 않았다. 상세 JSON 및 nullable 철회 의미는 정책 문서에 있다.

선정 게시물 지역이 없거나 과거 선정 시각을 확인하지 못하면 임의 추정하지 않고 CONTRACT_UNAVAILABLE/INCOMPLETE_SOURCE_DATA를 노출한다. 해당 데이터가 어느 지역에 속할지 알 수 없으므로 불완전성은 보수적으로 지역 신규 선정을 억제한다. 기본 none은 유지하면서 세 칭호는 계속 동작한다.

## 5. DB·Seed·운영 재평가

신규 `1793400000000-ActivateWgoTitles`를 추가했고 기존 migration은 삭제/수정하지 않았다.

- user_activities.source_time_verified: 과거 updated_at을 실제 선정 시각으로 오인하지 않는 확인 플래그.
- reward_title_valid_activities: 삭제·취소 제외 및 자연 만료 유지의 공통 view.
- user_title_progress: 현재 지표, 계정 상태, 최초 달성 시각 집합, 과거 최고 단계.
- reward_post_regions/history: 게시물 귀속과 revision별 정정·철회 감사 기록.
- regional_ranking_state/runs/entries/heads: 영속 checkpoint와 불변 순위·근거.
- user_regional_badges: 기존 UserBadge의 지역별 상세 보유 상태. 전역 천리안은 활성 지역의 요약.
- 기존 user_badge_history: nullable region_code/ranking_run_id/reason 추가.

migration에서 기존 네 칭호를 insert-if-absent하므로 별도 seed 누락이 기본 ON 칭호를 막지 않는다. 기존 카탈로그 수동 변경·지급·원장·이력은 보존한다. 새 확정 조건에 맞지 않는 옛 임시 지급은 회수 상태로 전환하되 이력을 삭제하지 않는다.

과거 투표는 source_time_verified=false로 시작한다. 원본 closedAt/commentId를 확인하는 동일 결과의 **새 eventId replay**로 보충하고 지역 이벤트도 backfill해야 한다. 이미 성공한 같은 eventId를 반복해도 Inbox가 차단하므로 문맥 보충이 되지 않는다. 기존 보상 중복 지급 없이 보충하도록 했다.

기존 maintenance는 활동/보유 이력이 있는 사용자만 20명씩 처리하며 첫 세 칭호를 점진 보정한다. 기존 CLI는 read-only 비교/진행 조회와 명시적 apply를 제공한다. 새 migration down은 새 projection/snapshot 메타데이터를 제거하지만 기존 사용자·원장·UserBadge는 보존한다. 운영 down은 원본 replay·backup·코드 rollback을 함께 계획해야 한다.

## 6. API·Gateway·Swagger·Notification

새 공개 endpoint 없이 기존 `/me/growth`, `/me/credits` 응답에 titles를 추가했다. 기존 `/me/badges`와 `/me/badges/history`를 재사용했다.

현재/최고 과거 단계, 단계별 조건/진행/잔여/최초 달성, 다음 칭호, 지역별 점수/순위/경쟁 인원/선정 인원/보유/자격/준비 상태/컷/추가 실적을 제공한다. 천리안은 절대 임계값이 아니므로 일반 remaining=null이며 지역별 snapshot 컷을 따로 제공한다. upToDate로 미반영 날짜/revision을 구분한다. 이력에는 지역·계산 run·사유를 추가했다.

Gateway 최신 ES256 인증·신뢰된 신원 전달을 유지했다. 새 route가 없어 이번 정책 추가로 Gateway 허용 목록을 확대하지 않았다. User Swagger 중첩 schema와 실제 Gateway 병합·호출을 검증했다.

기존 user:events envelope/version:1/Outbox와 네 타입은 유지했다. 공식 칭호에는 badgeCode/badgeName/stage, 지역 칭호에는 regionCode/regionName/rank/score/competitors/slots/rankingDate/windowStart/windowEnd/rankingRunId/reason을 추가했다. badgeId와 기존 필드를 제거하지 않았다. 현재 GetBadge gRPC는 존재하지 않으므로 없는 API를 가정하지 않고 출력 메타데이터로 Notification 표시를 지원한다.

한 상태 전환당 한 Outbox row이며 반복 평가/같은 snapshot으로 중복 생성하지 않는다. 물리 전송은 기존 at-least-once이므로 Notification은 별도 group/Inbox로 eventId 중복 제거가 필요하다. Notification Consumer/FCM은 이번 범위 밖이며 수정하지 않았다.

## 7. 실제 검증

Node 24.13.0/pnpm 10.33.0, 새 격리 PostgreSQL18/Redis8(AOF always, noeviction)을 사용했다. 기존 DB/Redis/consumer group을 초기화하지 않았다. 테스트 소유 임시 DB·키만 정리했다.

| 실행 | 결과 |
| --- | --- |
| User 전체 `RUN_REWARDS_GATEWAY_INTEGRATION=1 pnpm test` | **18 files, 388 passed / 2 skipped** |
| 최종 보상 suite + 실제 Redis restart + 실제 HTTP Gateway | **69 passed / 0 skipped** (전체 User와 중복 포함) |
| HTTP Gateway 전체 pnpm test | **66 passed / 2 skipped**, 4 files passed / 1 file skipped |
| User / Gateway typecheck | 통과 |
| User / Gateway production build | 통과 |
| root npm run format | 완료, 무관한 파일 포맷 변경은 원래 바이트로 복원 |
| 변경 TS/JSON Prettier check / git diff --check | 통과 |
| 빌드된 전체 AppModule | 실제 PG/Redis/gRPC/HTTP 시작·종료, title ON/credit OFF, 소식통 자동 지급, 인증 growth·Swagger 통과 |
| 빌드된 Seed 두 번 / read-only·apply CLI | 임시 DB에서 통과 |
| 전체 migration up/down/up | 임시 DB에서 통과 |
| 기존 사용자·원장·지급 포함 migration 회귀 | 원래 데이터 보존, 신규 projection down/up, Seed 재실행 통과 |

새 title-policy 단위 테스트 12개와 확정 칭호/지역 PostgreSQL·Redis 통합 테스트 29개를 포함한다. 소식통 9/10 및 중계 중복·취소, 리포터 9/10 댓글·한 댓글100공감·종류/자기 공감·취소/재공감/삭제, 특파원4/5·중복 결과·역순·만료 유지, 지역 N 경계 7종·동률·30일 경계·재진입·다중 지역·중복 scheduler·장애 commit rollback·계정 상태3종·지역 정정/철회/역순·누락 준비 상태 등을 검증했다.

기존 Post 이벤트 전체, 원장·한도·재지급·정책 버전·Outbox 네 타입·ACK/XAUTOCLAIM/DLQ, 사용자 인증/프로필/약관/차단/탈퇴/gRPC 회귀를 유지했다. 옛 임시 점수 기반 WGO 칭호 테스트는 generic fixture code로 보존하고 공식 WGO 조건은 새 테스트로 검증했다.

첫 병렬 전체 실행에서는 **기존 탈퇴 scheduler↔Kakao 재가입 경합 테스트가 한 번 401/201 타이밍 차이로 실패**했다. 해당 소스·테스트·fixture는 이번 정책에서 변경하지 않았다. 독립 실행 25개와 최종 동일 기본 병렬 전체 실행은 통과했다. 이 간헐성은 숨기거나 검증을 완화하지 않았으며 기존 경합의 후속 안정화 항목이다.

User skip은 기존 HTTP+WS 교차 인증 opt-in 1개와 Redis restart opt-in 1개이며 restart는 별도 실행했다. 새 실제 HTTP Gateway rewards 호출은 활성화했다. Gateway skip2는 기존 localhost:6381 location rate-limit opt-in이다. 실제 Kakao 제공자 HTTP는 fixture로 대체했으며 Post/Map/Notification 실제 프로세스 E2E나 운영 Aurora/HA 부하 검증을 완료했다고 주장하지 않는다. 별도 rewards suite 수는 전체 User와 중복이다.

## 8. 운영에서 활성화 가능한 것과 남은 것

**User 코드 준비 완료:** migration 적용 후 세 확정 칭호 자동 평가/지급/회수, 현재/과거 달성·진행 조회, Seed·인증·Swagger·Outbox. 신뢰할 원본 활동 이벤트가 공급되어야 실제 운영 실적이 쌓인다. 실제 배포는 이번에 하지 않았다.

**개발·계약 fixture로 검증:** 천리안 지역별 30일 계산·snapshot·다중 지역 지급/회수, PostRegionResolved 및 선택적 postRegion 수신, 원본 시각/귀속 보충. User는 지역 추정·사용자 지역 설정을 하지 않는다.

**외부 미완료:** Post PR #72 생산자 롤아웃·행정동 이벤트 생산/과거 글 backfill/정정·철회 계약, 실제 Post→User E2E, Notification 소비/FCM, 운영 Redis/Aurora 장애·부하 검증. 크레딧 수치 승인과 동률 초안의 팀 검토도 필요하다.

배포 전 DB backup 및 migration 순서, 옛 credit JSON의 임시 칭호 규칙 제거와 버전 변경, source timestamp/region backfill·완전성 지표, 최종 동률 규칙, 프런트의 User 칭호 단일 기준, Gateway docs artifact 갱신, Notification eventId 중복 제거를 확인해야 한다. 기존 Post의 즉석 등급/지역 랭킹은 이 확정 정책과 다르며 후속 정리가 필요하다.

## 9. 누적 로컬 변경 파일

아래는 이전 로컬 작업을 포함한 현재 작업 트리 전체 목록이다. Gateway의 4개 보상 경로 허용과 관련 테스트는 이전 작업을 보존한 것이며 이번 정책은 신규 경로를 추가하지 않았다.

- `gateways/http-gateway/src/user-auth.ts`
- `gateways/http-gateway/test/openapi.test.ts`
- `gateways/http-gateway/test/user-auth.test.ts`
- `services/user-service/.env.example`
- `services/user-service/README.md`
- `services/user-service/REWARDS_CONTRACT.md`
- `services/user-service/USER_SERVICE_COMPLETION_REPORT.md`
- `services/user-service/WGO_TITLE_POLICY.md`
- `services/user-service/package.json`
- `services/user-service/src/config/configuration.ts`
- `services/user-service/src/database/data-source.ts`
- `services/user-service/src/database/entities/reward.entity.ts`
- `services/user-service/src/database/migrations/1793360000000-CompleteActivityRewards.ts`
- `services/user-service/src/database/migrations/1793400000000-ActivateWgoTitles.ts`
- `services/user-service/src/database/seeds/seed-badges.ts`
- `services/user-service/src/http-auth/gateway-auth.guard.ts`
- `services/user-service/src/rewards/activity.service.ts`
- `services/user-service/src/rewards/badge-catalog.ts`
- `services/user-service/src/rewards/fixtures/development-policy.json`
- `services/user-service/src/rewards/post-event.ts`
- `services/user-service/src/rewards/post-rewards.consumer.ts`
- `services/user-service/src/rewards/reconcile.ts`
- `services/user-service/src/rewards/regional-ranking.worker.ts`
- `services/user-service/src/rewards/reward-engine.ts`
- `services/user-service/src/rewards/reward-events.ts`
- `services/user-service/src/rewards/reward-maintenance.worker.ts`
- `services/user-service/src/rewards/reward-policy.ts`
- `services/user-service/src/rewards/reward-response.dto.ts`
- `services/user-service/src/rewards/rewards.controller.ts`
- `services/user-service/src/rewards/rewards.module.ts`
- `services/user-service/src/rewards/rewards.openapi.ts`
- `services/user-service/src/rewards/title-policy.ts`
- `services/user-service/src/rewards/title.service.ts`
- `services/user-service/test/gateway-auth.test.ts`
- `services/user-service/test/openapi.test.ts`
- `services/user-service/test/reward-policy.test.ts`
- `services/user-service/test/rewards.integration.test.ts`
- `services/user-service/test/title-policy.test.ts`
- `services/user-service/test/wgo-titles.integration.test.ts`

다른 서비스 비즈니스 로직 변경 없음. 사용자 설정 지역 추가 없음. 현재 브랜치에서 로컬 변경으로 유지한다.
