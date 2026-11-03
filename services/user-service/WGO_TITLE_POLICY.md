# WGO 칭호 및 행정동 랭킹 정책

기준: 2026-11-03. 최종 확정 정책은 `wgo-titles-v2`다. 기존 `wgo-titles-v1` 정의·랭킹·지급/회수 이력은 보존한다. 크레딧/성장 재화와 지역 점수는 별개다.

## 확정 칭호

| 칭호 / code | 획득 조건 |
| --- | --- |
| 소식통 / NEWS_SOURCE | 유효 활동 10회 |
| 리포터 / REPORTER | 서로 다른 본인 댓글 10개가 각각 다른 사용자 10명 이상의 AGREE를 받음 |
| 특파원 / CORRESPONDENT | 지역 무관 서로 다른 유효 투표 승리 결과 5건 |
| 천리안 / CLAIRVOYANT | 행정동별 최근 30일 양의 유효 점수 실적이 있는 현재 ACTIVE 특파원 중 상위 10% |

첫 세 칭호의 기존 조건을 유지한다. 각 조건은 독립 판정하며 특파원에 리포터 보유를 추가 요구하지 않는다.
게시물/댓글 작성은 고유 활동별, 게시물 공감은 `(postId,actorId)`, 댓글 공감은 `(commentId,actorId)`별로 집계한다. 공감 종류 변경·취소·재공감은 같은 대상의 활동을 부풀리지 않는다. PostParticipantJoined/Left는 입장 상태로 보존하고 소식통에 합산하지 않는다.
리포터는 HELPFUL/DIFFERENT·자기 공감을 제외하며 댓글 생성이 늦으면 수신 후 재평가한다.
특파원은 점수가 아닌 `count(DISTINCT result_id)`로 판정한다. 후보만으로 승리를 만들지 않는다.
명시적 게시물·댓글 삭제는 현재 실적에서 제외하되 자연 만료는 유지한다. 계정 비활성은 지급/경쟁에서 제외하고 maintenance가 회수·복원을 반영한다. 현재 자격 회수 후에도 최초 달성·최고 단계·지급/회수 이력은 보존한다.

## 지역 점수

| 사실 | 점수 | 실제 발생 시각 |
| --- | --- | --- |
| 후보 선정 | 게시물·사용자별 최대 +1 | candidate.selectedAt |
| 선정 후 패배 | 추가 없음 | 별도 패배 이벤트를 가정하지 않음 |
| 최종 승리 | 게시물의 최종 결과 한 건에 +2 | vote.closedAt |
| 실제 후보와 실제 승리 모두 존재 | 총 3 | 각 사실을 독립 계산 |

같은 사용자의 후보 댓글 두 개는 각각 원본으로 저장한다. 점수 projection은 창 안의 유효·지역 확인 후보에서 게시물·사용자별 하나만 선택한다. 선택 순서는 `selectedAt ASC, activity_key ASC`로 결정적이다. 하나가 삭제돼도 다른 유효 후보가 있으면 1점을 유지한다. 원본은 삭제하지 않는다.
`scoreAtSelection`은 당시 HELPFUL+AGREE 공감 수의 감사 값이며 지급 점수로 사용하지 않는다.
승리가 먼저 오면 +2만 인정한다. 가짜 후보를 생성하지 않고, 실제 후보가 늦게 오면 실제 selectedAt/지역으로 +1을 계산한다.

## 실제 Post 계약과 이전 구현의 차이

근거는 현재 체크아웃의 [Post 계약](../post-service/contracts/post-events.md), `post/infrastructure/mongoose-vote.ts`, `post/application/vote.ts`, `post/infrastructure/post-event-envelope.ts`다.

| 이벤트 | 실제 입력 / 업무 키 |
| --- | --- |
| PostVoteCandidateSelected | candidate.{postId,commentId,authorId,scoreAtSelection,selectedAt,regionCode}, activityVersion=1 / candidate:postId:commentId |
| PostVoteWon | 기존 vote 필드 + vote.regionCode, activityVersion=1 / vote:resultId, resultId=postId |

