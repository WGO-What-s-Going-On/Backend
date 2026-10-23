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

운영에서는 `JWT_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`와 별도의
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

개발 기본 JWT secret은 로컬 부팅용이다. 운영은 issuer·audience·JWKS와
별도 서비스 JWT secret을 요구한다.

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
삭제·만료 이벤트에 따른 Room 해제는 별도 WGO-ARCH-06 작업이다.

User의 기존 HS256 사용자 Access JWT와 운영 WS JWKS 검증 불일치(WGO-ARCH-03)는
별도 작업이다. 서비스 인증 ES256 전환이 사용자 토큰 호환성을 해결하지 않는다.
