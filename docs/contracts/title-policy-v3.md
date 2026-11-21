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

## 운영 전환 (이번 작업에서 실행하지 않음)

1. 플래그 OFF로 신규 User migration과 User/Notification 소비자를 먼저 배포한다.
2. Post 배포 후 선택 이벤트만 ON으로 전환한다. v2 지급을 유지한 채 pending/DLQ를 확인한다.
3. `pnpm build` 후 `pnpm titles:compare --user <id>`로 읽기 전용 비교한다.
   이 명령은 `SET TRANSACTION READ ONLY`를 사용하며 정책/원장/소유 상태를 쓰지 않는다.
4. **과거 입력 누락을 해결하기 전 v3를 켜지 않는다.** 이벤트 도입 전 투표 선택과 Stream 보존 기간 밖의
   댓글/공감/당선 사실은 User만으로 복원할 수 없다. Post 담당자가 일관된 현재 상태 스냅샷과 버전을
   추출해 User 사실과 대조해야 한다. 선택에는 게시물 voteRevision이 필요하다.
   누락은 별도 검토된 최소 보정 작업으로 처리한다. 이 변경은 범용 backfill/직접 타 서비스 DB 조회/
   실제 이벤트 재발행을 제공하거나 실행하지 않는다.
5. 비교 승인 후 User v3 ON. 유지보수 worker는 현재 상태만 재평가하고 과거 알림은 억제한다.
   사용자별 명시적 실행은 `pnpm titles:compare --user <id> --apply --operation-id <stable-id>`다.
   RewardEngine을 호출하지 않으며 반복 실행 시 실제 소유 전이가 없으면 이력/이벤트를 추가하지 않는다.
6. ready/currentStage/보유 badge/Post stats 일치를 확인하고 Frontend 플래그를 ON으로 빌드한다.
   가입/9→10/AGREE 취소/투표 재선택/당선 4→5/삭제/숨김/랭킹 변경 E2E를 수행한다.

기존 정책/칭호 이력/지역 스냅샷은 삭제하지 않는다. v3의 최고 단계는 v3 기준이며 과거 v1/v2 이력은
기존 badge-history API에서 조회한다. 롤백은 Frontend v3 OFF → User v3 OFF 후 기존 worker의 v2
재평가를 확인한다. 플래그만 내리는 즉시 모든 현재 badge가 복원되는 것은 아니다.
신규 테이블/이력은 보존한다. 크레딧 재산정이 가능한 기존 rewards reconcile은 전환 도구로 쓰지 않는다.

로컬 Post 통합 테스트는 `RUN_TITLE_V3_INTEGRATION=1 pnpm test test/vote-selection.integration.test.ts`로
전용 loopback MongoDB 27027 replica set에서 수행한다. User는 전용 PostgreSQL DB를 생성/삭제한다.
