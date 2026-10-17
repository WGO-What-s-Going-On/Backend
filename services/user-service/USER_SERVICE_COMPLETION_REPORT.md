# User Service 완성도 및 잔여 작업 보고서

기준일: 2026-10-17 (Asia/Seoul). 기준 dev: `6aed180e4026828bc78ed1498927d8af7c740a4c`.
작업 브랜치: `feat/user-activity-rewards`. Issue #35는 open 상태를 유지한다. PR은 생성하지 않는다.

판정 기준: ① 완료 및 검증, ② 구현됨/추가 검증 필요, ③ User 독립 구현 가능,
④ 외부 계약 필요, ⑤ 제품·운영 정책 결정 필요. 여러 의존성이 있으면 함께 표시한다.
단위·DB/Redis 통합 테스트가 통과해도 실제 Kakao·Gateway·타 서비스 E2E 완료를 의미하지 않는다.

## A. 현재 구현 완료 항목

| 기능                           | 주요 구현 파일(src 기준)                                       | 검증                                             | 사용 가능 범위 / 분류                                                                                   |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Kakao 신규/기존 로그인         | auth/auth.service.ts, kakao-oauth.client.ts                    | auth.integration, kakao-oauth.client             | Kakao HTTP mock + 실제 DB/Redis 검증. 실제 provider 설정/리다이렉트 E2E 필요 ②                          |
| Access JWT 발급                | auth/access-token.service.ts                                   | auth.integration                                 | 서명·claim·TTL 검증. Gateway 검증은 별도 ①/④                                                            |
| Refresh rotation               | auth/refresh-token.ts, redis-session.store.ts                  | refresh-token, auth.integration                  | hash 저장·원자 교체·동시 재사용 거부·장애 503 ①                                                         |
| 로그아웃                       | auth/auth.controller.ts, auth.service.ts                       | auth.integration                                 | 본인 세션 삭제/반복 204. 기존 access JWT는 만료까지 유효 ①/⑤                                            |
| 프로필 조회·수정/온보딩        | users/users.controller.ts, users.service.ts                    | users.integration                                | PATCH validation, 최초 USER_CREATED, atomic outbox ①                                                    |
| 닉네임 중복 검사               | users/nickname.ts, users.service.ts                            | users.integration                                | 대소문자 무시 DB unique, 입력 검증 ①                                                                    |
| 현재 약관/동의                 | terms/\*, users/users.service.ts                               | terms.integration, users.integration             | 현재 필수 약관·동의 멱등성·동시성 ①                                                                     |
| 기존 칭호 목록                 | users/users.service.ts                                         | users.integration, rewards.integration           | 활성·미회수 목록 및 자동 지급 연동 ①                                                                    |
| 계정 상태 조회/로그인 제한     | database/entities/user.entity.ts, grpc/user-queries.service.ts | auth, finalization-grpc                          | ACTIVE/SUSPENDED/WITHDRAWAL_PENDING/WITHDRAWN. 제재 명령은 없음 ①/④/⑤                                   |
| 탈퇴 요청·30일 복구            | users/users.service.ts, auth/auth.service.ts                   | auth.integration                                 | 세션 폐기·마감 경합·rollback 검증 ①                                                                     |
| 최종 탈퇴 scheduler            | withdrawal/withdrawal.scheduler.ts                             | finalization-grpc.integration                    | tombstone·OAuth/관계 정리·skip locked·중복 방지 ①                                                       |
| User gRPC 3개 RPC              | grpc/\*, contracts/user.proto                                  | service-auth, finalization-grpc                  | ES256 신뢰 키/호출자·RPC 권한, legacy HS256 분기 ①; 실제 호출 서비스 E2E ④                              |
| Transactional Outbox           | outbox/\*                                                      | outbox.integration, rewards.integration          | 실제 Redis 발행, DB rollback/중복 발행/복구 ①                                                           |
| Post 9종 Consumer              | rewards/post-event.ts, post-rewards.consumer.ts                | reward-policy, rewards.integration               | 실제 Stream, XREADGROUP/XACK/XAUTOCLAIM, pending, DLQ, 다중 소비 ①                                      |
| 활동 projection·집계           | rewards/activity.service.ts                                    | rewards.integration                              | eventId 멱등·버전·terminal fence·actor별 집계 ①                                                         |
| 원장/크레딧·성장 점수          | rewards/reward-engine.ts                                       | rewards.integration                              | grant/revoke·동시성·일관성 점검 ①. 운영 기본 OFF ⑤                                                      |
| 레벨·칭호 자동 판정            | rewards/reward-policy.ts, reward-engine.ts                     | reward-policy, rewards.integration               | fixture 경계·획득 중복·회수·역순 검증 ①. 실제 기준·seed 없음 ⑤                                          |
| 성장 REST 3개 route            | rewards/rewards.controller.ts                                  | rewards.integration                              | credits/growth/history, 400/401/404, keyset ①. trusted Gateway 필요 ④                                   |
| 성장 이벤트 4종                | rewards/reward-engine.ts                                       | rewards.integration                              | 기존 envelope의 원자 생성·실제 Outbox 발행 ①. Notification 소비 없음 ④                                  |
| 댓글 공감·투표 보상 인터페이스 | rewards/post-event.ts parseFutureRewardInput                   | reward-policy, rewards.integration               | fixture 검증·원장 멱등 처리만 구현. live consumer 미연결 ④                                              |
| Migration 및 seed              | database/migrations/\*, database/seeds/seed-terms.ts           | 기존+신규 DB integration, 신규 migration up/down | 신규 빈 DB 및 migration rollback 검증 ①. seed 스크립트 실행·기존 운영 데이터 upgrade 검증은 추가 필요 ② |
| 환경/Docker                    | .env.example, compose.yaml, Dockerfile                         | DB/Redis Docker, typecheck/build                 | 실제 이미지·운영 비밀·배포 rehearsal은 검증 결과 절 참조 ②                                              |
| 사용자 차단                    | database/entities/user-block.entity.ts                         | 기존 schema 및 탈퇴 정리 회귀만                  | **Entity만 존재. 차단/해제/목록 API·도메인 실행 경로 없음** ④/⑤                                         |

