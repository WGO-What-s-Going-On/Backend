# 중앙대 캠퍼스 챌린지 두 게시글의 운영 절차

이 변경은 앱이나 공개 API에 이벤트 생성 기능을 추가하지 않는다. `CAU_CAMPUS_2026_30D` 정책과 아래 고정 ID가 **둘 다** 일치하는 글만 예외다.

| 내용 | 예약 ID |
| --- | --- |
| 학과 대항전 | `post_3b16ea1a-4de6-4a2c-85be-56a64ada2031` |
| 고인물 인증 대회 | `post_3b16ea1a-4de6-4a2c-85be-56a64ada2032` |

## 정책 및 이벤트 계약

- 일반 생성/수정 API의 허용 필드는 그대로다. 사용자가 `lifecyclePolicy`를 제출하면 거절한다.
- 관리자 일회성 생성은 기존 도메인 검증, MongoDB UnitOfWork, `insertPost`의 bucket 카운터 초기화, `scheduleExpiration`과 같은 저장 명령, Outbox를 사용한다. 두 글과 각각의 `PostCreated`는 한 트랜잭션으로 커밋된다.
- 제목·본문은 `domain/campus-events.ts`의 확정 원문을 독립 필드에 저장한다. 투표는 생성 순간부터 NONE이다. 고정 postId 유니크 인덱스와 트랜잭션 재조회로 중복/동시 실행을 방지한다. 기존 ID의 내용·작성자·좌표·기한·투표가 다르면 변경하지 않고 중단한다. 만료·숨김·삭제된 글을 재실행으로 복구하지 않는다.
- `PostCreated.post.lifecyclePolicy`와 기존 `post.expiresAt`을 함께 전달한다. 만료일은 `occurredAt/createdAt + 2,592,000,000ms`이다. envelope v1, postVersion, authorId 및 기존 활동 이벤트는 유지한다. Map/User 소비자는 추가 필드를 무시하고 기존 사실을 처리한다. Notification은 기존에 생성 기한을 null로 제한하므로 이번 두 이벤트의 정확한 30일 기한만 추가 허용한다.
- Moderation은 이 두 ID의 정책과 정확한 30일 기한을 검증한 뒤 projection에 저장한다. 무활동·ENDED 평가만 건너뛴다. 댓글 콘텐츠 검토·신고·숨김·삭제는 유지한다.
- 이벤트 글도 Redis active set과 due set에 **모두 유지**하고 due score는 실제 만료일이다. 댓글·공감·재전달·CAS 전환·due 재구축도 같은 기한을 쓴다. PostExpired/Hidden/Deleted 처리 시 정상 종료 경로로 두 집합에서 제거한다. 날짜를 위조하거나 예외 ID를 인덱스에서 수동 삭제하지 않는다.
- Post는 이벤트 글의 BOARD_CLOSED를 이력 기록 후 무시한다. 구버전 Moderation의 실수로 30일 예약이 덮어써지는 것을 방어한다. ExpirationWorker 및 정상 제재는 그대로 적용한다.
- 논리적 만료는 정확한 기한이다. API 참여는 그 시각부터 거절된다. DB 상태 변경·비동기 PostExpired 전파는 기존 worker poll/queue 지연만큼 늦을 수 있으며, 밀리초 단위 전달을 보장하지 않는다.
- 프론트는 고정 ID + 정책 + radiusM=350이 모두 확인된 경우에만 350m를 사용한다. 일반 글의 UI는 150m를 유지한다. 이벤트의 게시글/댓글 공감도 Post→Map의 기존 위치 RPC로 350m를 검증한다. 기존 일반 공감 API 동작은 바꾸지 않는다. 댓글의 `verified` 배지는 기존 150m 의미를 유지한다.

## 운영 실행 전 승인 및 배포 순서

PR 병합, 실제 배포 및 운영 생성은 각각 사용자 승인 후에만 수행한다. 현재 저장소 코드/테스트 준비가 운영 실행 승인을 대신하지 않는다.

