# WGO 확정 칭호 정책 및 지역 연동 계약

기준: 2026-10-31, 사용자 첨부 최종 정책 및 추가 답변. 정책 버전 `wgo-titles-v1`.
User의 성장 재화와 칭호를 분리한다. 이번 변경은 로컬 구현이며 실제 배포·Post/Map/Notification 변경은 수행하지 않았다.

## 1. 자동 지급과 기능별 스위치

| 기능 | 기본값 | 실제 준비 상태 |
| --- | --- | --- |
| 확정 칭호 평가 | `USER_TITLES_ENABLED=true` | 소식통·리포터·특파원 평가/지급/회수 ON |
| 크레딧·성장 점수 지급 | `USER_REWARD_POLICY_JSON` 미설정 시 OFF | 승인된 수치 JSON을 명시할 때만 별도 활성화 |
| 행정동 랭킹 작업 | `USER_REGIONAL_RANKING_ENABLED=true` | 계산 구현 ON, 외부 지역 계약 준비 여부로 실제 작업 실행 결정 |
| 지역 정보 계약 | `USER_TITLE_REGION_CONTRACT=none` | **현재 실제 지역 수신 불가**, 천리안 신규 지급 불가 |

`post-region-v1`은 아래 **제안 계약이 Post에서 실제 구현·검증된 후**에만 선택한다. 플래그를 바꾸는 것만으로 외부 생산자가 생기지 않는다. 지역 계약 미비는 다른 세 칭호를 끄지 않는다. 칭호 평가 OFF는 관리자가 명시할 수 있으나 기본값이 아니다.

크레딧 종류별 금액·일일 한도·재지급 제한·레벨 임계값은 승인 근거가 새로 생기지 않았으므로 기존 versioned 설정을 보존했다. 기존 개발 JSON은 credit/growth 재현 fixture이며 공식 칭호 조건을 담지 않는다. `NEWS_SOURCE/REPORTER/CORRESPONDENT/CLAIRVOYANT`는 크레딧 정책의 점수 기반 badges 규칙으로 설정할 수 없다. 기존 DB의 옛 정책 JSON·원장은 보존하며, 크레딧을 활성화할 새 설정에서 과거 임시 칭호 규칙을 제거하고 새 버전을 사용한다.

## 2. 확정 조건과 유효 활동

| 단계 / code | 획득 조건 | 현재 자격 회수 |
| --- | --- | --- |
| 1 소식통 / NEWS_SOURCE | 유효 참여 10회 | 현재 유효 활동이 10회 미만 또는 계정 비활성 |
| 2 리포터 / REPORTER | 서로 다른 본인 댓글 10개가 각각 다른 사용자 AGREE 공감 10개 이상 | 조건을 만족하는 댓글이 10개 미만 또는 계정 비활성 |
| 3 특파원 / CORRESPONDENT | 서로 다른 resultId의 유효 대표 의견 선정 5건 | 댓글/게시물 삭제로 5건 미만 또는 계정 비활성 |
| 4 천리안 / CLAIRVOYANT | 행정동별 최근 30일 실적이 있는 특파원 N>=10 중 상위 floor(N/10) | 순위 이탈, 특파원 자격 상실, 계정 비활성, 지역 기여 철회·검증 데이터 미비 |

단계는 위 조건을 각각 판정한다. 특파원 자격에 리포터 획득을 추가로 요구하지 않는다. 상위 단계 획득을 위해 프롬프트에 없는 조건을 만들지 않았다. 칭호는 누적 보유할 수 있고, API는 현재 최고 단계와 과거 최고 달성 단계를 별도로 제공한다. 대표 칭호를 사용자가 선택하는 신규 기능은 추가하지 않았다.

참여 집계:

