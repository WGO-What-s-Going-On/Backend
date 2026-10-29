# WGO Realtime Gateway

## 게시판 실시간 계약 (2026-09-26)

`boardId`는 Post Service `postId`다. `board.join`은 Post의 내부 참여 API가
Map의 최신 위치(5분)·반경과 게시물 ACTIVE 상태를 확인하고 영속 참여를 저장한 뒤 허용한다. `post.get`, `comment.list`, `comment.create`는 해당 room에 참여한
연결에서만 실행된다. 각 명령은 `requestId`를 포함하고 성공하면
`{"type":"command.result","requestId":"...","result":...}`를 받는다.
`comment.list`의 선택적 `cursor`와 `limit`(1~100), `{comments,nextCursor}`
응답은 HTTP 조회와 같다. `comment.create`는 `content`와 재연결 후에도 유지할
`mutationId`가 필수다.

`PostCommentCreated`는 `comment.created`로 댓글 전체를 보내고 나머지 세 생성
이벤트는 `post.created`, `post.reaction.created`, `post.participant.joined`로
보낸다. 모든 이벤트에 `eventId`, `postId`, `boardId`를 포함한다. 반응·참여 후
`post.get`으로 카운터를 다시 읽는다. 재연결 후에는 다시 참여하고
`post.get`과 `comment.list`의 페이지를 읽어 누락분을 회복한다.

개발·운영 모두 User와 같은 `JWT_ACCESS_SECRET`, `JWT_ACCESS_ISSUER`, `JWT_ACCESS_AUDIENCE`로 HS256을 검증한다. 운영에서는 별도의
`WS_SERVICE_PRIVATE_JWK`(P-256 ES256 개인키, alg/kid 포함)을 설정한다.
Post에는 대응 공개키 set `POST_WS_TRUSTED_JWKS`를 설정한다.
사용자 Access JWT와 서비스 JWT 키는 분리한다. Redis Stream `post:events`의 `post-realtime`
Consumer Group을 Pub/Sub으로 모든 Gateway 인스턴스에 전파한다.
새 참여 경로는 ES256만 허용하며 키 미설정 시 상태 조회로 우회하지 않는다.

`GET /health/ready`는 활성 연결 수, Consumer Group Pending 수, 전달 실패 수를
보고한다. Outbox 대기 시간은 Post Service의 `outboxWaitMs` 로그로 확인한다.
로컬 반복 측정은 `pnpm exec tsx scripts/benchmark.ts`를 실행한다.

Fastify 기반의 WGO WebSocket 진입점이다. WebSocket 연결과 일시적인 보드 구독
상태만 소유하며, 사용자·보드·게시물의 영속 데이터와 도메인 규칙은 소유하지
않는다.

구현 기준은 저장소 상위의 `AGENTS.md`와 `ARCHITECTURE.md`다.

## 현재 범위

- `GET /ws/v1` WebSocket endpoint
- Authorization header 또는 HttpOnly cookie의 JWT 인증
- 사용자별 다중 WebSocket 연결 관리
- protocol ping/pong heartbeat
- 로컬 `boardId -> sockets` 구독 관리
- versioned join/leave command와 ACK/error envelope
- liveness/readiness endpoint

`board.join`은 `POST /internal/v1/posts/{postId}/participants`에 검증된 사용자 문맥을 전달한다.
위치 없음·만료·반경 밖·비활성 게시물은 `WS_BOARD_JOIN_FORBIDDEN`, 의존성 장애·timeout은
`WS_BOARD_AUTHORIZATION_UNAVAILABLE`이며 Room에 가입하지 않는다.
상세 진행 상태는 `IMPLEMENTATION_STATUS.md`를 참고한다.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
pnpm dev
```

기본 주소:

- HTTP health: `http://127.0.0.1:8081/health/live`
- WebSocket: `ws://127.0.0.1:8081/ws/v1`

로컬도 `.env`에 User와 같은 사용자 JWT 설정을 명시해야 한다. 키는 최소 32바이트이며 누락·잘못된 설정은 시작 시 거부한다. 운영 서비스 호출은 기존 ES256 설정을 유지한다.

## WebSocket 명령

```json
{
  "version": 1,
  "type": "board.join",
  "requestId": "client-request-id",
  "payload": {
    "boardId": "board-id"
  }
}
```

연결이 완료되면 서버가 `connection.ready`를 보낸다. 참여·퇴장 명령에는
`command.ack` 또는 `command.error`, 조회·작성 명령에는 `command.result` 또는
`command.error`로 응답한다.

## 검증 명령

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 참여·댓글 인가 및 재연결