### 검증 결과 기록

기존 201개 회귀 테스트는 실제 PostgreSQL/Redis를 실행한 상태에서 전부 통과했다.
신규 검증은 `test/reward-policy.test.ts`(순수 함수)와
`test/rewards.integration.test.ts`(실제 PostgreSQL, Redis, Nest HTTP, Outbox)를 구분한다.
최종 검증: **11개 파일, 272개 테스트 전부 통과**(기존 201개 + 신규 71개).
신규 71개는 정책·입력 단위 35개와 실제 PostgreSQL/Redis 통합 36개다.
DB commit 실패 후 미ACK/재처리, ACK 실패 후 중복 방지, DLQ 쓰기 실패,
여러 worker, 역순 회수/유지, bigint 안전 정수 초과, 원장 불일치 탐지도 포함한다.

- Windows Node 22.17.0: `typecheck`, 전체 `test`, `build` 통과. 현재 GitHub test workflow도 Node 22를 사용한다.
- Node 24.22.0 Docker: 기존 Dockerfile의 `pnpm install --frozen-lockfile`, production build 통과.
  완성된 이미지에서 임시 PostgreSQL DB의 전체 migration과 **AppModule 실제 부팅**,
  정책 미설정의 0 credits/null level 응답을 확인했다. fixture 비밀만 사용했으며 임시 DB/key를 정리했다.
- 루트 `npm run format` 실행 완료. 타 서비스에 생긴 format diff는 복원했다.
  신규 문서도 Prettier로 정리했다. dependency/lockfile 변경은 없다.
- Linux Node 24 컨테이너에서 실제 `scripts/ci.mjs detect|format`을 기준 dev SHA에 대해 실행했다.
  PR 전체 diff 포맷 통과, matrix는 `services/user-service` 한 개뿐이다. `git diff --check`도 통과했다.
  GitHub 원격 CI 실행과 전체 서비스 E2E는 이번 로컬 검증에 포함하지 않는다.

## B. User 자체 잔여 작업