지역은 10자리 숫자 문자열 또는 null이며 과거 Outbox에는 필드가 없을 수 있다. Redis eventId/eventType/data를 검증하며 data는 payload를 최상위로 펼친 Post envelope다. 사용자 ID는 Post safe integer number를 User 문자열로 변환한다.
이전 User의 `PostRegionResolved` / 최상위 `postRegion.{code,name,type,version}` 제안은 실제 Post가 발행하지 않는다. Post 문서 앞부분의 과거 User 후속 작업 설명보다 후보/지역 절과 실제 발행 코드를 기준으로 연결한다.
라이브 기본 계약은 `vote-region-v1`이다. 미구현 PostRegionResolved는 기본 경로에서 UNSUPPORTED_EVENT로 격리한다. 기존 `post-region-v1` 명시 모드의 정정 adapter와 `reward_post_regions`/감사 이력은 이전 도구 호환을 위해 남기지만 실제 생산을 가정하지 않는다. 그 게시물 정정은 v2 점수를 재귀속하지 않는다.

## 사건별 지역 스냅샷

| source_region_state | 의미 | 지역 점수 |
| --- | --- | --- |
| KNOWN | 수신 이벤트의 정상 10자리 코드 | 시각 검증·유효 조건 충족 시 인정 |
| NULL | 명시적 regionCode:null | 제외 |
| MISSING | 과거 wire의 필드 누락 | 제외 |
| LEGACY | 신규 migration 이전 projection만 존재 | 제외, 원본 확인 필요 |

`source_region_event_id`는 근거 이벤트이며 `source_time_verified`는 selectedAt/closedAt 확인 여부다. 지역명·지역 버전은 발행되지 않으므로 생성하지 않고 API regionName은 null이다.
후보와 승리는 같은 게시물이어도 서로 다른 지역 스냅샷을 유지한다. 후보 null/누락 → 게시물 백필 → 승리 정상 코드이면 승리 +2만 그 지역에 귀속한다. 현재 게시물 지역·프로필·GPS로 과거 사실을 옮기지 않는다.
원본 후보 저장과 점수 인정 상태는 user_activities 및 공유 SQL projection으로 분리한다. eventId 중복은 Inbox에서 제거한다. 동일 업무 키의 신원·확정 시각·지역·scoreAtSelection 충돌은 격리한다. 같은 사실의 새 eventId는 추가 지급/revision을 만들지 않는다.
LEGACY 행은 신원이 일치하는 원본 확인 replay로 한 번 보충할 수 있다. 이미 확인된 NULL/MISSING/KNOWN 스냅샷은 새 게시물 지역으로 덮어쓰지 않는다.
미확인 지역·시각은 그 사실만 제외하여 다른 지역을 오염시키거나 전체 지역을 중단하지 않는다. 제외 건수가 있으면 API는 `READY_WITH_EXCLUSIONS`와 누락·미검증 건수를 표시한다. 전역 특파원 실적은 지역 누락과 독립이다.

## 창·경쟁자·동점·복구

한국 시간 자정 T의 `[T-30일,T)`를 유지한다. 시작 포함·종료 제외이며 서버 시간대와 무관하다. 현재 ACTIVE 특파원 중 그 행정동의 창 안에 양의 유효 점수가 있는 사용자만 경쟁자다. N<10이면 0명, N>=10이면 floor(N/10)명이다. 9→0, 10/19→1, 20→2다. 여러 행정동 자격을 동시에 보유할 수 있다.
동점은 `score DESC, last_selected_at ASC, user_id ASC`다. 기존 DB 이름 last_selected_at은 이제 **실제 점수에 포함된 후보/승리 사실 중 가장 늦은 발생 시각**이다. 중복 제거된 후보는 마지막 시각에 영향을 주지 않는다. 같은 점수에 먼저 도달한 사용자가 우선하고 시각도 같으면 작은 숫자 ID가 우선한다.
기존 정책 advisory lock·지역 job lock·정렬된 사용자 row lock·transaction을 유지한다. 1초마다 최대20개 지역을 오래된 head부터 처리한다. 후보/승리/삭제/계정 상태 변경은 durable input_revision으로 재계산된다. 점수가 사라져도 기존 head/보유 지역을 처리해 회수를 놓치지 않는다.
재시작 시 현재 KST 창으로 따라잡고 같은 날짜/입력/정책의 실행은 run을 재사용한다. 놓친 날짜마다 가짜 지급을 만들지 않으며 과거 창으로 최신 head를 덮어쓰지 못한다. snapshot에 policy/window/revision/경쟁·선정 인원 및 기여별 activityKey/kind/points/postId/commentId/resultId/시각/regionCode를 저장한다.

