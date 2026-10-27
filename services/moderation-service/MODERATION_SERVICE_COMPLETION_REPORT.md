# Moderation completion report — 2026-10-27

Branch: `feat/moderation-completion`. Freshly fetched `origin/dev` base:
`326b7c49ff8f4896f602ce2c79acfec3b540417f`. Created after Notification was
committed/clean. No Notification commits, merges or cherry-picks are included.
No push, PR, issue closure or production deployment was performed.

## A. Implemented

- Comment evaluation now publishes **both** flagged=true/false outcomes to
  `moderation:content-events` as CONTENT_MODERATION_EVALUATED v1. Flat output
  carries source/event IDs, schema/producer/correlation/time, COMMENT target,
  Post/comment IDs, categories/scores/model/evaluatedAt and trusted author/activity
  version when available. It carries no comment text, secrets or fabricated
  contentVersion. Existing lifecycle stream/payload remain unchanged.
- Canonical result and prepared output are selected in Redis Lua. First writer
  wins; XADD failures remain failed work, with saved results retained for repair.
  Duplicate/concurrent input, process retry and lost responses retain the same
  output event ID and canonical result. ACK failures do not become failed model
  evaluations or DLQ at the retry limit. Expired results with published receipts
  reject automatic re-evaluation. Explicit retained-result republish preserves ID.
- OpenAI adapter validates response shape and category/score values, preserves
  retryability, and logs safe durations/outcomes. Real API failures never emit a
  successful evaluation. Source hashing detects changed-content reuse of an ID.
- Consumer reclaim preserves XAUTOCLAIM cursor. Existing owner renewal, PEL,
  five-attempt DLQ, reverse activity versions and graceful processing remain.
- Scheduler claims at most 100 due IDs per second from a sorted set with 60-second
  recovery leases. Creation/CAS maintain next-evaluation times. It no longer
  SMEMBERS/MGETs every projection. Shutdown waits for in-flight batches.
- Lifecycle runtime XADD failure now retains pendingPublication in the committed
  projection, keeps recovery membership (including CLOSED), and recovers the same
  event before a later decision. This addresses an actual state-saved/output-lost
  failure path. Wrong types are preflighted before mutation.
- CLOSED compacts reaction/comment histories while retaining terminal identity,
  version, reason and frozen ENDED evidence. Late activity cannot reopen it.
  Existing first hour/30-minute inactivity/10-minute grace and ENDED fixed-window
  5-user/70% thresholds and reactivation/cancellation rules are preserved.
- Repository connect single-flight resolves concurrent reconnect races;
  timeouts/queue bounds, readiness and sanitized operational logs were added.
- Added paginated dry-run/apply due-index maintenance and explicit content
  republish CLIs; scripts are included in the runtime Docker image.

Code: src/content-moderation/{content-event,comment-moderation.service,
moderation-result,redis-moderation-result.repository,openai-moderation.adapter}.ts;
src/event-consumer/{post-event.consumer,moderation-post-event.processor,
readiness.controller}.ts; src/lifecycle/{lifecycle,redis-lifecycle.repository,
lifecycle.service,lifecycle.scheduler,lifecycle.repository}.ts; module/config
wiring, scripts, tests, Dockerfile/package/.env and contracts/README/architecture.
Exact inventory: `git diff --name-only 326b7c4..feat/moderation-completion`.

## Data consistency and recovery boundary

Redis Lua provides isolated execution, not rollback of runtime errors or disk
durability. Prepared results/events survive expected XADD failures; real maximal
Stream-ID failure is tested, not just a mocked command. Network/receipt loss can
repeat transport output with the same event ID. Downstream consumers need durable
idempotency. Failure before a result is saved can repeat an OpenAI request.
The system does not claim exactly-once external invocation or zero-loss failover.
Use one Redis endpoint, noeviction/capacity protection, approved AOF/fsync,
replication/backups and retention. Untagged multi-key Lua is not Cluster-ready.
Details and JSON examples: [content contract](contracts/content-moderation-events.md).

## B. Remaining internal work

| Priority | Work / reason | Completion condition |
| --- | --- | --- |
| P0 rollout | Backfill existing due index, validate Redis durability/ACL/TLS and retention | Reviewed backup/migration, index membership, restore/failover/rollback drill |
| P1 | Active single-JSON relation growth remains; unsafe to discard versions blindly | Measured split-storage/backfill/compatibility design, replay tests and bounded retention |
| P1 | Operational content/result receipt archive, purge and legacy backfill tooling/policy | Approved replay/audit retention, archived recovery and controlled inventory |
| P1 | Exporter/alerts/dashboards beyond structured logs | Periodic PEL/lag/oldest idle/DLQ/due-age and Redis/provider metrics with alerts |
| P1 | Post body review adapter | Authorized content/reference/version input and real integration test |
| P1 | Policy/case workflow after AI evaluation | Named decision owner, approved policy/version and target CAS/application feedback |
| P2 | Production load/chaos and AOF/failover validation | SLO/RPO-backed tests; local fixture measurements are insufficient |

