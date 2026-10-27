# WGO Agent Guide

## Project

What's Going On is a location-based real-time information sharing service.

Backend architecture:

- Node.js
- Microservices
- Event-driven architecture
- Redis Streams for asynchronous domain events
- gRPC/HTTP for synchronous communication
- ECS Fargate deployment

Applications:

- HTTP Gateway
- Realtime Gateway
- User Service
- Post Service
- Map Service
- Notification Service
- Moderation Service

See `ARCHITECTURE.md` for system architecture.

---

## Core Principles

### Think Before Coding

Before implementing:

1. Inspect existing code.
2. Identify the affected service.
3. Check existing conventions.
4. Check service/data ownership.
5. Define how the change will be verified.

Do not silently invent architecture.

---

### Simplicity First

Implement the smallest solution that satisfies the requirement.

Avoid:

- speculative abstractions
- unnecessary base classes
- premature shared packages
- unnecessary CQRS/DDD patterns
- infrastructure for hypothetical scale

---

### Surgical Changes

Only modify files required by the task.

Do not:

- refactor unrelated code
- reformat unrelated modules
- rename unrelated files
- replace existing libraries without reason

Every changed line must be related to the requested task.

---

### Human-Readable Code Comments

Add short, plain-language comments where the intent is easy to miss from the code.
Explain **why** a rule or sequence exists, especially for domain decisions,
transaction boundaries, idempotency, retries, authentication, pagination, and
backward compatibility.

- Place comments next to the behavior they explain.
- Use the language already used in the affected service; write for the next developer reading the code.
- Describe constraints and failure cases, not what an individual statement obviously does.
- Keep comments accurate when behavior changes; remove stale comments.
- Document HTTP, gRPC, and event shapes in their contract docs or OpenAPI as well. Code comments do not replace those contracts.

Do not add comments to every line or repeat method names in prose.

---

### Goal-Driven Execution

For non-trivial tasks:

1. Define success criteria.
2. Implement.
3. Run `npm run format` from the repository root after code changes.
4. Run relevant tests.
5. Run typecheck/lint/build when applicable.
6. Verify the original behavior.

For bug fixes, reproduce the bug with a test first when practical.

---

## Architecture Rules

### Service Boundaries

Each service owns its domain and data.

Never access another service's database directly.

Use:

- gRPC/HTTP for synchronous communication
- Redis Streams for asynchronous domain events

Do not put domain business logic inside gateways.

---

## Data Ownership

- User → PostgreSQL
- Post → MongoDB
- Map → Redis GEO + Cassandra
- Notification → PostgreSQL
- Moderation → PostgreSQL

Redis GEO is a rebuildable index. Redis Streams retains events for bounded
delivery and replay, but each service's database remains the source of truth.

---

## Architecture Style

Use lightweight Hexagonal Architecture where useful.

Prefer:

presentation
→ application
→ domain

with infrastructure implementing external dependencies.

Do not create architectural layers for trivial operations.

Use DDD-lite and CQRS-lite only when they clarify real domain complexity.

---

## Shared Code

Shared packages should contain contracts or infrastructure concerns.

Good:

- contracts
- Redis Streams event schemas
- gRPC definitions
- observability
- configuration

Avoid sharing domain entities or business logic between services.

---

## Contracts

Treat HTTP APIs, gRPC definitions, and Redis Streams events as contracts.

Before changing a contract:

- find producers
- find consumers
- consider backward compatibility
- update tests
- update documentation

---

## Verification

Before finishing:

- `npm run format` has been run from the repository root after code changes; review its diff and remove unrelated formatting changes
- relevant tests pass
- typecheck passes
- lint passes
- build passes when applicable
- no unrelated files changed

Use repository-defined commands.

---

## Code Review Guidelines

### 리뷰 원칙과 범위

- 리뷰는 한국어(`ko-KR`)로 작성한다. 실제 위험을 적극적으로 찾고 근거를 명확하게 제시하는 `assertive` 기조를 유지한다.
- 변경의 목적, 영향받는 서비스, 기존 규약과 데이터 소유권을 먼저 파악한다. 변경된 코드와 관련 호출부, 생산자·소비자, 테스트, 계약 문서를 함께 확인한다.
- `services/**`, `gateways/**`의 소스와 관련 테스트·계약을 중심으로 검토한다. 루트의 `src/**`만 리뷰 대상으로 한정하지 않는다.
- 생성물, 빌드 산출물, 압축 파일, `node_modules`는 기본적으로 제외한다. `infra/**`와 설정 파일은 변경 동작, 보안, 배포 안정성에 영향을 주면 검토한다.
- 리뷰 대상으로 지정된 PR은 Draft라도 동일한 기준으로 검토한다. 이 문서 자체가 자동 리뷰 실행을 설정하지는 않는다.
- 리뷰 결과에 변경 요약과 검토 상태를 포함한다. 검토 상태는 발견사항과 검증 범위를 설명하며, 자동으로 PR의 Request Changes 워크플로를 실행하지 않는다.
- 변경으로 발생하거나 악화되는 문제에 집중한다. 기존 문제는 변경과의 연관성을 설명할 수 있을 때만 지적한다.
- 문제 없는 항목에 억지로 코멘트를 만들지 않는다. 추측은 확인된 결함과 구분하고, 단순 취향이나 가상의 확장성을 이유로 구조 변경을 요구하지 않는다.