| 작업/미구현 이유                                                       | 구현 대상 / DB·API 변경                                                                  | 난이도·우선순위              | 테스트 완료 조건                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| 일일 지급 한도·반복 공감 제한: 기준·시간대·대상 미확정                 | reward-policy, reward-engine; 원자적 일별 quota 테이블/unique key, 승인된 설정 추가      | 중/P0(활성화 전), ⑤          | 날짜 경계·서로 다른 Post 동시 지급·한도 초과·회수 후 quota 복구 기준 검증 |
| 운영 정책/레벨/칭호 seed: 수치·표시명 승인 없음                        | reward-policy 설정 및 badges seed, 검토된 migration/seed                                 | 중/P0, ⑤                     | 실제 승인 fixture·level 경계·중복 seed·철회 시나리오                      |
| PENDING_POLICY/CONTEXT/ACCOUNT 전체 재평가 job: 소급 지급 범위 미확정  | activity.service, 별도 관리 CLI/worker; scan cursor/index·replay 감사 정보               | 중/P0 활성화, ③/⑤            | 중단 재개·dry-run·여러 worker·기지급 무변경·정확한 대상 수                |
| 정책 버전 전환/성장 기준 재산정: 기존 지급은 재가격하지 않음           | reward-engine, version rollout job; history/변경 계획 API 또는 CLI                       | 상/P1, ⑤                     | 정책 변경 중 이벤트 동시 처리·rollback·badge/level 전환 일관성            |
| 댓글 삭제에 따른 미래 댓글 공감 무효화: 아직 해당 이벤트 없음          | post-event, activity.service; commentId projection/FK 또는 인덱스                        | 중/P0 댓글 공감 활성화 전, ④ | delete 먼저/나중·자기 공감·수정 이벤트·동시성 결과 동일                   |
| 투표 결과 정정/취소·동률·여러 승자: 계약 없음                          | future adapter, activity.service, ledger unique identity 보강 가능                       | 상/P0 투표 활성화 전, ④/⑤    | result replay/새 버전/취소·다중 winner·삭제 경합                          |
| 사용자 차단 실행 경로: Entity 외 사양 없음                             | users 하위 block service/controller/DTO; 기존 user_blocks 재사용, 목록 인덱스 검토       | 중/P1, ④/⑤                   | 자기 차단·차단 중복·해제·목록·차단 전후 Post/알림/검색 노출의 공통 E2E    |
| 계정 제재/해제와 자동 만료: 상태 필드 외 명령 없음                     | moderation adapter, users status transition service; decision inbox·version·audit        | 상/P0 운영, ④/⑤              | 명령 인증·중복/역순·중복 복구·세션 폐기 실패·예약 해제 경합               |
| REST 계정 상태별 인가: 기존 GET/PATCH에 별도 제한 없음                 | 공통 authorization guard + 기존/신규 controller; 승인된 상태별 매트릭스                  | 중/P0 운영, ④/⑤              | SUSPENDED/탈퇴 중/최종 탈퇴의 read/write/복구 예외 검증                   |
| OAuth state/PKCE 책임·실 provider E2E: 현재 code exchange만 있음       | auth 계약 및 frontend callback/Gateway 연동; state/codeVerifier 필요성 합의              | 중/P0 운영, ④                | CSRF/state 불일치·code 재사용·redirect 불일치·실제 Kakao staging 로그인   |
| 이벤트 보존·원장/활동 개인정보 처리: 보존 기준 미확정                  | withdrawal scheduler, ledger/inbox/outbox purge job; anonymization/retention column 검토 | 상/P0 운영, ⑤                | 30일 복구 내 보존·최종 탈퇴 후 승인된 익명화·재처리 멱등성 유지           |
| 전용 모니터링·readiness·재처리 runbook: 현재 liveness와 경고 로그 중심 | health, consumer/outbox metric export, 내부 reconcile 실행 CLI                           | 중/P1, ③                     | lag/PEL/DLQ/outbox 지연·DB/Redis 장애 경보 및 실제 복구 drill             |
| 큰 Post의 재평가 비용: 현재 Post의 활동 전체를 한 transaction에서 평가 | activity.service; 변경 대상만 평가/terminal chunk job 및 fence 보강                      | 중/P1 규모 검증, ③           | 큰 fanout 부하에서 transaction timeout·순서/누락·lock 대기 측정           |
| PostgreSQL 운영 upgrade/rollback rehearsal·backup                      | migration runbook, staging DB                                                            | 중/P0 배포, ③                | 기존 데이터 보존·신구 버전 공존·FK/index 검증·복원 drill                  |
| legacy 서비스 JWT 제거·키 회전/전송 보안                               | grpc/service-auth, config 및 deploy secret 설정                                          | 중/P0 운영, ④                | 호출자 ES256 전환 확인·미허용 alg/issuer 차단·구키 제거·내부 TLS 확인     |

독립적으로 확정된 핵심 구현은 이번 변경에 포함했다. 위 ③ 중 운영 수집 시스템/트래픽 목표/
배포 DB 등 저장소 밖의 환경이 필요한 작업은 검증 조건 없이 임의 구성하지 않았다.
개인정보 파기·차단·제재 규칙도 추측으로 추가하지 않았다.

## C. 다른 서비스 요청 사항

### Post Service

