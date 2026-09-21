# WGO Realtime Gateway

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

Map Service 참여 권한 adapter가 아직 연결되지 않았으므로 기본 실행 상태에서는
`board.join`이 거부된다. Kafka와 Redis Pub/Sub fan-out도 다음 마일스톤 범위다.
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

개발 기본 JWT secret은 로컬 부팅 편의를 위한 값이다. 운영 환경에서는
`JWT_SECRET`을 반드시 주입해야 하며, User Service 인증 계약이 확정되면
비대칭 키/JWKS 검증으로 교체한다.

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

지원하는 현재 명령은 `board.join`, `board.leave`다. 연결이 완료되면 서버가
`connection.ready`를 보내고, 명령에는 `command.ack` 또는 `command.error`로
응답한다.

## 검증 명령

```bash
pnpm typecheck
pnpm test
pnpm build
```