### 리뷰 결과 정리

1. **변경 요약**: 주요 동작 변화와 영향받는 서비스·계약을 간단히 설명한다.
2. **발견사항**: `Critical > High > Medium > Low > Suggestion` 순서로 정리하고, 같은 심각도에서는 영향 범위와 발생 가능성이 큰 항목을 먼저 쓴다.
3. **검토 상태**: 차단 이슈 유무, 확인한 범위, 실행한 검증과 결과, 실행하지 못한 검증 및 남은 불확실성을 명시한다. 검증하지 않은 항목을 통과했다고 표현하지 않는다.

심각도 기준:

| 심각도 | 기준 |
| --- | --- |
| Critical | 보안 취약점, 데이터 유실·오염, 인증·권한 우회, 광범위한 운영 장애를 유발할 수 있는 문제 |
| High | 런타임 예외, 트랜잭션 불일치, 잘못된 비즈니스 결과, 심각한 성능 저하, API·이벤트 호환성 깨짐 |
| Medium | 구체적인 유지보수 위험, 핵심 테스트 누락, 경계값 오류 가능성, 불필요한 쿼리, 설계상 개선이 필요한 문제 |
| Low | 네이밍, 가독성, 작은 중복, 사소한 스타일 문제 |
| Suggestion | 즉시 수정이 필요하지 않은 장기적인 품질 개선 제안 |

- 각 이슈는 `[심각도] 제목`으로 시작하고 파일·라인, 발생 조건과 근거, 영향 범위, 수정 방향을 제시한다.
- Critical과 High는 기본적으로 병합 전 해결할 차단 이슈로 표시한다. Medium은 실제 영향에 따라 차단 여부와 이유를 설명하고, Low와 Suggestion은 참고 사항으로 구분한다.
- 같은 원인의 문제는 대표 위치와 공통 해결 방향으로 묶어 중복 코멘트를 피한다.
- 발견사항이 없으면 명시적으로 알리되, 테스트 부족이나 확인하지 못한 동작까지 안전하다고 단정하지 않는다.

### 세부 검토 항목

변경에 해당하는 항목을 적용한다. Spring/JPA 전용 패턴을 요구하지 말고 해당 서비스에서 실제 사용하는 Node.js/TypeScript 프레임워크, 드라이버와 기존 규약을 기준으로 판단한다.

1. **예외 처리**
   - 비동기 오류와 Promise rejection을 누락하거나 삼키지 않는지, 공통 오류 처리와 HTTP/gRPC 오류 매핑을 일관되게 사용하는지 확인한다.
   - 구분이 필요한 도메인 실패를 의미 있는 오류 타입·코드로 표현하는지, 오류 응답에 스택·DB 정보·개인정보가 노출되지 않는지 확인한다.
   - 실패 경로에서도 연결, 트랜잭션, 타이머 등 자원을 정리하는지 확인한다.

2. **코드 품질과 가독성**
   - 함수·클래스의 책임, 이름, 매직 넘버, 하드코딩, 중복과 불필요한 복잡성을 검토한다.
   - 공통화는 실제 중복과 책임이 맞을 때만 제안하며, 서비스별 도메인 로직을 공유 패키지로 옮기도록 요구하지 않는다.
   - 타입 단언과 `any`가 잘못된 상태를 숨기지 않는지, 의도가 불명확한 도메인 규칙에 필요한 설명이 있는지 확인한다.

3. **성능과 효율성**
   - 불필요한 쿼리, N+1, 반복 외부 호출, 무제한 조회·병렬 처리, 시간복잡도와 메모리 사용을 검토한다.
   - 동기 I/O나 CPU 연산이 이벤트 루프를 오래 막는지, 배치·스트림에 동시성 제한과 backpressure가 필요한지 확인한다.
   - 캐시는 실제 이득과 함께 TTL, 무효화, 오래된 데이터의 영향, 장애 시 동작을 검토한다.