- 게시물 작성 1건, 댓글 작성 1건을 각각 센다.
- 게시물 공감은 `(postId,actorId)`당 현재 유효 공감이 하나라도 있으면 1건. 종류를 여러 개 누르거나 취소·재공감을 반복해도 부풀지 않는다.
- 댓글 공감은 `(commentId,actorId)`당 같은 방식으로 1건.
- `PostParticipantJoined/Left`는 입장/참여 상태 projection으로 계속 보존하지만 칭호 참여 횟수에는 더하지 않는다. 댓글과 동시에 자동 발행되는 중계 이벤트의 이중 계산을 막는다.
- 순수 투표 참여 이벤트는 현재 전달 계약이 없어 임의로 추정·집계하지 않는다. 투표 승리는 특파원 실적으로 별도 집계한다.
- 삭제된 게시물/댓글과 취소된 관계는 현재 유효 활동에서 제외한다. **자연 만료는 사용자 추가 확정에 따라 실적을 유지**한다. PostExpired가 게시물 활동 active=false를 기록해도 만료 상태를 구분해 작성 실적을 보존한다.

리포터는 AGREE만 센다. Post `README.md`, `POST_SERVICE_STATUS.md`의 표시명이 `AGREE=맞아요`임을 확인했고 enum·이벤트 계약도 대조했다. HELPFUL/DIFFERENT·자기 공감은 제외한다. 댓글 작성 projection이 없으면 작성자 문맥을 추정하지 않고 기다린다. 늦은 댓글 생성이 도착하면 재평가한다. 취소 후 재공감은 최신 관계 버전만 유효하며, 같은 댓글·사용자의 AGREE를 중복 세지 않는다.

대표 의견은 `resultId=postId`, `vote:resultId` 고유 키를 유지한다. 득표수는 실적 가중치가 아니다. 서로 다른 5개 게시물에서의 대표 의견 선정을 센다. 삭제 선도착, eventId 재전달, 상충한 승리자 격리는 기존 방어를 유지한다.

현재 자격이 사라지면 `UserBadge`를 회수 상태로 전환한다. 과거 `UserBadgeHistory`는 지우지 않고 `user_title_progress.achieved_stages/highest_stage`도 보존한다. 재충족 시 새 지급 전환 한 번만 기록한다. 계정 정지/탈퇴 대기/탈퇴는 신규 지급·지역 경쟁에서 제외하며, 계정 상태 변화는 기존 maintenance 스캔에서 반영한다. 복구 시 유효 실적에 따라 재평가한다.

## 3. 행정동별 천리안 계산

- 지역은 **선정 게시물의 행정동 H 코드**다. User 테이블에 거주지·선호 지역·소속 지역을 추가하지 않았다. 사용자에게 지역 설정을 요구하지 않는다.
- 원본 행정동을 Post의 위치 snapshot과 연결한다. 현재 사용자 GPS·프로필 변경으로 과거 실적을 옮기지 않는다.
- 현재 특파원 자격(유효 선정 5회)과 ACTIVE 계정인 사용자 중, 해당 지역에 최근 30일 유효 선정이 최소 1건 있는 사람만 경쟁 인원이다.
- 실적 1건=1점. votes나 credit/growth 가중치를 넣지 않는다.
- 한국 시간 자정 `T`마다 `[T-30일,T)`의 `vote.closedAt`을 사용한다. 시작 시각은 포함하고 자정 T는 다음 계산부터 포함한다. 서버의 로컬 시간대에 의존하지 않는다.
- N<10이면 0명. N>=10이면 정수 나눗셈 `N/10`의 몫을 선정한다. 5→0, 9→0, 10→1, 19→1, 20→2, 50→5, 100→10.
- 동률 초안: **점수 DESC → 창 안 마지막 선정 시각 ASC → userId ASC**. 같은 점수라면 그 점수에 먼저 도달한 사람을 우선한다. 마지막 시각도 같으면 작은 ID를 우선하므로 신규 계정에 불리할 수 있다. 팀의 기존 동률 합의는 발견하지 못했으며 이 초안을 명시적으로 적용했다.
- 여러 지역 자격을 동시에 보유한다. 한 지역 상실이 다른 지역의 점수·보유 상태를 바꾸지 않는다. 기존 전역 UserBadge의 천리안은 지역 자격이 하나 이상 있는지의 요약이다.
- 각 지역 전환은 별도 이력/이벤트로 남긴다. 다른 지역을 계속 보유해도 이탈 지역의 REVOKED는 발행되며 payload.regionCode로 구분한다.

