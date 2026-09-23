# Realtime Gateway 구현 현황

최종 갱신: 2026-09-20

## 기준과 원칙

- 상위 `AGENTS.md`, `ARCHITECTURE.md`를 구현의 source of truth로 사용한다.
- Realtime Gateway는 WebSocket 연결과 일시적인 room 상태만 소유한다.
- 사용자와 보드에 관한 최종 인가는 해당 도메인 서비스가 수행한다.
- room 식별자는 현재 아키텍처의 보드 모델에 맞춰 `boardId`를 사용한다.
- Gateway Task의 메모리 상태는 재시작 시 유실될 수 있으며 복구 대상이 아니다.

## Milestone 1 — Gateway foundation

상태: 구현 완료

완료 항목:

- Fastify 5와 `@fastify/websocket` 프로젝트 설정
- TypeScript strict 설정 및 Vitest 설정
- `/ws/v1` WebSocket route
- JWT 서명, issuer, audience, expiration 검증
- Authorization Bearer와 cookie token 입력 지원
- WebSocket Origin allowlist
- `userId -> sockets` 다중 연결 index
- `socket -> boardIds`, `boardId -> sockets` 양방향 subscription index
- 중복 join/leave의 멱등 처리와 disconnect cleanup
- ping/pong heartbeat와 응답 없는 연결 종료
- 최대 message payload 및 소켓당 room 수 제한
- version 1 command/response envelope
- 실제 WebSocket 연결을 포함한 테스트
- liveness/readiness endpoint
- Docker build 정의와 환경변수 예제

## 의도적으로 미완료인 부분

### Board authorization

`BoardAccessAuthorizer` port는 만들었지만 Map Service의 실제 HTTP/gRPC 계약이
저장소에 아직 없다. 기본 adapter는 모든 join을 거부한다. 이를 통해 권한 확인이
없는 room 참여가 운영 코드에 묵시적으로 들어가지 않게 했다.

다음 작업은 Map Service 계약을 확정하고 timeout/deadline이 있는 adapter를
연결하는 것이다.

### Production JWT key distribution

현재 milestone은 HS256 secret 검증을 사용한다. 운영 배포 전 User Service의
token issuer 계약을 확정하고 공개키 또는 JWKS 기반 검증으로 변경해야 한다.
URL query를 통한 token 전달은 지원하지 않는다.

### Distributed fan-out

현재 room index는 한 Gateway 프로세스 안에서만 동작한다. 다음 단계에서 아래
경로를 구현한다.

```text
Domain Service -> Redis Streams -> Realtime consumer group
               -> Redis Pub/Sub -> Gateway instances
               -> local board/user sockets
```

Redis Streams는 제한된 기간 동안 도메인 이벤트를 보관한다. Realtime consumer
group은 이벤트를 한 번 처리하고 Redis Pub/Sub으로 각 Gateway instance에
전파한다. 같은 group을 공유하는 Gateway instance에 직접 WebSocket 전달을
맡기면 일부 instance의 클라이언트가 이벤트를 받지 못한다. Pub/Sub은 연결 중인
클라이언트에만 전달하며, 재연결한 클라이언트는 영속 상태를 HTTP로 다시 조회한다.

### Rate limit and backpressure

현재 payload 크기와 room 개수만 제한한다. handshake/message rate limit,
`bufferedAmount` 기반 slow-consumer 종료, 관련 metric은 후속 milestone이다.

## 다음 마일스톤

1. User Service/Map Service 인증·인가 계약 확정
2. Map Service `BoardAccessAuthorizer` adapter 구현
3. Redis publisher/subscriber 연결과 동적 board channel ref-count 구현
4. Redis Streams consumer group과 명시적 event routing table 구현
5. `USER`, `BOARD_ROOM`, `BROADCAST` 전달 통합 테스트
6. rate limit, backpressure, graceful draining, 운영 metric 추가

## 완료 기준 기록

각 milestone 종료 시 아래 명령 결과와 남은 제한사항을 이 문서에 갱신한다.

```bash
pnpm typecheck
pnpm test
pnpm build
```

Milestone 1 검증 결과:

- `pnpm typecheck`: 통과
- `pnpm test`: 4개 test file, 13개 test 통과
- `pnpm build`: 통과