4. **트랜잭션 관리**
   - 여러 쓰기가 지켜야 할 불변 조건, 로컬 트랜잭션 경계, 커밋·롤백과 연결 반환을 확인한다.
   - 사용하는 저장소의 트랜잭션 지원 범위를 고려하고, 네트워크 호출로 트랜잭션이 불필요하게 길어지지 않는지 확인한다.
   - DB 저장과 이벤트 발행 사이의 유실을 Outbox 등 기존 일관성 전략으로 다루는지 확인한다. 서비스 간 공유 트랜잭션을 요구하지 않는다.

5. **입력 검증과 보안**
   - body, path, query, HTTP 헤더, gRPC 메시지, WebSocket 메시지, 이벤트 등 외부 입력을 런타임에 검증하는지 확인한다. TypeScript 타입만으로 검증을 대신하지 않는다.
   - 필수값, 길이·범위, 형식, 알 수 없는 필드와 payload 크기 제한이 도메인 규칙에 맞는지 확인한다.
   - Gateway 인증과 소유 서비스의 최종 인가, 리소스 소유권, 내부 호출자 인증을 확인한다. 전달된 사용자 ID·역할을 무조건 신뢰하지 않는다.
   - JWT 검증, 세션·쿠키, CORS, 필요한 CSRF 방어와 rate limit이 실제 인증 방식과 운영 환경에 맞는지 확인한다.
   - SQL/NoSQL Injection, 명령 주입, SSRF, Path Traversal, Mass Assignment와 민감정보 노출 가능성을 검토한다.

6. **테스트**
   - 핵심 동작, 경계값, 오류, 권한 분기, 외부 의존성 실패에 대한 회귀 검증이 있는지 확인한다.
   - HTTP/gRPC/WebSocket의 입력 검증·상태·오류 계약, 데이터 접근의 조건·정렬·페이징, 트랜잭션과 이벤트의 실패 흐름을 적절한 수준에서 검증하는지 확인한다.
   - 단위 테스트는 외부 의존성을 격리하고, 실제 DB·브로커 동작이 중요한 부분은 통합 테스트로 확인한다. Mock만으로 저장소 일관성을 검증했다고 판단하지 않는다.
   - 테스트가 실행 순서, 공유 데이터, 임의 대기 시간에 의존하지 않는지 확인한다. 단순 구현 복제나 불필요한 전체 시스템 테스트를 요구하지 않는다.

7. **구조와 서비스 경계**
   - Gateway·Controller는 요청·응답과 위임에 집중하고, 도메인 규칙은 해당 데이터를 소유하는 서비스에 있는지 확인한다.
   - 애플리케이션 흐름과 데이터 접근 책임, DTO 변환, 의존 방향이 명확한지, 순환 의존성과 불필요한 주입이 없는지 확인한다.
   - 다른 서비스의 DB를 직접 조회·수정하지 않고, 동기 통신은 gRPC/HTTP, 비동기 도메인 이벤트는 Redis Streams를 사용하는지 확인한다.

8. **DDD-lite와 Hexagonal Architecture**
   - `ARCHITECTURE.md`와 해당 서비스 지침을 기준으로 검토한다. 존재하지 않는 별도 DDD 문서를 가정하지 않는다.
   - 복잡한 도메인의 상태 변경이 비즈니스 행위와 불변 조건을 드러내는지, Application Service가 유스케이스와 트랜잭션을 조율하는지 확인한다.
   - 도메인이 HTTP 객체나 DB·외부 API 구현 세부사항에 과도하게 결합되지 않는지, 도입된 포트와 어댑터의 의존 방향이 맞는지 확인한다.
   - Aggregate를 사용한다면 내부 상태 변경을 통제하는지 확인한다. 별도 Mapper, Repository Interface, Command/Query·Read Model 분리는 실제 복잡성과 조회 요구가 있을 때만 제안한다.

9. **설정과 의존성**
   - 환경별 설정, 시작 시 필수 설정 검증, 안전한 기본값과 Secret 주입을 확인한다.
   - 운영에서 debug, 개발용 인증 우회, 위험한 자동 스키마 변경이 활성화되지 않는지 확인한다.
   - 불필요하거나 충돌하는 의존성, 지원 중단 API, 패키지·lockfile 불일치와 런타임 호환성을 검토한다.

10. **데이터 접근과 저장소 특성**
    - 쿼리 조건·정렬·null 처리·인덱스·유니크 제약과 커넥션 풀 사용을 확인한다.
    - PostgreSQL의 관계·트랜잭션, MongoDB의 문서 원자성·다중 문서 쓰기, Cassandra의 파티션·조회 패턴·일관성 수준에 맞는 구현인지 검토한다.
    - 대량 조회·수정·삭제의 배치 크기와 메모리 사용을 확인한다. Redis GEO 및 검색 파생 인덱스를 원본 데이터로 취급하지 않고 재구축할 수 있는지 확인한다.