WS 서비스 토큰은 `alg=ES256`, `typ=wgo-service+jwt`, `kid`,
`iss=wgo-ws-gateway`, `sub=ws-gateway`, `aud=wgo-post-service`, 30초 수명이다.
사용자 ID는 검증된 연결 신원에서 가져와 `X-User-Id`로 보내며 클라이언트 payload의
사용자 ID나 좌표로 대체하지 않는다. Post는 서비스 인증 후에만 문맥을 신뢰한다.

Room 한도를 먼저 확인하여 가입 불가능한 요청이 영속 참여를 남기지 않도록 한다.
인가 도중 연결이 종료되면 Room은 만들지 않는다. `board.leave`와 연결 해제는 연결별
구독만 제거하고 도메인 참여를 탈퇴시키지 않는다. 다른 기기·탭을 끊지 않기 위한 정책이다.
재연결·동일 board.join도 최신 위치를 다시 검증하며 참여자 수·이벤트는 중복 증가하지 않는다.

새 댓글은 Post에서 ACTIVE 게시물·활성 참여·최신 위치를 확인한다. 성공한
`mutationId`의 재시도는 기존 댓글을 반환하며 위치가 만료됐어도 새 쓰기는 발생하지 않는다.
가입 이후 위치 이동으로 기존 실시간 수신 권한을 즉시 회수하는 지속적 위치 감시는 이 작업의 범위가 아니다.
삭제·만료 이벤트는 종료 메시지를 전달하고 해당 Room을 해제한다. 진행 중인 참여 인가도 무효화하며 다른 Room과 소켓은 유지한다.

사용자 JWT는 User·HTTP·WS가 HS256, typ=JWT, sub/sid/iat/exp 및 같은 issuer/audience 계약을 사용한다.
sub는 양의 안전 정수 문자열, sid는 UUID이며 HTTP Gateway와 동일하게 검증한다.
Authorization이 없을 때만 JWT_COOKIE_NAME 쿠키를 사용한다. 잘못된/중복 Authorization은 쿠키로 우회하지 않는다.
JWT_SECRET/JWT_ISSUER/JWT_AUDIENCE는 새 JWT_ACCESS_* 이름으로 이전해야 한다. JWT_JWKS_URL은 사용하지 않는다.
기존 User 발급 키·issuer·audience를 유지하면 토큰 재발급은 필요 없다. 운영 키를 이번 배포에서 임의 교체하지 않는다.
사용자 secret은 User와 두 Gateway에만 주입한다. 서비스 인증 ES256·Task 보안그룹·Task Role은 별도다.
인증은 연결 시 수행한다. 연결 중 토큰 만료·즉시 로그아웃/정지 소켓 차단과 키 교체 정책은 후속 작업이다.

로컬에서는 세 서비스의 JWT_ACCESS_*를 같은 값으로 설정하고 기존 User 로그인 응답의 accessToken으로 접속한다.
Node 클라이언트는 Authorization: Bearer를, 브라우저는 허용된 Origin에서 접근 가능한 wgo_access_token 쿠키를 사용한다.
로그인 응답 자체가 이 쿠키를 자동 설정한다는 의미는 아니다. URL query 토큰은 지원하지 않는다.
실제 User 토큰 교차 검증은 두 Gateway 빌드 후 User에서 `RUN_GATEWAY_INTEGRATION=1 pnpm exec vitest run test/auth.integration.test.ts`로 실행한다.
이 테스트는 PostgreSQL·Redis가 필요하며 CI의 user-gateway 작업에서도 실행한다.


## Post 종료·삭제 실시간 계약 (2026-10-25)

| Post 이벤트 | WS type | 추가 필드 |
| --- | --- | --- |
| PostDeleted | post.deleted | postVersion, deletedAt |
| PostExpired | post.expired | postVersion, expiredAt |
| PostCommentDeleted | comment.deleted | activityVersion, comment: {postId, commentId, deletedAt} |

공통 필드는 version=1, eventId, postId, boardId, occurredAt이다. 삭제 댓글의 본문·제재 감사 정보는
전달하지 않는다. 기존 네 생성 메시지 형태는 유지하며 comment.created에는 activityVersion을 추가한다.
클라이언트는 comment.deleted를 받으면 해당 댓글을 제거하고 댓글 수·목록을 원본 API로 갱신한다.
post.deleted/post.expired 수신 시 해당 게시물 구독이 끝난 것으로 처리한다. 다른 Room과 소켓은 유지된다.
Room 해제는 영속 참여 이탈을 의미하지 않으며 가짜 PostParticipantLeft를 생성하지 않는다.

- 참여 인가 await 중 종료 이벤트가 오면 WS_BOARD_JOIN_FORBIDDEN으로 거부한다.
- Room 종료 후 대기 중인 조회·작성 명령은 WS_BOARD_NOT_JOINED로 거부한다.
  이미 Post에 전달된 쓰기는 Post가 최종 인가한다. Gateway가 커밋된 쓰기를 취소했다고 가정하지 않는다.
