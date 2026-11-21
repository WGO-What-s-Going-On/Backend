# 칭호 v3 계약과 전환

기본 OFF: User `USER_TITLES_V3_ENABLED`, Post `POST_VOTE_SELECTION_EVENTS_ENABLED`,
Frontend `VITE_USER_TITLES_V3`. v3 OFF에서는 기존 v1/v2 정의와 v2 지급을 유지한다.

## 정책과 호환성

기존 code/ID를 재사용한다. 소식통(가입), 리포터(참여 10), 특파원(받은 AGREE 합계 10),
천리안(대표 의견 5 = 50점)을 순차 지급한다. 취소/삭제/숨김으로 현재 조건이 깨지면
현재 소유를 회수하고 기존 획득/회수 이력은 남긴다.

Post `/me/level`과 같이 본인 글, ACTIVE 댓글, 활성 게시물/댓글 반응, 현재 선택된 투표를 센다.
자연 만료와 부모 삭제/숨김 후 남은 자식 댓글/반응/선택은 Post 기준대로 유지한다.
AGREE는 여러 ACTIVE 본인 댓글에서 합산하며 자기 공감도 포함한다. 삭제/숨김 댓글은 제외한다.
승리는 유효한 당선 댓글과 삭제/숨김이 아닌 부모 글 및 수신한 `PostVoteWon` 사실이 모두 필요하다.
v2 validity view와 원장/크레딧/성장 엔진은 변경하지 않는다.
기존 지역 랭킹 점수/스냅샷/API를 유지하고, v3에서는 지역 결과가 공통 천리안 badge를 수정하지 않는다.

## 이벤트

기존 schemaVersion=1 Post envelope에 `PostVoteSelectionChanged`를 추가한다.
payload는 `voteSelection: { postId, userId: number, commentId: string|null, updatedAt: ISO UTC }`,
`activityVersion: positive integer`다. `commentId`는 comment UUID 식별자 또는 null이다.
게시물 `voteRevision`을 버전으로 사용하며 선택/득표와 Outbox를 같은 Mongo 트랜잭션에서 커밋한다.
변경 없는 재요청은 발행하지 않는다. User는 inbox와 사용자별 greater-version upsert로 처리한다.
같은 버전의 다른 선택은 격리한다. Notification/Moderation은 미지원 이벤트를 무시하며 Map은
기존 allowlist 밖의 이벤트를 무시한다. 검색 이벤트 필터도 유지한다.
기존 `PostHidden`/`PostCommentHidden`은 v3 전용 tombstone에 저장해 v2 집계와 크레딧에 영향이 없다.
현재 Post에는 숨김 취소 이벤트가 없다.
`PostCommentUpdated`와 `ContentModerationApplied`는 envelope를 검증한 뒤 ACK한다.
본문 수정과 모더레이션 처리 확인은 활동 유효성/보상 상태를 바꾸지 않는다.
과거 DLQ는 자동으로 삭제하거나 재발행하지 않는다.

기존 `USER_BADGE_GRANTED/REVOKED` 계약에 `policyVersion=wgo-titles-v3`를 사용한다.
명시적 과거 사용자 재평가와 v3 유지보수는 선택 필드 `notificationMode="silent"`를 붙인다.
Notification은 inbox를 커밋하고 알림/푸시/미확인 수는 추가하지 않는다. 가입/일반 활동의 실제 전이는
기존처럼 알림을 발행한다. 소비자 준비 전에 Post의 신규 이벤트 발행을 켜지 않는다.

## API와 화면

`GET /api/v1/users/me/growth`의 `titles`에 v3 활성 시 `ready`와
`stats: {participation, agreeReceived, picks}`(정수 문자열)를 추가한다. 기존 응답 필드를 유지한다.
`currentStage`는 실제 보유 단계 1~4이며 미평가/비활성 사용자는 0이다.
`stages`의 progress/required/remaining도 같은 REPEATABLE READ 스냅샷에서 읽는다.
Frontend 두 화면은 이 응답을 공유한다. v3 설정에서 v2 응답/ready=false는 오류·재시도로 표시한다.
라이브 조회 실패를 목업 활동으로 대체하지 않는다. 기존 진입 재조회와 표시 중 5초 재조회로
비동기 Projection 반영을 확인한다. Post 변경 직후의 즉시 반영은 보장하지 않는다.

## 운영 전환 (운영 변경은 별도 승인 필요)

세 플래그는 독립적이다. Post는 User의 준비 상태를 자동 확인하지 않으므로 아래 2단계를
통과하기 전 생산 플래그를 켜면 안 된다. CD의 서비스 배포 순서만으로 별도 runtime 설정 변경까지
보호되지는 않는다. 이 릴리스는 User/Notification/Post만 선택 배포하고 다른 서비스를 재배포할 필요가 없다.
선택 배포도 현재 운영 이미지 SHA와 후보 SHA의 서비스별 diff를 먼저 검토한다. 후보에 포함된
기존 미배포 수정은 v3 플래그와 관계없이 적용되므로 함께 승인하거나 별도 릴리스로 분리한다.