| 정확한 요청 / 이유                                          | 계약 / 현재 상태                                                                                                                                                                                                                                                              | Post 구현 후 User 작업 / 완료 조건                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 댓글 공감 생성·취소 outbox 발행; 댓글 작성자 보상 식별 필요 | PostCommentReactionCreated/Removed, envelope eventId/eventType/schemaVersion/producer/aggregateId/correlationId/occurredAt, commentReaction{postId,commentId,userId,type,createdAt,removedAt?}, commentAuthorId, activityVersion, postAuthorId, postCategory. **현재 미발행** | adapter→parseFutureRewardInput→record 연결, comment terminal projection. 실제 Post mutation→Stream→User 원장 E2E 및 역순/자기 공감 검증 |
| 투표 확정 결과 outbox; 승리자/회차 멱등 식별 필요           | 제안 PostVoteResultFinalized, voteId/resultId/resultVersion/postId/finalizedAt/winners[{commentId,authorId}], 동률·정정/취소 의미. **현재 HTTP 후보 투표만 있고 결과 이벤트 없음**                                                                                            | winner별 normalize 및 불변 key 매핑; 정정 adapter; 동일 result 재발행 무지급·승리자만 지급 E2E                                          |
| 이벤트 원자성/보존·누락 replay 범위 합의                    | 현재 9종은 Mongo outbox. 구 v1은 create context 선택적. stream retention/backfill 계약 필요                                                                                                                                                                                   | 현재 parser 유지, legacy context 해소·시점 watermark 합의. 삭제/만료·late event·재시작 E2E                                              |

Post DB 직접 조회/HTTP polling은 해결책으로 사용하지 않는다. 구체적 제안과 연결 지점은
[REWARDS_CONTRACT.md](REWARDS_CONTRACT.md)의 마지막 입력 계약 절을 따른다.

### HTTP Gateway

- 요청: User Access JWT의 signature/허용 algorithm/iss/aud/exp 및 sub/sid 검증,
  외부 `x-user-id`, `x-session-id` 제거 후 검증 claim으로 덮어쓰기. 인증되지 않은 보호 route 401.
  `/api/v1/terms` 공개 프록시 경로도 추가해야 한다. 현재 route 목록은 auth/users만 User로 전달한다.
- 이유: 현재 Gateway는 개발 프록시이며 README가 JWT 연기를 명시한다. User REST는 헤더의
  형식만 확인하므로 현재 외부 헤더를 신뢰한 운영은 불가능하다.
- 전달 계약: canonical decimal x-user-id=sub, x-session-id=sid, x-request-id는 Gateway 생성 ID.
  신규 credits/growth/history는 기존 `/api/v1/users` proxy 범위 안이다.
- User 추가 작업: 인증 context/계정 상태 인가 합의, 필요 시 내부 요청 인증 guard.
  현재의 S2S gRPC JWT 검증은 사용자 Access JWT 검증을 대신하지 않는다.
- 완료: 위조 헤더/JWT 만료·서명·aud 오류 E2E 거부, 정상 프로필/보상 조회·logout 성공,
  외부에서 User 직접 접근 불가, 공개 약관 조회 성공.

### Moderation

- 요청: 사용자 제재 부여/해제의 소유권과 인증된 명령 또는 이벤트 확정.
  현재 Moderation은 Post lifecycle/삭제를 다루며 User 상태 전환 consumer는 없다.
- 제안 계약: `UserSanctionApplied` / `UserSanctionRevoked` 또는 동일 의미의 인증 RPC.
  decisionId/eventId, schemaVersion, producer, correlationId, occurredAt,
  userId, sanctionVersion, action, reasonCode, effectiveAt, suspendedUntil(nullable),
  소급 보상 무효화 여부 및 대상 sourceEvent/result ID. 최종 이름은 합의 필요.
- 이유: SUSPENDED 필드만으로 행위자·기간·순서·복구·재지급 근거를 알 수 없다.
- User 후속: decision inbox/version fence, 상태 변경·세션 정리, 해제 scheduler,
  승인된 보상 hold/revoke 처리. 현재 보상 엔진은 non-ACTIVE 지급을 보류한다.
- 완료: 인증된 결정만 반영, 중복/역순 무시, 해제 경합/세션 실패 복구,
  제재 대상의 기존·신규 보상 결과가 승인 정책과 일치.

### Notification

- 요청: `user:events` 전용 consumer group 및 4종 성장 이벤트 parser/멱등 처리/알림 저장.
  현재 User 성장 이벤트 소비는 없다. 기존 Post 소비 경로가 이를 대체하지 않는다.
