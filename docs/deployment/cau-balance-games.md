# 중앙대 고정 A/B 게시글 3개 운영 준비

이번 변경은 `main`의 캠퍼스 코드를 재사용한다. 기존 학과 대항전(`…2031`)과 고인물 인증(`…2032`)의 생성 코드·원문·투표 NONE·운영 데이터는 유지한다. `dev` 및 #148/#149 승격은 없다. 현재 단계는 PR/검증까지이며 병합·배포·운영 생성 승인은 별도로 받는다.

| 예약 ID | 승인 주제 | 고정 A / B |
| --- | --- | --- |
| `post_3b16ea1a-4de6-4a2c-85be-56a64ada2033` | 송강 vs 종강 | 송강 / 종강 |
| `post_3b16ea1a-4de6-4a2c-85be-56a64ada2034` | 올 A+ vs 월금공강 | 올 A+ / 월금공강 |
| `post_3b16ea1a-4de6-4a2c-85be-56a64ada2035` | A+ 독박 vs B+ 버스 | A+ 독박 / B+ 버스 |

제목·본문·선택지는 [승인 manifest](./cau-balance-games.manifest.json)에 독립 필드로 저장한다. 2026-11-24 대화에서 주제 2·3의 원문을 사용자가 승인했다. 원문 변경 시 `balanceApproval` 해시를 자동 갱신하지 말고 다시 확인받는다. 내용 확인용 SHA-256은 JSON의 `balanceGames`를 title/content/choices 순서로 정규화해 산출한다. 이는 운영자 확인 장치이며 공개 API의 권한 검증을 대체하지 않는다.

## 후보 표현 및 투표 계약

실제 댓글을 후보로 만들면 CommentCreated·댓글 카운터·알림·칭호·삭제 시 후보 취소 경로에 가짜 활동이 들어간다. 따라서 댓글 행을 만들지 않는다. 기존 `vote.candidates`와 `VoteSelection` 유니크 인덱스 `(postId,userId)`를 재사용하며, 세 글만 `vote.kind=FIXED_AB`, `status=OPEN`, `selectedAt=createdAt`, 후보 두 개/0표로 생성한다.

기존 HTTP 요청·응답의 `commentId`는 선택 키로 유지한다. 세 예약 글의 투표 PUT에만 `option_A`/`option_B`를 허용한다. 댓글 API는 계속 `comment_<uuid>`만 허용하고, 일반 투표도 기존 검증을 유지한다. 고정 후보를 실제 댓글 ID처럼 위장하지 않는다. 정상 사용자 생성 API는 여전히 vote/balanceChoices/lifecyclePolicy를 거절한다.

`MongooseVote.choose/change/cancel/read`와 기존 트랜잭션/중복 방지를 사용한다. 투표 변경·취소 시 가짜 활동 이벤트를 발행하지 않는다. VoteWorker의 PENDING 자동 선정 및 운영 vote-requeue에서도 지정 세 글을 제외한다. 종료 시 결과와 승자는 보존하지만 댓글 작성자를 조회하거나 `PostVoteWon`을 발행하지 않는다. `PostVoteCandidateSelected`도 발생하지 않으므로 이 투표 결과로 보상·칭호·랭킹이 지급되지 않는다. 정상 PostCreated·실제 댓글·공감 활동의 기존 보상 정책은 유지한다.

생성은 기존 Mongo UnitOfWork 안에서 세 글·bucket 카운터·scheduleExpiration·세 Outbox PostCreated를 원자적으로 커밋한다. 재실행 시 ID/작성자/제목/본문/좌표/반경/기한/후보 키/후보 내용을 대조한다. 표 수·종료 상태·기존 시간을 초기화하지 않으며, 충돌은 전체 롤백한다. 기존 두 글의 ID는 이 생성 반복문에 포함하지 않는다.

## 수명과 참여

예약 ID + `CAU_CAMPUS_2026_30D`를 동시에 확인하는 기존 정책을 다섯 글까지 명시적으로 허용한다. PostCreated의 정책·30일 expiresAt·350m 반경 검증, Moderation projection/active set/due score는 기존 경로를 따른다. 실제 만료 시각을 due score로 유지하며 무활동·ENDED만 제외한다. 신고·콘텐츠 검토·숨김·삭제는 계속 적용된다.

