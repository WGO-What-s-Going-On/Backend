# Post Service 작업 현황

## 2026-09-26 게시판 WebSocket 연동

- 서비스 JWT로 보호하는 내부 상세·댓글 목록·댓글 작성 경로를 추가했다.
- `mutationId` 유일 인덱스로 재연결 후 댓글 작성 재시도를 멱등 처리한다.
- MongoDB 커밋 직후 Outbox Worker를 깨우고 주기 폴링은 복구용으로 유지한다.
- MongoDB·Redis 통합 테스트 12개, 타입 검사, 빌드를 통과했다.
- 로컬 MongoDB·Redis, Post Service, Gateway 2개 인스턴스에서 댓글 100회 전송부터 다른 인스턴스 수신까지 P95 10.98ms(최대 12.38ms)를 측정했다. 커밋 전 시간도 포함한다.

기준: 2026-09-24. 이 문서는 현재 구현과 다음 작업의 범위를 추적한다. API와 이벤트의 상세 계약은 [PostService_Architecture.md](./PostService_Architecture.md), 실행 방법은 [README.md](./README.md)를 참고한다.

## 현재 구현

| 영역 | 완료 내용 |
| --- | --- |
| 생성 API | `POST /api/v1/posts`, `/{postId}/comments`, `/{postId}/reactions` (`LIKE`), `/{postId}/participants` |
| 조회 API | MongoDB 현재 상태를 읽는 HTTP 상세·댓글 커서 조회(ACTIVE만), 내부 batch-get·meta·status 조회. 운영 meta/status는 서비스 JWT 필요 |
| 도메인 규칙 | 입력 불변 조건, ACTIVE 게시물 확인, Reaction·Participant 중복 생성 방지, 참여 종료 기록이 있는 사용자의 재참여 |
| 인증·참여 허가 | 로컬·테스트에서 `X-User-Id` 검증 및 개발용 참여 허가. 운영 환경에서는 실제 연동 전 생성·참여 요청 거부 |
| 저장 | `posts`, `post_comments`, `post_reactions`, `post_participants`, `outbox_events` Mongoose 스키마와 인덱스. 생성 데이터·카운터·Outbox를 단일 MongoDB 트랜잭션에 저장 |
| 이벤트 | Outbox Worker가 Redis Stream `post:events`에 네 생성 이벤트 발행. 실패 및 선점 만료 재시도 시 `eventId` 유지 |
| 로컬 환경 | 단일 노드 MongoDB Replica Set, 별도 포트의 Redis Compose 구성 |

새 게시물은 `ACTIVE`로 생성하며 `expiresAt`은 `null`이다. Moderation의 수명주기 판단과 만료 처리는 현재 구현 범위 밖이다.

### 실시간 게시판 연결 상태

WS Gateway는 ACTIVE 게시물 room 참여, 게시물·댓글 조회와 댓글 작성, 네 생성 이벤트 전파를 제공한다. Post Service는 영속 상태와 작성 규칙을 소유한다.

| 경로 | 현재 상태 |
| --- | --- |
| Post Service → Redis Streams | `PostCreated`, `PostCommentCreated`, `PostReactionCreated`, `PostParticipantJoined` Outbox 이벤트 발행 구현·통합 테스트 완료 |
| HTTP Gateway → Post Service | `/api/v1/posts` 투명 프록시 경로는 있다. Map 검색 결과와 batch-get을 조합하는 `/nearby` 구현은 없다 |
| WS Gateway → Post Service/Map Service | `boardId=postId`; Post Service ACTIVE 상태로 참여 허가. Map 위치 제한은 후속 계약 |
| Redis Streams → WS Gateway → 클라이언트 | `post-realtime` Consumer Group, Redis Pub/Sub 다중 인스턴스 전파, room 브로드캐스트 구현 |
| 재연결 시 최신 상태 회복 | 클라이언트가 다시 참여하고 `post.get`·`comment.list` 페이지를 읽는다 |

100회 반복한 로컬 두 Gateway 측정에서 댓글 명령 전송부터 다른 인스턴스 수신까지 P95 10.98ms였다.

### 코드 경계

`presentation → application → domain` 방향으로 의존한다. 생성 Command는 `PostUnitOfWork`, `PostStateQueries`, `ParticipationAuthorization` 포트에 의존한다. 조회 유스케이스는 별도 `PostReadQueries` 포트를 사용한다. `PostModule`이 이를 Mongoose 저장소와 로컬 참여 허가 구현에 연결한다. 조회 요청은 쓰기나 Outbox 발행을 하지 않는다. Outbox Worker는 인프라 영역에서 동작한다.

## 확인한 검증