- 필드: User envelope의 type/version/target.id/correlationId/occurredAt/eventId 및 payload
  userId/sourceEventId/policyVersion; credit은 ledgerId/delta/credits/growthScore,
  level은 previousLevel/level/growthScore, badge는 badgeId.
- 이유: User가 보상 결과를 소유하며 알림은 Notification 책임이다.
- User 후속: 합의된 스키마 fixture 공유·staging E2E. 현재 이벤트 발행은 완료되어 있다.
- 완료: 동일 eventId 재전송 알림 1개, level 최초 산정·강등·credit 회수의 표시/억제 규칙
  확인, 비활성 policy에서는 거짓 성장 알림 없음, 순서 역전은 REST 최신 값 또는 ledgerId 처리.

### Frontend

- 요청: Gateway 인증을 사용해 credits/growth/history/badges를 연결하고 disabled/null 상태 표시.
  본 작업에서는 UI 구현을 변경하지 않았다.
- 응답: credits/growthScore/delta/id/badgeId는 string, level은 number|null,
  rewardsEnabled boolean, levelFloor/nextLevelScore string|null, history는 items/nextCursor.
  경로·예시는 REWARDS_CONTRACT 참고. 기존 프로필·온보딩·약관·탈퇴 API를 유지한다.
- 이유: 0 잔액과 정책 미확정을 구분하고 JS number 변환으로 bigint 정밀도를 잃지 않아야 한다.
- User 후속: 최종 화면 요구와 오류·페이지네이션 fixture 검증. API 자체는 구현 완료.
- 완료: 기본 OFF 화면에서 가짜 level/예상 지급량 없음, 실제 token으로 본인만 조회,
  cursor 추가 로딩·빈 이력·최고 level·획득/회수 칭호·400/401/404 상태 UI 검증.

## D. 정책 결정 요청

확정: 댓글 투표 승리자, 타인의 긍정적 게시글/댓글 공감을 받은 작성자가 대상이다.
글/댓글 작성 자체, 단순 참여, 공감을 누른 행위에는 지급하지 않는다. 자기 공감에는 지급하지 않는다.
아래는 선택지이며 어느 것도 운영 기본값으로 승인하지 않았다. 전체 보상은 기본 OFF다.

| 미확정 정책                          | 선택지와 장단점                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 투표 승리 지급량                     | 고정(간단·참여 규모 무시), 참여/투표 규모 비례(기여 반영·조작/상한 필요)                                                       |
| 게시글 공감 대상·금액                | HELPFUL 등 일부만(의미 명확·적립 적음), 여러 긍정 종류별 차등(다양성·설명/악용 복잡)                                           |
| 댓글 공감 대상·금액                  | HELPFUL만 또는 AGREE 포함; 유용성 중심 대 참여 확대의 절충. DIFFERENT 지급 여부 별도 결정                                      |
| 일일 한도                            | 무제한(단순·악용 위험), 사용자별 일일 cap(통제·시간대/회수 규칙 필요), source별 cap 병행(공정·복잡)                            |
| 반복 공감                            | actor-target lifetime 1회(왕복 방지·복구 의미 제한), 회수 후 복원(최종 상태 일치·quota 조정 필요), 쿨다운(탄력·기간 추적 필요) |
| 취소/댓글·게시글 삭제 회수           | 항상 회수(최종 상태 명확·성취감 감소), 유지(단순 UX·삭제 악용), 위반 삭제만(균형·Moderation 근거 필요)                         |
| 자연 만료                            | 보상 유지(정상 만료에 불이익 없음), 회수(현재 유효 활동만 반영·짧은 콘텐츠 서비스와 충돌 가능)                                 |
| 성장 점수·레벨 임계값                | credits와 동일 net(정합 단순·강등), lifetime earned 별도(성장 안정·부정행위 회수 예외 필요); 선형/누진 임계값                  |
| 칭호 이름·등급·회수                  | 누적 점수형(명확), 활동별 업적형(다양·별도 조건 모델 필요); 영구 보유 또는 조건 미달 회수                                      |
| 계정 제재 시 보상                    | 신규 보류, 기간 내 몰수, 특정 활동만 무효화; 사용자 설명·이의 제기/해제 후 재판정 합의 필요                                    |
| 부정행위                             | 규칙 기반 cap/중복 제한(예측 가능·우회), Moderation 판정 기반 취소(정확성·지연), 혼합(복잡)                                    |
| 개인정보/보존                        | 감사 원장 보존+익명화 또는 기한 후 삭제; 법적 근거·기간·복구/멱등성 영향을 운영 담당과 확정                                    |
| 로그아웃·제재의 Access JWT 즉시 폐기 | TTL까지 허용(현 구현·낮은 비용), 매 요청 session/status 확인(즉시성·Redis/서비스 의존)                                         |