| 단계 | 실제 작업과 통과 조건 | 실패 시 복구 |
| --- | --- | --- |
| 1. Migration | 세 플래그 OFF. 기존 migration Job으로 `AddTitlePolicyV31795300000000` 적용. migration 이력과 신규 테이블 3개, 앱 DB 역할의 SELECT/INSERT/UPDATE 권한 확인. 기존 원장/이력 before-image 보관. | 트랜잭션 실패 시 중단. 생성된 신규 테이블은 보존하고 구버전 앱 유지. |
| 2. 소비자 준비 | User와 Notification 배포 후 구 Pod가 모두 종료될 때까지 대기. User 배포 이미지에 신규 투표/숨김 파서와 migration이 있어야 하고 Notification은 silent payload를 처리해야 한다. readiness, `post-user-rewards`와 `user-notification` pending=0/lag=0, 신규 DLQ 증가 없음 확인. 기존 group 존재나 readiness만으로 신버전 준비를 판단하지 않는다. | Post 생산 OFF 유지. User/Notification 이전 이미지로 복귀 가능. |
| 3. 생산 활성화 | Post 배포 후 2단계를 다시 확인한 뒤 `POST_VOTE_SELECTION_EVENTS_ENABLED=true`. User v3/Frontend v3는 계속 OFF. 새 QA 투표 선택/취소의 Outbox→User 입력 저장→ACK를 확인한다. | 생산만 OFF. 저장된 입력/Outbox/이력은 지우지 않는다. |
| 4. 과거 입력 보정 | Post 담당자가 snapshot read로 현재 상태와 버전/원본 이벤트 ID를 추출하고 User 담당자가 기존 사실과 대조한다. 소규모 검토된 SQL로 신규 `title_hidden_content`, `title_vote_selections`만 보정한다. 선택은 null 취소 상태도 포함하고 `post.voteRevision`을 사용한다. greater-version upsert, 동일 버전 상충 중단, 전후 이미지 비교, ROLLBACK 미리보기를 먼저 수행한다. | SQL 트랜잭션 rollback. 이미 커밋했다면 v3를 OFF로 유지하고 최신 원본/전후 이미지를 대조해 해당 키만 수정한다. 최신 소비 이벤트를 과거 snapshot으로 덮어쓰지 않는다. |
| 5. dry-run | `pnpm titles:compare --user <id>`를 전체 기존 사용자에게 실행. 이 명령은 `SET TRANSACTION READ ONLY`를 사용한다. 세 통계가 Post 원본과 모두 일치하고 예상 code와 현재 소유 diff가 검토돼야 한다. 원장/성장/기존 이력은 그대로여야 한다. | User/Frontend v3 OFF 유지. 불일치를 보정한 뒤 반복한다. |
| 6. User 활성화 | `USER_TITLES_V3_ENABLED=true`. 유지보수 worker가 무활동 사용자까지 silent 재평가한다. 필요한 경우 `pnpm titles:compare --user <id> --apply --operation-id <stable-id>`로 완료를 확정한다. ready/currentStage/보유 badge가 일치하고 반복 시 이력/이벤트가 늘지 않아야 한다. | Frontend OFF 유지. User v3 OFF 후 기존 worker의 v2 재평가 완료를 확인한다. 이 과정의 v2 회수 알림도 기존 동작임을 고려한다. |
| 7. Frontend 활성화 | 전원 ready와 User/Post 통계 일치를 확인한 뒤 `VITE_USER_TITLES_V3=true`로 빌드/배포. 마이/활동의 칭호·게이지 일치 확인. 기존 OFF 빌드를 롤백 대상으로 보관한다. | 기존 OFF 빌드로 복귀. User 재평가 이력과 입력은 보존한다. |
| 8. 실사용 QA | 승인된 테스트 계정으로 가입/참여 9→10/여러 댓글 AGREE 9→10/취소·재공감/투표 선택·취소·재선택/당선 4→5/삭제·숨김/랭킹 변경을 확인한다. 기존 댓글·투표 알림/지도/검색과 두 Consumer의 pending·DLQ도 확인한다. | Frontend OFF → User OFF 순서로 복구하고 데이터/이력을 보존한다. |

User의 기존 재평가 도구는 칭호 전이/이력/Outbox만 변경하며 RewardEngine을 호출하지 않는다.
범용 backfill 시스템과 서비스 간 직접 DB 접근을 추가하지 않는다. 담당 서비스별 추출/대조와
검토된 소규모 보정으로 충분한지 먼저 확인한다. 과거 보상/알림 재처리를 일으키는 전체 이벤트 재생은 사용하지 않는다.
과거 입력 누락이나 동일 버전 상충이 남아 있으면 v3를 켜지 않는다.

기존 정책/칭호 이력/지역 스냅샷은 삭제하지 않는다. v3의 최고 단계는 v3 기준이며 과거 v1/v2 이력은
기존 badge-history API에서 조회한다. 롤백은 Frontend v3 OFF → User v3 OFF 후 기존 worker의 v2
재평가를 확인한다. 플래그만 내리는 즉시 모든 현재 badge가 복원되는 것은 아니다.
신규 테이블/이력은 보존한다. 크레딧 재산정이 가능한 기존 rewards reconcile은 전환 도구로 쓰지 않는다.

로컬 Post 통합 테스트는 `RUN_TITLE_V3_INTEGRATION=1 pnpm test test/vote-selection.integration.test.ts`로
전용 loopback MongoDB 27027 replica set에서 수행한다. User는 전용 PostgreSQL DB를 생성/삭제한다.
