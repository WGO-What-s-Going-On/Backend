# Realtime Gateway 구현 현황

## 2026-09-26 게시판 실시간 기능

- Post의 내부 참여 API로 최신 위치·반경·ACTIVE 상태와 영속 참여를 확인한 뒤 room에 가입한다. `boardId=postId`다.
- `post.get`, `comment.list`, `comment.create`와 `requestId` 결과 응답을 제공한다.
- 사용자 토큰은 개발·운영 모두 User와 같은 HS256 키·issuer·audience 및 필수 claim으로 검증한다.
- 별도 단기 서비스 JWT로 Post Service 내부 조회·댓글 작성을 인증한다.
- `post-realtime` Consumer Group → Redis Pub/Sub → 각 Gateway room으로 생성 4종과 삭제·만료·댓글 삭제 3종을 전파한다. 종료 시 해당 Room과 대기 중인 join을 정리한다.
- Redis를 쓰는 두 인스턴스 전파·Pending 복구를 포함해 16개 테스트와 타입 검사·빌드를 통과했다.
- 로컬 MongoDB·Redis, Post Service, Gateway 2개 인스턴스에서 댓글 100회 전송부터 다른 인스턴스 수신까지 P95 10.98ms(최대 12.38ms)를 측정했다. 커밋 전 시간도 포함하므로 500ms 목표를 충족한다. `pnpm exec tsx scripts/benchmark.ts`로 재측정한다.

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

## 남은 범위

### Board authorization

`BoardAccessAuthorizer`는 Post의 ES256 인증 내부 참여 API를 호출한다. Post의 기존 JoinPost가 Map gRPC로 저장된 최신 위치와 반경을 검증한다. 새 댓글에도 Post가 활성 참여와 최신 위치를 검증한다.

다음 작업은 Map Service 계약을 확정하고 timeout/deadline이 있는 adapter를
연결하는 것이다.

### Production JWT key distribution

개발·운영 모두 JWT_ACCESS_SECRET/ISSUER/AUDIENCE를 명시한다. 원격 JWKS를 사용하지 않는다. 사용자 키와 서비스 ES256 키는 분리하며, 연결 중 만료/철회 처리는 후속이다. URL query token 전달은 지원하지 않는다.

### Distributed fan-out

room index는 각 Gateway 프로세스의 로컬 상태다. 다음 경로로 여러 인스턴스에
이벤트를 전파한다.

```text
Domain Service -> Redis Streams -> Realtime consumer group
               -> Redis Pub/Sub -> Gateway instances
               -> local board/user sockets
```

Redis Streams는 제한된 기간 동안 도메인 이벤트를 보관한다. Realtime consumer
group은 이벤트를 한 번 처리하고 Redis Pub/Sub으로 각 Gateway instance에
전파한다. 같은 group을 공유하는 Gateway instance에 직접 WebSocket 전달을
맡기면 일부 instance의 클라이언트가 이벤트를 받지 못한다. Pub/Sub은 연결 중인
클라이언트에만 전달하며, 재연결한 클라이언트는 WebSocket 명령으로 영속 상태를 다시 조회한다.

### Rate limit and backpressure

현재 payload 크기와 room 개수만 제한한다. handshake/message rate limit,
`bufferedAmount` 기반 slow-consumer 종료, 관련 metric은 후속 milestone이다.

## 다음 마일스톤

1. 운영 사용자 JWT 발급·검증 알고리즘 통일 및 배포 환경 키 주입
2. handshake/message rate limit, backpressure, graceful draining
3. 운영 알림과 지연 분포 모니터링

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


### 2026-10-25 Lifecycle 전달

PostDeleted/PostExpired/PostCommentDeleted를 추가했다. 순서·중복 방어는 Redis 소비자 처리 상태,
연결 단절 복구는 1012 재연결과 원본 재조회로 처리한다. 기존 사용자 JWT 계약은 유지한다.
세부 메시지·복구·혼합 버전 배포 제한은 README의 Post 종료·삭제 실시간 계약을 따른다.