## E. 통합·배포 준비 상태

| 항목                  | 상태      | 증거 / 남은 조건                                                                                  |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| Gateway 인증          | 미완료    | JWT 연기, 위조 헤더 제거/내부 노출 차단/E2E 필요                                                  |
| Post 9종 수신         | 부분 완료 | 실제 Redis worker 통합 완료; 실제 Post 프로세스→User E2E와 구이벤트 replay 합의 필요              |
| 댓글 공감·투표 이벤트 | 미완료    | 내부 fixture adapter만 있음, producer 없음                                                        |
| Redis 운영            | 부분 완료 | timeout/reconnect/PEL/DLQ 구현; ACL/TLS/지속성/replication/trim/관측 필요. Cluster 미지원         |
| PostgreSQL migration  | 부분 완료 | 격리 DB up/down 검증; 운영 backup·기존 데이터 upgrade rehearsal 필요                              |
| Docker                | 부분 완료 | PostgreSQL 18/Redis 8 컨테이너 통합 검증; production app 배포/네트워크 E2E 별도                   |
| 환경변수·Secret       | 부분 완료 | 예제만 변경, 사용자 .env 열람/변경 안 함; 실제 secret 주입·회전·Kakao URL 확인 필요               |
| 서비스 간 E2E         | 미완료    | 실제 DB/Redis integration과 HTTP mock test는 있으나 전체 서비스/실 Kakao 조합 없음                |
| Backfill              | 미완료    | group 0부터 잔존 Stream replay만 가능, trim 이전 자료 복원/정책 소급 job 없음                     |
| 장애 복구             | 부분 완료 | receipt/rollback/ACK 실패/claim/reconnect/retry/DLQ 검증; 전체 장애·Redis 데이터 손실 drill 필요  |
| 운영 모니터링         | 부분 완료 | 경고 로그·내부 reconcile 함수; 지표·dashboard·알림·관리 CLI 없음                                  |
| 개인정보·보존         | 미완료    | 기존 최종 탈퇴가 프로필/OAuth/관계를 정리. term-consent·신규 활동/원장·정책 이력 보존은 승인 필요 |

전체 판정: **User 내부 핵심 구현은 사용 가능한 상태지만, 전체 서비스의 운영 완성은 미완료다.**
정책 OFF 및 Gateway 인증 미완료가 운영 지급·외부 공개의 선행 차단 조건이다. 근거 없는 완성도 %는 산정하지 않는다.

## F. 다음 개발 단계

1. **즉시 — User/운영:** 신규 migration staging rehearsal, metrics/readiness·DLQ 재처리 도구,
   큰 Post 부하 측정. 완료 기준: 기존 데이터 보존 및 반복 가능한 장애 복구 증거.
2. **정책 확정 — 제품+User:** 금액/종류·회수·일일/반복 제한·성장/칭호·보존 승인 →
   quota 및 승인 seed → 정책 버전 전환/보류 활동 재평가 job. 완료 기준: 실제 승인 fixture 전체 통과,
   dry-run과 지급 대상·금액 검토 후 enabled 전환.
3. **외부 계약 — Post/Gateway/Moderation:** 댓글/투표 outbox·정정 계약, JWT 신뢰 경계,
   제재 명령·보상 무효화 계약 → User adapters/인가/계정 전환 구현.
   완료 기준: 타 서비스 mutation부터 User DB/원장까지 중복·역순·인증 E2E 통과.
4. **후속 소비 — Notification/Frontend:** 성장 이벤트 멱등 알림·실제 API UI 연결.
   완료 기준: 재전송 알림 1개, disabled/null/cursor/error 화면 및 탈퇴·복구 동작 확인.
5. **최종 배포 — 전체/운영:** Secret/TLS/네트워크/Redis persistence·retention/backup 설정,
   데이터 backfill과 정책 소급 범위 승인, canary 및 rollback·복원 drill.
   완료 기준: 승인된 운영 정책과 개인정보 기준, E2E/부하/장애 지표 충족 후 운영 공개.

PR 생성과 Issue 종료는 사용자 승인 후 별도로 수행한다. 이번 로컬 커밋은 배포나 보상 정책 승인을 의미하지 않는다.
