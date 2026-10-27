# Moderation rollout, scheduling and recovery

## Due index migration

The scheduler now polls once per second and claims at most 100 **due IDs**, not all
projection JSON. `moderation:lifecycle:due` is a sorted set. ACTIVE score is
max(createdAt+1h,lastMeaningfulActivityAt+30m); STALE is staleAt+10m. Lua creation
and CAS transition update projection, active membership, due membership and
unchanged lifecycle output together. CLOSED removes active/due membership and
compacts reactions/comment tombstones while retaining terminal identity/evidence.

Lifecycle XADD runtime failures retain the exact pendingPublication inside the
committed projection. It stays in tracked/due membership, including CLOSED, with
a 60-second retry score. Reads recover this same event ID before any new decision;
only confirmed publication removes a closed post from scheduling. A lost response
can repeat the same ID, so downstream idempotency remains required. Wrong key types
are checked before mutation. This also closes the former state-saved/output-lost
failure window. Drain these pending publications before rollback to old writers.

Claiming a batch advances scores to now+60s as recovery leases; workers with a
successful transition set the real next due time. Crashes/failures become eligible
after that lease. CAS prevents duplicate transitions if a slow worker outlives its
lease. No-change evaluations retain the lease for bounded recheck. Clocks must be
synchronized. Scheduler shutdown stops new claims and waits for in-flight work.

**Existing active projections need backfill before rollout.** A missing/partial
due index produces an explicit error/readiness failure, not a whole-table fallback.

1. Back up Redis and pause all lifecycle consumers/schedulers; preserve Post
   outbox/Stream/PEL. Do not run old and new writers together during backfill.
2. Set an explicit REDIS_URL for the intended endpoint and DB. Run
   `pnpm lifecycle:migrate-due --cursor=0` for a dry-run page.
3. Re-run that cursor with `--apply`, then pass the reported nextCursor until 0.
   Each invocation processes one SSCAN page with COUNT=100 (a Redis hint, not a
   guaranteed exact page size), sequentially compares each original projection
   before indexing it. Conflicts/missing projections fail the command; retain
   its original cursor and reconcile before moving on. It changes no policy,
   projection version or output event. Closed stale membership is removed.
4. Verify active-set/due-set identity and cardinality, deadlines and sample
   projection versions, not just command exit status. Readiness checks cardinality
   atomically; this is a useful guard, not a full membership reconciliation.
5. Deploy all new writers, verify /health/ready and a controlled lifecycle example,
   then resume input. Watch due oldest age, batch backlog and CAS conflicts.
6. Rollback only after pausing writers again and preserving projection/output
   receipts. Old writers do not maintain the due index. Rebuild before re-enabling
   the new scheduler. CLOSED is terminal; do not delete tombstones or reopen it
   as a rollback shortcut.

No live DB/index migration has been performed. The CLI's dry-run/apply and version
preservation are verified against the dedicated local Redis integration fixture.

## Content output rollout

Set MODERATION_CONTENT_EVENT_STREAM to a dedicated stream (default
moderation:content-events), provision ACLs/retention, then deploy the producer.
Do not route this stream into the existing Post lifecycle consumer. New consumers
must be separately authorized and deployed with durable idempotency and policy.
The old canonical result key remains readable; legacy completed records are not
automatically backfilled. Use the reviewed content:republish command after build
to repair/republish retained results, preserving output event IDs. See
content-moderation-events.md for exact failure and expiration behavior.

## Health and observability

/health/live is process liveness. /health/ready requires configured REDIS_URL and
OPENAI_API_KEY, an active consumer Redis connection, valid content output type,
and due/active index cardinality agreement. It checks key presence, not actual
OpenAI credential validity or remote API health. Provider health must be verified
with the authorized smoke test. Redis repository commands have 2s timeouts and
bounded queues; consumer commands have 3s timeouts (BLOCK is 1s). Connection
single-flight prevents initial/reconnect races; future polls retry failed work.

Structured logs expose service, source/output IDs, transition version/reason,
correlation, retry attempts and scan/provider duration; no content or secrets.
Collect openai_moderation_completed/failed, content_result_published/
publication_failed, moderation_event_retry/dead_lettered/ack_failed,
moderation_consumer_poll_failed, lifecycle_transition_published and scan outcomes.
Republish/repair can return an existing result rather than a newly-created-result
log; reconcile stream/receipts for exact publication inventory.

External monitoring still needs periodic XPENDING/XINFO lag/oldest idle, DLQ size,
due backlog, Redis memory/latency/capacity and dashboards/alerts. No remote
monitoring system was provisioned. DLQ replay must preserve original source IDs;
correct the cause, review output/receipts and replay owned messages. Never FLUSHDB,
delete completed receipts, or log DLQ bodies. Retention and audit/access policy
must be approved before production.

## Performance boundary

Local fixture: 270 tracked posts, 250 due; two workers claimed disjoint batches
of 100, then a batch of 50. Three bounded claims plus recovery/terminal checks
took 8–14ms locally. 2,000 reaction relations plus 2,000 comment tombstones used
298,925 bytes in one projection; final CLOSED compaction left 271 bytes, with
both lifecycle decisions taking 67–72ms locally. These are reproducible fixture
measurements, **not** a throughput SLO or distributed production load test.

Active projections still contain their full relation versions and tombstones.
Per-event JSON read/serialization and ENDED assessment remain proportional to
active history. Removing them without a replay/ordering/snapshot contract can
break reverse-delivery safety. A measured storage split/backfill/dual-version
plan and bounded active-history policy remain WGO-ARCH-08 work. Frozen ENDED
evidence can itself grow and needs approved retention; do not silently trim it.

Post-applied success/failure and late outbox completeness are not observable from
current lifecycle v1. Require Post decision-version/application feedback and a
snapshot/watermark contract before claiming globally complete lifecycle decisions.