## C. External service requests

| Owner | Required contract | Reason |
| --- | --- | --- |
| Post | PostCreated content/version/hash, authorized moderation detail access, or a dedicated review-request event; edited/deleted state and source/correlation ID | Existing PostCreated has no body; ws-gateway permission cannot be reused |
| Post | Versioned lifecycle decisions and Post applied/rejected feedback, source ID, postVersion, appliedAt, reason/deadline | Current v1 accepts CLOSED→EXPIRED but cannot prove latest-activity completeness or application success |
| Post | Cross-kind reaction transition version/snapshot or outbox watermark/order bound | Relationship versions cannot reveal missing delayed cancellation; CLOSED remains terminal |
| Post + decision owner | Policy-backed sanction command/event, contentVersion CAS and immutable decision ID, application feedback | AI flagged alone does not authorize deleting content |
| User | Separate approved decision consumer/policy for credit/account actions | Evaluation output is not a credit/suspension command |
| Notification | Post-applied closure plus recipient/consent/decision-time contract | Moderation must not send Push or infer recipients |
| WS/Map | Consume actual Post terminal events and agree any additional status propagation | They own visibility/connection state; Moderation does not control sockets/index DBs |
| Platform | Single Redis topology/ACL/TLS, AOF/replication/retention, migration and monitoring | Lua success alone is not operational durability |

Current dev already contains WS terminal Post-event handling (2026-10-25), so its
earlier “only four events” gap is superseded. Notification completion remains a
separate PR with its own Gateway/auth/index rollout; this branch does not depend
on its code. Neither branch implements automatic cross-service sanctions.

## D. Policy decisions

AI result/audit/receipt and DLQ retention, privacy access/purge, decision ownership
and manual/automatic escalation, final sanctions and appeals, content-version
matching, and production SLO/RPO. Notification consent/nearby frequency/close and
growth eligibility remain separate team decisions; no fixture policy is enabled.

## E. Verification and readiness

Environment: Node 24.22.1, real isolated Redis DB15 on local service compose.
Tests refuse nonempty DBs and delete only owned keys. No FLUSH command is used.

| Check | Result |
| --- | --- |
| Unit/adapter/consumer/scheduler/health | 50 passed |
| Regular real Redis integration | 50 passed, opt-in restart excluded from ordinary run |
| Explicit checkpointed Redis restart | 1 passed: SAVE/restart/projection/dedup/PEL recovery |
| Actual Post consumer parser | Real lifecycle Stream messages accepted; content output remains separate |
| Failure cases | Provider outage, malformed response, wrong key type, real XADD runtime failure, saved result recovery, response loss, workers, ACK, PEL, DLQ and shutdown |
| Migration CLI | Local dry-run/apply preserves projection versions; missing index is explicit failure |
| Typecheck/build | Passed |
| Docker | Frozen-lockfile build and production liveness/readiness smoke validated |
| Formatting | Root npm run format executed; unrelated formatting restored; repository PR-diff formatter run in Linux |
| Real OpenAI | Passed after user supplied the local key: three live requests, safe=false, threat=true, actual comment → Redis result → evaluation Stream → lifecycle → ACK |
| Missing OpenAI key | No remote SDK client/request is constructed; explicit configuration error, no successful evaluation |
| Post MongoDB application / production E2E | Not run; parser compatibility does not prove cloud/application completion |

Performance fixture: 270 tracked/250 due, hard batch 100, disjoint worker claims;
claims/recovery checks took 8–14ms locally. A 2,000-reaction + 2,000-comment
projection compacted from **298,925 to 271 bytes** at CLOSED; decisions took
67–72ms locally. No production throughput claim. Active-history growth and full
ENDED assessment are still proportional to history.

Operational status: content output/recovery, lifecycle CAS/leases/terminal handling,
local Redis integration and build are **complete locally**. Monitoring is
**partial** (logs/collection contract). Real OpenAI smoke is **complete**; AWS/Redis production durability,
live migration, deployment, full E2E/load/chaos and rollback drills are
**incomplete**. Post body inspection and approved cross-service decision/application
workflow remain **unimplemented** pending the listed contracts/policies.

Implementation commits: `c260741` (content evaluation output/recovery), `c2459dd` (due scheduling/lifecycle recovery).
Local .env files were subsequently created from examples with secret fields empty; validation above used isolated explicitly supplied test endpoints.
The user then populated the Moderation key locally. It was loaded only for the authorized live smoke test and was neither printed nor committed. Live model: omni-moderation-latest; observed request durations approximately 1.34–1.63 seconds (three requests). Unit health tests explicitly clear runtime Redis/key settings to avoid loading real consumers from local .env files.

Local integration: Post and Notification .env files now use redis://localhost:6383, matching Moderation. Post's existing lifecycle-consumer opt-in remains unchanged. The source stream had zero entries before starting the real Moderation process. FCM credentials and Notification trusted Gateway JWKS are still absent; live device push and client HTTP integration are not complete.