DB 트랜잭션, 정책 advisory lock, 지역 job lock, 정렬된 사용자 row lock을 사용한다. 스케줄러가 여러 개여도 같은 지역·날짜·입력 revision은 한 번 저장한다. 입력 변화가 있으면 같은 날짜 새 revision snapshot을 만들 수 있으나 현재 지급 상태가 같으면 새 지급/회수 이벤트를 만들지 않는다.

워커는 1초 주기로 날짜·입력 revision을 확인하고 최대 20개 지역씩 처리한다. 오래된 snapshot부터 처리해 계속 입력이 들어와도 뒤 지역이 굶지 않도록 한다. 자정 작업을 놓친 후 재시작하면 DB head를 기준으로 **현재 최신 한국 자정 창으로 따라잡는다**. 놓친 과거 날짜마다 허위 지급 이벤트를 만들어내지는 않는다. 지연 이벤트/삭제/지역 정정은 revision을 올려 재계산한다. 과거 날짜 재실행이 더 최신 지급 상태를 덮어쓰는 것은 거부한다.

snapshot에는 정책 버전·창·경쟁 인원·선정 인원·순위·점수와 각 resultId/postId/commentId/closedAt/regionVersion 근거를 저장한다. 과거 snapshot은 수정하지 않는다. 이는 **실제로 계산한 결과**의 재현 근거이며, User가 원본 전체 과거 변경 이력을 가지고 있다고 주장하지 않는다.

## 4. 실제 Post·Map 조사 결과와 미완성 계약

| 조사 대상 | 실제 존재하는 것 | 바로 재사용할 수 없는 이유 |
| --- | --- | --- |
| Post PostRecord/PostSchema | 선택적 region `{code,name}`와 위치 snapshot | 투표 이벤트에 region을 보내지 않음. 과거 글은 미기록 가능 |
| Post 생성 | POST_REGION_ENABLED=true이면 Map ResolveRegion 후 저장 | 조건부 기능이며 현재 User가 이 저장소를 직접 읽으면 안 됨 |
| Map MapAuthorization.ResolveRegion | 좌표→행정동 H code/name, Kakao Local 기반 | Post ES256 호출자만 허용. User에 게시물 ID→행정동 조회를 제공하지 않음 |
| Post `/posts/me/region` | 사용자 좌표의 지역 조회 | 특정 선정 게시물의 보존 snapshot 조회가 아님 |
| Post `/posts/me/ranking` | 기존 전역 등급 기반의 지역 집계 | 확정 30일/특파원/상위10% 규칙과 다름. 원본 실적·snapshot 전송 계약도 아님 |
| Post PR #72 | 댓글 공감 2종 + PostVoteWon | 확인 SHA에 행정동 정보 없음, PR은 조사 시 open/unmerged |

근거: `services/post-service/src/post/domain/post.ts`, `infrastructure/post.schemas.ts`, `application/commands.ts`, `infrastructure/grpc-location.authorization.ts`, `activity.controller.ts`; `services/map-service/contracts/map-authorization.proto`, `src/server.ts`, `src/region.ts`; `docs/contracts/service-authentication.md`.