운영용 PR은 `main`을 기준으로 캠퍼스 커밋만 반영한다. `dev` 전체를 승격해 #148·#149를 함께 배포하지 않는다. `main` 병합은 현재 실제 `wgo-demo` 클러스터를 대상으로 하는 CD의 `staging` 작업을 자동 실행하므로, 병합 승인이 배포 승인을 포함하는지 먼저 확인한다.

아래 2~4번은 개별 수동 배포 시의 권장 순서다. 현재 자동 CD는 서비스 의존성과 마지막 배포 상태로 순서를 계산한다. 이번 PR 변경분과 `CD_DEPLOY_CONCURRENCY=1`만 기준으로 하면 User → Notification → Moderation → Post 순서다. User 조회 스크립트가 서비스 경로에 있어 User 이미지도 배포 후보가 되지만 User 런타임·칭호 정책·마이그레이션 변경은 포함하지 않는다. 자동 CD를 사용해도 **모든 관련 서비스의 완전한 교체 전에는 생성하지 않는다**. 아직 캠퍼스 글이 없는 동안의 혼합 배포 순서가 캠퍼스 글 생성 이후의 구버전 공존을 허용하는 것은 아니다.

1. 운영 Post MongoDB와 Moderation Redis의 검증 가능한 백업을 남기고 복원 가능 상태를 확인한다. 기존 사용자/게시글 baseline 및 대상 ID 미점유를 읽기 전용으로 확인한다.
2. **Notification Service를 먼저 배포**한다. 구 소비자는 expiresAt가 있는 PostCreated를 거절하므로 모든 Pod가 새 digest로 교체될 때까지 생성하지 않는다. 일반 PostCreated의 null 기한 허용은 그대로 유지된다.
3. **Post Service를 배포**한다. 모든 Pod가 새 digest이고 Ready인지 확인한다. 새/구 Post가 섞여 있으면 생성 금지다. 구 Post의 BOARD_CLOSED 소비에는 보호 로직이 없다.
4. **Moderation Service를 배포**한다. 모든 이벤트 소비자·스케줄러가 새 digest이고 Ready이며 구 Pod(종료 중 포함)가 없음을 확인한다. 구 Moderation은 새 필드를 무시하고 일반 projection을 만들거나 잘못된 경고/종료를 발행할 수 있으므로, Post 보호가 있더라도 혼합 상태에서 생성하면 안 된다.
5. 프론트를 배포하고 캐시/서비스워커 갱신 뒤 350m 표시를 확인한다. 기존 프론트는 안전하게 읽기 전용으로 동작하지만 150~350m 참여는 열리지 않는다. Map/User/Gateway는 이번 정책을 위해 배포할 필요가 없다. 일회성 User 조회 스크립트는 현재 User 환경에서 실행하며 앱을 시작하거나 migration하지 않는다.
6. `scripts/campus-rollout-evidence.mjs <명시적-context> wgo-demo <검토된-Post-digest> <검토된-Moderation-digest> <검토된-Notification-digest>`로 읽기 전용 Pod/Deployment 스냅샷을 수집한다. 환경변수·Secret은 출력하지 않는다. 생성 manifest의 `rollout`에 이 JSON을 넣는다. CLI는 스냅샷이 5분 이내이며 세 서버 서비스의 모든 replica/Pod가 지정 digest로 Ready이고 종료 중인 구 Pod도 없는지 검사한다. 이 증거는 운영자가 승인한 release digest의 스냅샷이며 서명된 인증서가 아니다. 생성 동안 재배포/롤백하지 않는다.
7. 생성 후에는 30일 동안 구 Post/Moderation으로 롤백하지 않는다. Notification도 신규 생성 이벤트가 미처리/재전달될 수 있는 동안은 구 버전으로 롤백하지 않는다. 정책을 모르는 버전과 안전하게 공존할 수 없으므로, 장애 시 이벤트 처리를 보존하는 수정 버전을 배포한다. 기존 projection을 삭제하거나 소비자/전역 정책을 중지하는 복구는 금지다.

## 작성자·좌표 확인과 dry-run

승인된 기존 계정의 정확한 닉네임은 **머준**이다. authorId는 아직 추정하거나 입력하지 않았다.

