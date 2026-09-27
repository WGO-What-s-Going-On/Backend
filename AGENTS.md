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
3. Run relevant tests.
4. Run typecheck/lint/build when applicable.
5. Verify the original behavior.

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

- relevant tests pass
- typecheck passes
- lint passes
- build passes when applicable
- no unrelated files changed

Use repository-defined commands.

---

## Documentation

Detailed rules live in:

- `ARCHITECTURE.md`
- `docs/architecture/`
- `docs/conventions/`
- `docs/contracts/`
- service-level `AGENTS.md`

Read the relevant document before making architectural changes.
