# WGO Agent Guide

## Project

What's Going On is a location-based real-time information sharing service.

Backend architecture:

- Node.js
- Microservices
- Event-driven architecture
- Kafka for asynchronous events
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
- Kafka for asynchronous domain events

Do not put domain business logic inside gateways.

---

## Data Ownership

- User → PostgreSQL
- Post → MongoDB
- Map → Redis GEO + Cassandra
- Notification → PostgreSQL
- Moderation → PostgreSQL

Redis is not a persistent source of truth.

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
- Kafka event schemas
- gRPC definitions
- observability
- configuration

Avoid sharing domain entities or business logic between services.

---

## Contracts

Treat HTTP APIs, gRPC definitions, and Kafka events as contracts.

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