생성 시각 + 2,592,000,000ms부터 새 투표/변경/취소와 댓글 참여를 거절한다. ExpirationWorker가 결과를 닫고 PostExpired를 기존 Outbox로 전파한다. DB 상태와 비동기 소비는 기존 poll/queue 지연이 있을 수 있다.

Post→Map의 실제 최근 위치 검증으로 350m를 확인한다. 관리자 생성은 사용자 GPS를 업데이트하거나 위치 검증을 통과한 것처럼 위장하지 않는다. 댓글 verified 배지는 기존 150m 의미를 유지한다.

프론트는 기존 선택·변경·같은 후보 재선택 취소 UI를 재사용한다. 지정 세 글의 라벨과 350m 허용 ID를 추가한다. 다른 투표자는 winner/candidate 보상 이벤트를 만들지 않으므로 이 세 글만 보이는 동안 5초마다 GET vote로 집계를 갱신한다. WebSocket 연결 중에도 실행하며 댓글/게시글 조회수를 늘리지 않는다. 실시간 push가 아닌 최대 약 5초의 HTTP 갱신이다.

Frontend PR #5는 운영 미배포 상태다. 추가 프론트 PR은 #5 위에 쌓아 #5 자체를 바꾸지 않는다. **#5와 이번 최소 변경이 모두 배포되어야 150~350m 참여와 연결 중 집계 갱신을 보장한다.** 현재 운영 프론트는 여전히 150m 제한이 있다.

## 실제 배포 범위와 차단 조건

런타임 변경 서비스는 **Notification, Moderation, Post**뿐이다. Map/User는 계약 테스트만 바뀌며 이미지 재배포 대상이 아니다. Gateway/공유 패키지/DB 스키마/노드/서비스 리소스/Secret/환경변수/CD 설정은 변경하지 않는다.

현재 CD는 main push에서 실제 클러스터를 대상으로 staging 작업을 자동 실행한다. 변경 파일을 실제 `selectChanges`/`deploymentWaves`에 넣으면 이번에는 세 서비스가 같은 wave이며, **동시성 1의 실제 순서는 Post → Notification → Moderation**이다. Post는 User/Map에만 배포 의존성이 있고 이번에는 두 서비스가 변경되지 않아, 이전 캠퍼스 배포의 순서와 달라진다. 동시성이 높으면 세 서비스가 병렬로 배포될 수 있다. 신규 세 글이 없는 동안의 혼합 배포는 기존 글과 호환된다. **생성 이후 구 Notification/Moderation은 신규 ID를 거절하고, 구 Post는 고정 후보 종료를 처리하지 못한다. 따라서 세 서비스의 모든 consumer/worker Pod가 새 digest로 완전히 교체되기 전에는 절대 생성하지 않는다.** 기존 두 글은 새/구 코드 모두 지원한다.

중요한 배포 사전 조건: 현재 CD는 Notification 소스 변경 시 SQL 스키마 변경이 없어도 migration Job을 항상 만든다. 이전 배포에서 이 Job의 app 25m + proxy 10m가 단일 노드의 잔여 CPU 예약량을 초과했다. 이전 한 번의 10m 승인을 이번 배포에 재사용하지 않는다. 이번 PR에는 migration/인프라 수정이 없다. **현 CD의 불필요한 migration Job과 자원 제약을 안전하게 처리할 승인된 배포 경로를 병합 전에 확정해야 한다.** 노드 증설·리소스 조정·Consumer 중지로 우회하지 않는다. 병합만 먼저 해 자동 CD를 실패시키지 않는다.

배포가 승인되면 다음 순서로 실행한다.