[PR #72](https://github.com/WGO-What-s-Going-On/Backend/pull/72)의 확인 SHA는 `70f35ac2142da954a07417a4355d2a2106880200`이다. 기존 세 신규 이벤트의 정상 생산도 실제 운영에는 이 Post 생산자 배포가 필요하다. User 테스트의 wire fixture 통과를 Post 운영 E2E라고 보고하지 않는다.

### 최소 추가 계약 제안 — User 수신부만 구현, 실제 생산자 없음

가장 작은 신뢰 가능한 연동은 **Post가 PostRegionResolved 이벤트를 발행**하는 것이다. 이 한 종류로 신규 글의 지역 통보, 과거 글 backfill, 정정/철회를 전달할 수 있다. User가 Map 권한을 우회하거나 좌표로 지역을 추측할 필요가 없다. PostVoteWon에 지역을 넣는 것은 선택적인 지연 감소 확장이다.

공통 Stream/인증 경계는 기존 `post:events`와 Redis ACL, `producer:post-service`, 기존 envelope `schemaVersion:1`이다. HTTP 외부 사용자가 호출하는 지역 수정 API를 만들지 않았다.

```json
{
  "eventId":"evt_00000000-0000-4000-8000-000000000001",
  "eventType":"PostRegionResolved",
  "schemaVersion":1,
  "producer":"post-service",
  "aggregateId":"post_00000000-0000-4000-8000-000000000002",
  "correlationId":"source-request-or-backfill-operation",
  "occurredAt":"2026-10-30T15:00:00.000Z",
  "postAuthorId":123,
  "regionVersion":1,
  "postRegion":{"code":"1159063000","name":"테스트 행정동 A","type":"H","version":1}
}
```

- 위 코드/명칭은 계약 설명용 fixture이며 실제 코드·명칭 대응을 검증한 예시가 아니다. 운영은 Post→Map 원본을 그대로 사용한다.
- Redis fields eventId/eventType/data는 이 envelope와 일치해야 한다.
- postRegion.code는 10자리 행정동 H, name은 비어 있지 않은 최대200자, version은 양의 safe integer다. 외부 B 법정동을 대신 쓰지 않는다.
- regionVersion과 postRegion.version은 같아야 하며, postId별 단조 증가한다. 같은 버전의 다른 지역은 ACTIVITY_CONFLICT, 낮은 버전은 상태를 되돌리지 못한다.
- 명시적 잘못된 귀속 철회는 더 높은 regionVersion의 `postRegion:null`. 이는 timeout/지역 조회 실패를 뜻하지 않는다. 철회는 원래 지역 실적에서 제외하고 원본·정정 이력은 보존한다.
- 선정 이벤트보다 지역 이벤트가 먼저/나중 도착해도 postId로 연결한다. 삭제/만료 뒤에도 지역 snapshot과 version을 보존·재전송할 수 있어야 한다.
- 선택적으로 PostVoteWon envelope 최상위에 같은 postRegion을 넣을 수 있다. vote 필드, 결과/승자/eventId/발행 조건은 바꾸지 않는다. PostRegionResolved는 과거 글·정정에 여전히 필요하다.
- Post의 현재 region snapshot에서 행정동을 가져오고, 필요한 경우 기존 Post→Map ResolveRegion 인증 계약을 재사용한다. 이번 작업에서 Post/Map 코드는 바꾸지 않았다.

이 수신부는 `USER_TITLE_REGION_CONTRACT=post-region-v1`을 명시할 때만 사용한다. none에서 미지원 PostRegionResolved는 UNSUPPORTED_EVENT로 격리한다. 미설정 상태의 선택적 PostVoteWon.postRegion은 권위 있는 지역으로 채택하지 않으며, 기존 투표 실적 소비는 계속한다. 계약 활성 후에는 새 eventId의 지역 이벤트로 backfill할 수 있다.

현재 구현이 지역/기간을 모르는 실적을 임의로 분배하지 않는다. 최근 창의 유효 특파원 실적에서 지역 누락이 있거나, 과거 migration의 선정 시각 신뢰도를 확인할 수 없으면 INCOMPLETE_SOURCE_DATA로 표시하고 새 천리안 선정을 억제한다. 미귀속 활동은 어느 지역에도 속할 수 있으므로 완전성 문제는 보수적으로 전체 지역 계산의 준비 상태에 영향을 준다. 이미 명시적으로 철회된 귀속은 누락과 구분하여 제외한다.

## 5. DB와 마이그레이션

기존 migration은 유지하고 `1793400000000-ActivateWgoTitles`를 추가했다. 기존 사용자·원장·보상/칭호 이력을 삭제하지 않는다.

| 저장소 | 용도 |
| --- | --- |
| user_activities.source_time_verified | 신뢰 가능한 vote.closedAt 확인 여부. 과거 updated_at을 선정 시각으로 위장하지 않음 |
| reward_title_valid_activities view | 삭제·취소 제외, 자연 만료 유지의 공통 유효 활동 정의 |
| user_title_progress | 현재 3개 지표, 최초 달성 시각 집합, 최고 과거 단계, 계정 상태 |
| reward_post_regions / reward_post_region_history | 게시물별 현재 행정동 revision / 정정·철회 감사 이력 |
| regional_ranking_state | 입력 변경 revision의 영속 checkpoint |
| regional_ranking_runs / entries / heads | 불변 계산 snapshot·실적 근거·지역별 최신 head |
| user_regional_badges | 기존 UserBadge의 지역별 상세 보유·회수 상태, 한 사용자 여러 지역 허용 |
| 기존 user_badge_history 추가 컬럼 | region_code/ranking_run_id/reason, 기존 칭호 이력 재사용 |

참여/댓글 AGREE/지역·투표 창/user·run 조회에 인덱스를 추가했다. 랭킹 점수·순위는 SQL에서 집계하며, 지역 배치를 제한했다. 정책 잠금은 정확성 확보를 위해 쓰는 직렬화 비용이 있으므로 대규모 운영 부하 테스트까지 마쳤다고 주장하지 않는다.

기존 배지 카탈로그는 migration에서 insert-if-absent로 보장한다. 별도 seed를 잊어도 첫 세 칭호가 누락되지 않는다. 수동 관리 이름/설명/이미지/active와 기존 지급 데이터는 덮어쓰지 않는다. 과거 임시 점수 정책으로 얻은 공식 칭호는 새 확정 조건에 따라 재평가하되 원래 이력은 남긴다. 근거 없는 전역 천리안은 검증된 지역 자격이 없으면 회수한다.

기존 투표의 source_time_verified는 기본 false다. 원본 closedAt과 commentId가 확인되는 기존 PostVoteWon을 **새 eventId**로 replay하면 같은 resultId/버전에서 문맥과 시각을 보충하며 중복 지급하지 않는다. 이미 성공한 eventId는 Inbox에서 걸러지므로 새 ID가 필요하다. region도 위 이벤트로 backfill해야 한다.

```sh
pnpm migration:show
pnpm migration:run
pnpm seed:badges
pnpm rewards:reconcile --user 123
pnpm rewards:reconcile --user 123 --apply --operation-id approved-title-replay-001
```

조회 CLI는 read-only이며 제목 진행·준비 상태도 출력한다. apply만 상태를 변경한다. 기존 maintenance가 활동·지급 이력이 있는 사용자만 20명씩 스캔하여 확정 조건을 점진 보정한다. 정책 OFF 기간의 크레딧 소급 지급은 별도 승인 범위를 따라야 한다. title migration down은 새 projection/snapshot을 제거하지만 원래 사용자/원장/UserBadge는 유지하므로 운영에서는 backup·코드 rollback 계획을 먼저 세운다.

## 6. API, 인증, Notification

새 public endpoint를 만들지 않았다. 기존 `GET /api/v1/users/me/growth`와 `/credits` 응답에 `titles`를 추가했다. `/badges` 현재 보유 목록, `/badges/history` 획득·회수 이력을 유지한다.

- enabled/policyVersion/currentStage/highestAchievedStage
- stages: 각 단계의 조건·현재 수치·필요 수치·남은 수치·현재 충족·과거 달성 시각
- nextTitle: 다음 단계와 남은 실적. 천리안은 상대평가이므로 고정 수치 remaining=null
- regionalRanking: enabled/ready/status, 누락 지역·신뢰 미확인 시각 건수, KST 다음 갱신 시각, 지역별 score/rank/경쟁 인원/선정 인원/선정 여부/자격/진입 가능한 경합 준비 상태
- 지역별 cutoffScore와 additionalSelectionsForGuaranteedEntry는 **다른 실적이 snapshot 그대로일 때** 현재 컷을 확실히 넘는 추가 실적을 뜻한다. 미래 순위 예측이나 확정 보상량이 아니다.
- upToDate=false이면 최신 날짜/입력 revision의 계산이 대기 중이다. rank/score는 저장 snapshot 기준이다.
- 이력에 nullable regionCode/rankingRunId/reason을 추가했다. 기존 필드·커서 규칙은 유지한다.

최신 Gateway ES256 서비스 JWT 경계와 외부 신원 헤더 제거를 유지했다. 추가 route가 없으므로 Gateway 라우팅·허용 목록을 확대할 필요가 없다. User Swagger와 실제 Gateway merger에서 중첩 칭호/지역 schema를 검증한다. 현재 사용자 GPS를 전달하거나 지역을 설정하는 신규 입력은 없다.

기존 `user:events` envelope 및 Outbox를 유지한다. USER_CREDIT_CHANGED/USER_LEVEL_CHANGED는 기존 금전·성장 전환, USER_BADGE_GRANTED/REVOKED는 칭호/지역별 상태 전환에 사용한다. badgeId/policyVersion/userId/sourceEventId를 보존하고 공식 칭호는 badgeCode/badgeName/stage를 추가한다. 지역 칭호에는 regionCode/regionName/rankingDate/windowStart/windowEnd/rank/score/competitors/slots/rankingRunId/reason을 추가한다.

현재 User 내부 gRPC에 일반 GetBadge RPC는 존재하지 않는다. 기존 본인 `/badges` 조회와 badgeId를 유지하면서 출력 payload에 표시 메타데이터를 넣었으므로 Notification이 없는 조회 API를 가정할 필요가 없다. 알림 이동 경로는 badgeCode/stage/regionCode에 따라 결정할 수 있다. Notification 코드는 변경하지 않았다.

한 상태 전환당 한 Outbox row이며 동일 평가·scheduler 재실행으로 추가 row를 만들지 않는다. 물리적 전송은 기존 at-least-once다. XADD 성공 뒤 DB commit 실패 등에는 같은 eventId가 재발행될 수 있으므로 Notification은 별도 group/Inbox에서 eventId로 중복 제거하고 알림 DB commit 뒤 XACK해야 한다. 최초 레벨 생성/상승/하락 구분(changeType)도 유지한다.

## 7. 운영 인계

1. 기존 데이터 backup·migration 순서·기존 임시 칭호 설정을 확인하고 User migration을 먼저 적용한다.
2. 세 칭호 평가 기본 ON, credit 지급 기본 OFF를 확인한다. 실제 댓글 AGREE·대표 의견 실적에는 Post PR #72 생산자 배포가 필요하다.
3. 기존 Post 지역 snapshot 누락을 조사하고 PostRegionResolved 생산·backfill·철회 계약을 합의·구현한다. 그 전에는 지역 계약 none을 유지한다.
4. 원본 closedAt·commentId·행정동을 backfill하고 완전성 지표를 0으로 만든 뒤 지역 수신/랭킹을 실제 Post→User로 검증한다.
5. Gateway docs artifact 갱신과 프런트 표시의 User 단일 기준 전환을 확인한다. Post 기존 즉석 등급/랭킹은 이 확정 정책과 다르며 이번에 바꾸지 않았다.
6. Notification 소비/FCM E2E와 운영 Redis·Aurora 장애/부하 검증은 별도다. 로컬 테스트 완료를 운영 연동 완료로 보고하지 않는다.
