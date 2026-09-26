# WGO Realtime Gateway

## 게시판 실시간 계약 (2026-09-26)

`boardId`는 Post Service `postId`다. `board.join`은 내부 상태 조회에서 ACTIVE일 때
허용한다. `post.get`, `comment.list`, `comment.create`는 해당 room에 참여한
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
`WS_SERVICE_JWT_SECRET`이 필수다. Post Service에도 같은 서비스 JWT secret,
issuer, audience를 설정한다. Redis Stream `post:events`의 `post-realtime`
Consumer Group을 Pub/Sub으로 모든 Gateway 인스턴스에 전파한다. 위치 기반
참여 제한은 후속 계약이다.

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

기본 `board.join`은 Post Service의 ACTIVE 상태로 허가한다. Map Service의
위치 기반 허가 계약은 후속 작업이다.
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