1. 운영 작성자 1의 nickname=머준/ACTIVE와 좌표/Map resolveRegion을 읽기 전용으로 다시 대조한다. 기존 전체 데이터와 두 기존 ID의 baseline/해시, 새 세 ID 미점유를 확인하고 Post MongoDB 및 Moderation Redis의 새 백업을 검증한다. 오래된 이전 백업을 새 실행의 백업으로 대체하지 않는다.
2. 위 migration Job 문제의 승인된 처리 경로를 확정한 뒤 해당 세 서비스만 배포한다. 새 digest와 release/source SHA, readiness, 구/종료 중 Pod 부재, Outbox/Stream/소비자 오류·DLQ를 확인한다. 운영 리소스 변경은 없다.
3. #5 및 후속 프론트를 배포하고 정상 사용자 위치에서 350m UI를 확인한다. 운영 생성 승인 없이는 생성하지 않는다.
4. `node scripts/campus-rollout-evidence.mjs <explicit-context> wgo-demo <new-post-digest> <new-moderation-digest> <new-notification-digest>`를 읽기 전용으로 실행한다. 출력의 `rollout`을 manifest 사본에 포함한다. 완료된 Job은 ownerReferences.kind=Job과 Succeeded/Failed를 함께 확인한 경우에만 Pod 수에서 제외한다. 실행 중 Job 및 구/종료 중 application Pod는 계속 차단한다.
5. 새 Post 이미지의 기존 운영 환경에서 아래 dry-run을 수행한다. 스크립트는 매번 User gRPC 및 Map region을 대조하고 기존 postId 유니크 인덱스를 확인한다. 명시적 MONGODB_URI/USER_GRPC_ADDRESS/MAP_GRPC_ADDRESS와 기존 서비스 인증을 사용하며 Secret을 파일/로그로 복사하지 않는다.

```sh
# services/post-service 작업 디렉터리, 새 이미지에 포함된 CLI
node dist/post/infrastructure/campus-events.cli.js /private/manifest.json --balance-games
# 모든 배포·내용·생성 승인이 확인된 뒤에만
node dist/post/infrastructure/campus-events.cli.js /private/manifest.json --balance-games --apply
```

manifest에는 현재 rollout 증거가 없으므로 저장소 파일 그대로 apply하면 실패한다. dry-run은 쓰기 없이 세 ID/내용을 확인한다. apply 직전 rollout/내용 승인 freshness를 재검증한다. `--balance-games` 없이 기존 두 글 생성 경로를 실수로 실행하지 않도록 명령을 대조한다.

6. Mongo의 세 문서/OPEN/두 후보/0표/30일, Outbox의 PostCreated 3개/PUBLISHED, Map location/cell/GEO 인덱싱, Moderation ACTIVE/정책/정확한 due score, Notification processed event/version/미종료 상태를 읽기 전용으로 확인한다. 기존 두 글과 baseline의 변경이 없는지 대조한다. 생성 결과에는 공개 ID/링크만 기록한다.
7. 정상 사용자 위치로 참여를 확인한다. 운영 테스트 표/댓글/공감을 만들려면 별도 범위를 확인하고, 가짜 활동을 넣지 않는다. 30일 뒤 PostExpired가 각 소비자에 정상 전파되는지 확인한다.

실패하면 부분 수동 insert나 Outbox/Redis 조작으로 복구하지 않는다. 생성 트랜잭션 결과부터 확인하고, 승인된 manifest 재실행으로 누락 여부를 안전하게 판별한다. 생성 후 정책을 모르는 버전으로 롤백하면 조기 종료·만료 실패 위험이 있으므로 새 글이 있는 동안 세 소비자는 정책 호환 버전을 유지한다.

## 검증 명령

- Post unit/typecheck/build 및 `RUN_CAMPUS_INTEGRATION=1` campus-events 통합 테스트: 전용 localhost:27029 Mongo replica set, Redis localhost:16380/14, 임의 생성 DB만 사용한다.
- Moderation unit/typecheck/build 및 `MODERATION_TEST_REDIS_URL=redis://127.0.0.1:16383/15` 통합 테스트: 다섯 ID의 projection/due/replay/ENDED/만료와 일반 one-hour/inactivity/early-close 회귀를 확인한다.
- Notification unit/typecheck/build, Map/User의 PostCreated/PostExpired 계약 fixture를 다섯 ID로 검증한다.
- Frontend test/build: 후보 댓글 없이 두 선택지/결과/내 선택 표시, 범위 밖 취소, 종료 버튼 비활성화, 기존 NONE 및 일반 라벨/150m 유지.

로컬 테스트의 synthetic 제목/본문은 승인 manifest와 구분되며 운영에 사용하지 않는다.