11. **API와 이벤트 계약**
    - HTTP method·URI·status, 공통 오류 형식, gRPC status와 WebSocket 메시지가 기존 계약에 맞는지 확인한다.
    - 페이지 크기 제한, 안정적인 정렬, 동률 처리와 cursor 경계가 누락·중복을 만들지 않는지, 불필요한 전체 count를 유발하지 않는지 확인한다.
    - DB 모델과 내부 필드가 응답에 새지 않는지, 생산자·소비자의 하위 호환성과 독립 배포 순서를 고려했는지 확인한다.
    - HTTP OpenAPI, gRPC 정의, 이벤트 스키마와 계약 문서·테스트가 구현과 함께 갱신되었는지 확인한다.

12. **로깅과 관측성**
    - 로그 레벨, 중복 예외 로그, 구조화 로그와 요청·Correlation·Trace ID의 경계 간 전달을 확인한다.
    - 비밀번호, 토큰, 개인정보, 비공개 본문과 불필요한 정밀 좌표가 로그·이벤트·추적 정보에 노출되지 않는지 확인한다.
    - 외부 호출, 비동기 실패, Consumer 지연·Pending·재시도 등 장애 원인을 추적할 지표와 로그가 있는지 확인한다.

13. **외부 연동과 장애 대응**
    - HTTP/gRPC/DB/브로커 호출의 timeout·deadline, 제한된 retry·backoff, 취소와 자원 정리를 확인한다.
    - 비멱등 작업의 재시도가 중복 부작용을 만들지 않는지, 오류 응답·역직렬화 실패와 부분 성공을 처리하는지 확인한다.
    - fallback이 권한 검증을 우회하거나 잘못된 성공을 반환하지 않는지, 외부 장애가 불필요하게 다른 서비스로 전파되지 않는지 확인한다.

14. **비동기 작업과 Redis Streams**
    - 비동기 작업의 오류 처리, 필요한 컨텍스트 전달과 커밋 이후 이벤트 발행을 확인한다.
    - 서비스별 Consumer Group, at-least-once 중복 처리 방어, 소유 데이터 저장 이후 `XACK`, Pending 회수, 재시도 한도와 Dead Letter 처리를 확인한다.
    - 이벤트 순서 역전, 재처리, 보존 기간·trim, Redis 장애 시 유실 가능성과 원본 기반 복구를 고려했는지 확인한다.
    - 다중 인스턴스에서 스케줄러·Worker가 중복 실행되어도 안전한지, Redis Pub/Sub을 복구가 필요한 도메인 이벤트 전달에 사용하지 않는지 확인한다.

15. **동시성과 멱등성**
    - lost update, 경쟁 조건, 중복 요청과 이벤트가 불변 조건을 깨뜨리지 않는지 확인한다.
    - 원자적 갱신, 조건부 쓰기, 버전·잠금·유니크 제약과 idempotency key가 필요한 위치에 있는지 확인한다.
    - 중복 방지 상태와 실제 부작용 사이의 실패 구간, 만료·재시도 시 동작을 검토한다. 단일 프로세스 메모리만으로 다중 인스턴스 동시성을 보호하지 않는다.

16. **위치 기반 기능과 실시간 전달**
    - 좌표 범위·순서, 거리 단위·반경 경계, 위치 최신성, 만료·삭제·비공개 상태가 검색과 참여 권한에 일관되게 반영되는지 확인한다.
    - 파생 인덱스 후보를 원본 상태와 필요한 권한으로 검증하고, 오래된 인덱스가 정보 유출이나 잘못된 참여 허용을 만들지 않는지 확인한다.
    - WebSocket 인증·Room 인가, 연결 해제 정리, 느린 클라이언트 처리, 인스턴스 간 전파와 재연결 후 상태 복구를 확인한다.

17. **마이그레이션과 운영 안정성**
    - 스키마·인덱스·제약 변경의 기존 데이터 호환성, 잠금, 실행 시간, backfill과 배포 순서를 검토한다.
    - 신·구 버전이 공존하는 배포에서 계약과 데이터를 호환하고, 실패 시 rollback 또는 복구 절차가 가능한지 확인한다.
    - ECS Fargate의 다중 인스턴스·무상태 실행, readiness/liveness, graceful shutdown 중 요청·이벤트 처리를 확인한다.
    - 위험한 변경에 필요한 단계적 전환과 feature flag를 검토하되 모든 변경에 일률적으로 요구하지 않는다.

---

## Documentation

Detailed rules live in:

- `ARCHITECTURE.md`
- `docs/architecture/`
- `docs/conventions/`
- `docs/contracts/`
- service-level `AGENTS.md`

Read the relevant document before making architectural changes.