## 마이그레이션과 호환성

| 신규 migration | 변경 |
| --- | --- |
| 1793650000000-StoreVoteActivitySnapshots | 후보 종류·사건별 지역/출처/감사 값·후보 유니크/지역 창 인덱스·유효 활동 view 확장 |
| 1793651000000-ApplyRegionalTitlePolicyV2 | 랭킹 고유 키에 policy_version 추가·입력 revision 증가 |

기존 적용 migration은 수정하지 않는다. 기존 게시물 지역을 사건 지역으로 복사하지 않는다. 사용자·정책·원장·지급·Outbox·랭킹 이력을 삭제하지 않는다. v2 첫 평가에서 별도 정책을 insert/check한다. 신규 두 migration의 down은 이력 삭제를 막기 위해 명시적으로 거부한다. rollback은 forward migration 또는 검토된 백업 복구로 준비한다.

## API와 Notification 인계

기존 growth/credits/badges/history 및 Gateway 인증을 유지한다. 새 공개 경로나 위치 입력은 없다. `additionalPointsForGuaranteedEntry`는 다른 결과가 고정됐을 때 저장된 컷을 넘는 점수 차다. 기존 additionalSelectionsForGuaranteedEntry는 호환 alias이며 후보 이벤트 개수 보장이 아님을 Swagger에 명시한다. upToDate는 날짜·입력 revision·정책까지 검사한다.
`user:events`의 USER_BADGE_GRANTED/REVOKED, USER_LEVEL_CHANGED, USER_CREDIT_CHANGED를 유지한다. 실제 자격 전환에서만 append-only history와 Outbox를 한 번 만든다. 천리안에는 regionCode/rank/score/rankingRunId/window/경쟁 인원 등 기존 메타데이터를 유지한다. 같은 상태 재계산은 획득 알림을 반복하지 않는다.
물리 전달은 at-least-once이므로 Notification은 독립 group/Inbox에서 eventId 중복 제거 후 DB commit 뒤 XACK해야 한다. Notification 코드는 이번에 변경하지 않는다. 상세 envelope는 [REWARDS_CONTRACT.md](REWARDS_CONTRACT.md)를 따른다.

## 배포 전 확인

1. DB 백업 후 두 신규 migration을 순서대로 적용하고 권한·잠금 시간·운영 데이터 규모를 검토한다. synchronize=false를 유지한다.
2. `USER_TITLES_ENABLED=true`, `USER_REGIONAL_RANKING_ENABLED=true`, `USER_TITLE_REGION_CONTRACT=vote-region-v1`을 확인한다. none은 랭킹 중단 옵션이다. 크레딧 정책은 별도 승인 설정이다.
3. 기존 Cloud SQL Proxy/Workload Identity·Redis ACL·JWT/Gateway/GCS 설정을 유지한다. 실제 .env·운영 DB는 이번에 수정하지 않는다.
4. LEGACY/MISSING/NULL·미검증 시각·DLQ/Pending을 점검한다. Post 게시물 백필은 과거 Outbox를 고치거나 후보를 소급 발행하지 않는다.
5. 원본 없는 과거 후보를 생성하지 않는다. LEGACY 보충은 승인된 원본 확인 replay만 사용하고 기존 receipt를 삭제하지 않는다. 이미 처리된 eventId의 재전달만으로는 보충되지 않으므로 승인된 새 eventId와 근거를 사용한다.
6. User 스키마/소비자 준비 후 새 Post 생산자를 연결하고 실제 환경에서 Swagger 수집·지연·이벤트를 확인한다.
7. GCP 배포, 운영 백필, 실제 MongoDB 생산자부터의 운영 E2E, HA·부하·Cloud SQL 장애 검증은 별도 수행한다.