- `RUN_INTEGRATION=1 pnpm test`: MongoDB Replica Set·Redis 통합 테스트 포함 12개 통과. 생성, 입력 오류, 비활성·미존재 게시물, 중복·재참여, Outbox 실패 시 롤백, 네 이벤트 발행, 서비스 JWT와 `mutationId` 재시도 확인.
- `pnpm typecheck`, `pnpm build`: 통과.
- 프로젝트 요구 버전은 Node.js 24다. 이번 조회 API의 통합 테스트·타입 검사·빌드는 Node.js 26에서 통과했다. **Node.js 24 재검증이 남아 있다.**

## 다음 작업

체크박스는 구현과 검증이 끝난 뒤 표시한다. 외부 서비스 계약이 필요한 작업은 해당 계약을 먼저 확정한다.

### 우선순위 1: 운영 연동과 계약

- [ ] **Gateway 인증 연동:** 신뢰할 수 있는 사용자 ID 전달·검증 계약을 정하고 `X-User-Id` 개발용 경로를 교체한다. 운영 환경의 네 생성 API가 인증된 요청을 처리하고 위조된 ID를 거부하는지 확인한다.
- [ ] **Map Service 참여 허가 연동:** 위치·반경·게시물 상태에 필요한 요청/응답 계약을 확정하고 `ParticipationAuthorization` 구현을 교체한다. 허가·거부·Map 장애 사례를 테스트한다. 게시물 생성에는 참여 허가 검사를 추가하지 않는다.
- [ ] **Moderation 상태 계약:** 상태 변경과 `expiresAt` 설정의 입력, 권한, 허용 전이를 확정한다. 조건부 상태 변경과 Outbox 기록을 한 트랜잭션으로 구현한 뒤 중복 결정·경합을 테스트한다.
- [ ] **이벤트 소비자 계약 확인:** Map·Notification·Moderation·Realtime 소비자와 `post:events`의 필드, 스키마 버전, Consumer Group, `eventId` 중복 제거 규칙을 맞춘다. 계약 변경 시 생산자·소비자 테스트와 설계 문서를 함께 갱신한다.
- [ ] **WS Gateway 실시간 연결:** `boardId`/`postId`와 join 인가 계약을 확정하고 실제 adapter를 연결한다. `post:events`의 Realtime Consumer Group, Redis Pub/Sub 다중 인스턴스 전파, 게시물 room 브로드캐스트를 구현한다. 게시물 생성·댓글 작성 후 접속 중인 클라이언트 수신과 재연결 시 HTTP 재조회까지 엔드투엔드 테스트한다.

### 우선순위 2: 조회와 상태 변경

- [x] **Post Service HTTP 조회 API:** 게시물 상세, 댓글 커서 조회, 내부 batch-get·meta/status 조회를 구현했다. 내부 경로는 서비스 간 인증 연동 전까지 운영에서 차단한다. 이 완료 표시는 WS Gateway 실시간 전달이나 주변 검색 조합의 완료를 뜻하지 않는다. `PostViewed` 집계도 별도 작업이다.
- [ ] **주변 게시물 조회 조합:** Map Service의 위치 검색 결과를 HTTP Gateway가 Post Service 내부 batch-get과 조합하는 계약·구현·통합 테스트를 완료한다. 현재 HTTP Gateway는 `/api/v1/posts`를 투명 프록시만 한다.
- [ ] **종료·취소 Command:** 게시물 수정·삭제, 댓글 삭제, LIKE 취소, 참여 종료를 각각 도메인 규칙과 조건부 쓰기로 구현한다. 카운터와 Outbox 이벤트를 같은 트랜잭션에서 갱신하고 반복 요청의 멱등성을 검증한다.
- [ ] **만료 처리:** Moderation이 `expiresAt`을 설정한 뒤 `ACTIVE → EXPIRED` 만료 Worker와 `PostExpired` Outbox 기록을 구현한다. 중복 실행·경합·Map 인덱스 제거 흐름을 확인한다.
- [ ] **API 경로 정합성:** 상세 설계에 남아 있는 Client-facing 경로와 내부 Gateway 경로의 역할을 확정하고, 구현·문서·호출자를 일치시킨다.

### 우선순위 3: 운영 검증

- [ ] **Outbox 장애 시나리오:** Redis 연결 실패, 재시도 지연, 선점 만료, 발행 직후 프로세스 중단, 다중 Worker 경쟁을 테스트한다. 미발행 건수·최장 대기 시간·반복 실패를 관측할 수 있게 한다.
- [ ] **동시 요청 검증:** Reaction·Participant 동시 생성과 재참여 경합에서 고유 인덱스, 카운터, 이벤트 수가 일치하는지 검증한다.
- [ ] **Node.js 24 및 CI:** 요구 런타임에서 타입 검사·테스트·빌드를 재실행하고, Replica Set·Redis가 필요한 통합 테스트를 CI에서 반복 가능하게 만든다.
- [ ] **계약 세부값 확정:** 카테고리 허용값, 반경 제한, correlation ID 전달 방식, Outbox 보존 기간을 호출 서비스와 합의해 입력 검증·이벤트 문서에 반영한다.