- Redis 사용 불가 중 명령은 WS_REALTIME_UNAVAILABLE로 거부한다.
- Pub/Sub subscriber 단절 시 기존 소켓을 1012로 닫는다. 클라이언트는 재연결 → board.join →
  post.get/comment.list로 현재 상태를 읽어야 한다. 종료된 게시물의 재참여는 Post가 거부한다.
- PUBLISH 성공은 모든 클라이언트의 수신 확인이 아니다. 소켓 전송 실패 시 연결을 끊고 위 복구 절차를 적용한다.

### 순서·중복·운영 복구

Post Stream을 서비스 공통 Consumer Group post-realtime이 읽고 post:realtime 채널로 fan-out한다.
Lua에서 리소스 버전을 비교하고 발행·처리 상태 저장을 직렬화한다. 게시물 종료 뒤 생성 이벤트,
댓글 삭제 뒤 늦은 생성 이벤트를 차단하며, 여러 Worker와 Gateway 재시작에도 순서를 보호한다.
과거 v1의 누락 버전은 Post 기존 계약대로 1로 해석한다. Moderation 이벤트 버전은 변경하지 않는다.

Redis hash `post:realtime:state:<postId>`는 WS의 **소비자 처리 상태**이며 Post 원본을 대체하지 않는다.
활성 게시물은 댓글별 버전·삭제 표식을 저장하고, 게시물 종료 시 댓글 표식을 정리한 뒤 종료 표식만 남긴다.
TTL은 두지 않는다. 운영 중 임의 삭제하면 과거 생성 이벤트를 다시 전달할 수 있으므로 삭제하지 않는다.
Redis 데이터 전체 유실·Stream 보존 범위 밖의 복구는 자동 보장하지 않는다. 이 경우 소비를 중지하고
원본 대조·보존 이벤트 재생으로 처리 상태를 복원한 뒤 클라이언트를 재연결해야 한다.
메모리 사용량과 종료 표식 보존/정리 정책은 운영 보존 정책과 함께 관리한다.

지원 이벤트의 envelope·wire 일치·버전·대상을 검증한다. 손상된 지원 이벤트는 즉시
post-realtime:dead에 보존하고 ACK하며, 비구독 유형은 ACK한다. 일시 실패는 5초 이상 Pending 이후
회수하고 5회 전달 실패 시 DLQ에 저장한다. DLQ 저장 실패는 ACK하지 않는다.
재시도·DLQ 로그는 원문·토큰 없이 streamId와 오류 분류를 기록한다. DLQ 원문 접근은 운영 권한으로 제한한다.
소비자는 Redis fan-out 발행 또는 안전한 중복·과거 이벤트 억제 후 ACK한다. 로컬 eventId 중복 캐시는 5분·최대 10,000건이며 도메인 순서 판정과 구분한다.

롤링 배포 중 구버전 Consumer는 종료 이벤트를 ACK하고 버릴 수 있다. 최초 전환은 모든 기존 WS Consumer를
중지한 뒤 새 버전을 시작하고 클라이언트를 재연결하는 순서로 진행한다. 기존 삭제/만료·댓글 삭제 이벤트가
이미 ACK됐다면 보존된 종료 이벤트를 새 Consumer로 재생해 표식을 채운 뒤 실시간 트래픽을 활성화한다.
보존 구간 밖의 누락은 Post 원본 대조가 필요하며 이 문서가 자동 복구 도구 제공을 뜻하지 않는다.

검증은 WS에서 RUN_INTEGRATION=1 pnpm test, 두 서비스 빌드 후 Post에서
RUN_INTEGRATION=1 RUN_WS_INTEGRATION=1 pnpm exec vitest run test/ws-lifecycle.integration.test.ts로 실행한다.
후자는 실제 Post 상태 변경·Outbox·Redis·WS를 사용하며 위치 인가만 fixture다.

### 프론트엔드 쿠키 및 글 갱신

User 로그인/refresh가 발급한 HttpOnly `wgo_access_token`을 브라우저 WebSocket에서 사용한다.
HTTP/WS의 도메인, `JWT_COOKIE_NAME`, 허용 Origin과 사용자 JWT 설정을 맞춘다.
`PostUpdated` 이벤트는 `post.updated` 메시지의 postId, postVersion, closedAt으로 전달한다.
종료 시 Room을 정리하고 재개 후 클라이언트가 다시 구독한다.
세부 설정과 종료·재개 정책은 [프론트엔드 연동 계약](../../docs/contracts/frontend-integration.md)을 따른다.