- User Service의 기존 유효 runtime 환경에서 `node scripts/campus-author-readonly.mjs`를 실행한다. User 소유 DB에서 읽기 전용 트랜잭션으로 정확히 일치하는 ACTIVE 계정 하나만 조회한다. 결과의 authorId를 manifest에 사용한다. 별도 운영 계정을 생성하지 않는다. 계정을 확실히 식별하지 못하면 사용자에게 확인하고 중단한다.
- 공식 중앙대 캠퍼스맵에서 **서울캠퍼스 203관 서라벌홀**을 확인하고, 실제 지도에서 검증한 WGS84 좌표와 출처/검증시각을 기록한다. 공식 약도의 건물명 확인만으로 수치 좌표가 검증된 것은 아니다. 예제 manifest의 null 좌표를 추정값으로 채우지 않는다. CLI의 캠퍼스 범위 검사·동작구 역지오코딩은 건물 좌표 검증의 대체가 아니다.
- `campus-events.manifest.example.json`을 별도 운영 파일로 복사해 확인된 authorId·좌표·검증 증거를 넣는다. 예제의 null 값은 실행을 차단한다.
- Post Service 패키지에서 빌드 후 `npm run campus-events -- <manifest.json>`으로 dry-run한다. 기본값은 읽기 전용이다. 공개 API나 GPS 갱신/위치 우회를 사용하지 않는 명시적인 관리자 작업이다.
- 실제 쓰기는 최종 승인 뒤 `npm run campus-events -- <manifest.json> --apply`이다. 명시적 MONGODB_URI/USER_GRPC_ADDRESS/MAP_GRPC_ADDRESS와 기존 서비스 서명 자격증명을 사용한다. User gRPC로 authorId·닉네임·ACTIVE를 다시 대조하고 Map으로 지역을 확인한다. 자격증명은 로그/manifest에 넣지 않는다. Mongo 자동 인덱스 생성은 비활성화하며 기존 postId 유니크 인덱스가 없으면 중단한다.
- CLI는 앱/소비자/스케줄러를 시작하지 않는다. 기존 Post OutboxWorker가 커밋된 두 이벤트를 발행한다. 재실행은 기존 결과를 검증하여 반환하며 새 글을 만들지 않는다.

## 생성 이후 검증

1. 두 Post의 원문·authorId·좌표·350m·createdAt+30일·NONE·ACTIVE를 재조회한다. Outbox의 해당 두 PostCreated 및 streamId를 연결한다.
2. Map의 Cassandra 상태/위치·Redis GEO/Cell 인덱스, Moderation의 ACTIVE projection·정책·실제 만료일 due score·active/due membership, Notification 처리 영수증과 User 활동을 해당 eventId로 확인한다. 다른 글/사용자 원본을 수정하지 않았는지 baseline과 대조한다. 정상 Notification/User 소비에 따른 파생 활동/알림은 생성 이벤트의 의도된 결과다.
3. `https://wgo-now.vercel.app/boards/<postId>` 직접 링크를 열어 실사용자 위치에서 150~350m 댓글·공감과 350m 초과 거절, NONE 투표 UI를 확인한다. 운영 댓글/공감 쓰기 검증은 별도 승인 범위로 수행하고 결과를 기록한다.
4. 30일 후 PostExpired가 Map 인덱스 제거, Moderation terminal 처리, Notification 종료 처리로 전파되는지 확인한다. 일반 신고·숨김·삭제는 만료 전에도 유효하다.

## 로컬 검증

- Post: `RUN_CAMPUS_INTEGRATION=1 npm test -- test/campus-events.integration.test.ts` (전용 localhost:27029 Mongo replica set 및 localhost:16380 Redis DB14)
- Moderation: `MODERATION_TEST_REDIS_URL=redis://127.0.0.1:16383/15 npm run test:integration -- test/integration/campus-lifecycle.integration.ts`
- 일반 lifecycle/소비자 회귀 및 각 패키지 typecheck/build, Map·User·Notification의 공통 fixture 계약 테스트
- 프론트: `npm test` 및 `npm run build`

fixture의 authorId=42 및 좌표 0,0/37.505,126.958은 **로컬 테스트 전용**이며 운영 값이 아니다.
