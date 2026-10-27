# Content moderation evaluation events v1

## Responsibility and input

Moderation evaluates content; it does not determine or execute sanctions. Input is
Post's `post:events` `PostCommentCreated` v1 flat envelope, transmitted as Redis
fields `eventId`, `eventType`, `data`. Existing schema/producer/identifier/time,
comment author/content and activity-version validation applies. No Post DB access,
automatic deletion, credit deduction, account suspension or direct push occurs.

`PostCreated` currently contains no body. The authorized internal Post detail API
admits ws-gateway, not moderation-service. Post-body evaluation is **unimplemented**
pending a content/reference/version and authorized access contract. No fake content
or contentVersion is constructed. activityVersion is a relationship/deletion fence,
not an editable content version. It must not authorize applying a sanction.

## Output

Stream: `moderation:content-events` (override MODERATION_CONTENT_EVENT_STREAM).
Event type: `CONTENT_MODERATION_EVALUATED`. Schema: 1. This stream must differ
from both input and lifecycle output. `moderation:events` remains exclusively the
unchanged BOARD_STALE/BOARD_REACTIVATED/BOARD_CLOSED v1 wire consumed by Post.

Output Redis fields are `eventId`, `eventType`, `data`. data is a flat JSON object:

```json
{
  "eventId": "evt_content_<sha256-of-source-event-id>",
  "eventType": "CONTENT_MODERATION_EVALUATED",
  "schemaVersion": 1,
  "producer": "moderation-service",
  "correlationId": "request-42",
  "occurredAt": "2026-10-27T04:00:00.000Z",
  "sourceEventId": "evt_00000000-0000-4000-8000-000000000001",
  "targetType": "COMMENT",
  "postId": "post_00000000-0000-4000-8000-000000000002",
  "commentId": "comment_00000000-0000-4000-8000-000000000003",
  "flagged": false,
  "categories": { "violence": false },
  "categoryScores": { "violence": 0.01 },
  "model": "omni-moderation-latest",
  "evaluatedAt": "2026-10-27T04:00:00.000Z",
  "authorId": 42,
  "activityVersion": 1
}
```

All fields except authorId and activityVersion are required. IDs and correlation
are nonempty strings; targetType is COMMENT. Author is the validated numeric Post
comment author. Version defaults to 1 for legacy v1 create messages. Newly processed
input retains its source correlation. A repaired legacy result without correlation
uses sourceEventId, explicitly an unavailable-original-correlation fallback.
occurredAt/evaluatedAt use the canonical result completion timestamp; replay does
not replace them with the current time. The SDK validates boolean flagged/category
values, matching category/score keys, finite scores in [0,1], and nonempty model.
Both flagged=true and flagged=false are successful evaluations. API errors,
timeouts and malformed responses produce no normal evaluation event.

There is no raw content, API key, coordinates or sourceHash in output. Categories
are model-defined and may be additive. Scores are model signals, not calibrated
sanction probabilities. Consumers must not equate flagged with a policy decision.
Consumers need their own approved policy/version, target content-version checks,
authority and applied/rejected feedback contract before taking action.

## Persistence, atomicity and immutable identity

`moderation:content:{sourceEventId}` retains the canonical result and prepared
publication for 30 days, consistent with existing result retention. Internal
sourceHash detects conflicting replay content without storing its body. The
compact `moderation:content-published:{sourceEventId}` receipt has no TTL, preventing
re-evaluation after the result expires. Receipt retention must be included in the
approved replay/audit/data-retention policy; it is not a full permanent audit DB.

A single Redis Lua operation validates result/receipt/stream key types, selects
the existing canonical result (first writer wins), persists it, XADDs the prepared
output, and records publication. Consumers only complete/ACK after this succeeds.
Lua isolation does **not** roll back runtime failures. XADD failure after SET leaves
the immutable prepared result for retry; the request fails. No saved-but-unpublished
result is counted as completed. A later attempt reuses it and avoids OpenAI.
If XADD succeeds but the receipt/response is lost, replay can emit the same event ID
again. Delivery is at-least-once. Output IDs are `evt_content_` plus the lowercase
SHA-256 of the sourceEventId. Stream IDs are transport cursors, not event identity.

Two workers may call OpenAI before either stores a result; only the canonical
stored result is published. Redis failure before any result is saved can require
another provider call. Exactly-once provider invocation is not promised.
Stored result fields/output IDs remain unchanged on duplicate input or explicit
republish. Legacy stored results lacking publication metadata can be repaired
without new evaluation. Existing completed consumer markers may bypass processing;
run reviewed backfill/republish for those, rather than deleting inbox markers.

After result expiration, a surviving receipt rejects automatic re-evaluation;
retain the original output/archive for recovery or approve a separate new
evaluation request/version. Do not reuse a source ID for changed content/model
policy. No output event should be silently replaced by a fresh model answer.

## Consumer groups and recovery

Each consuming service owns a separate group (for example post-content-review).
Replicas within that service share its group and use unique consumer names.
Persist an eventId receipt atomically with owned effects before XACK. Reclaim PEL
with XAUTOCLAIM, preserve its cursor, apply bounded retries and persist a DLQ before
acknowledging poison messages. Transport ACK is neither user read nor sanction
application success. Consumers must support duplicate and out-of-order results.

Moderation input group remains post-moderation: maximum 20 new/reclaimed entries,
30-second pending idle/owner lease, renewed every ten seconds, five failed
deliveries before moderation:post:dead. ACK failures after successful handling stay
pending and are not reclassified as provider failure. Shutdown waits for in-flight
processing. DLQ holds source payload for diagnosis; restrict access because it can
contain comments. Raw payload, provider errors and keys are not logged.

After restoring Redis/provider availability, drain PEL. If failed input has a saved
prepared result, replay original source ID to finish publication. For already
published results missing from retained output, build and run
`REDIS_URL=... pnpm content:republish <sourceEventId>` from the service directory.
This explicitly emits another transport message with the original data/event ID.
It does not call OpenAI. Missing/expired results require reviewed recovery.

## Redis deployment constraints

This implementation requires **one Redis primary endpoint/DB** for result, receipt,
output and input dedup. Its multiple untagged keys are not Redis Cluster compatible;
adopt coordinated hash-tag/partition migration before Cluster deployment. Never
mistake producer strings for authentication: use service-specific Redis ACLs, TLS,
private networking and least-privilege stream writes.

Configure and validate AOF, fsync, replicas, backups, noeviction/capacity and failover
against the required RPO. Lua is not disk durability or cross-Redis atomicity.
Tests cover a checkpointed SAVE/restart, not power-loss/AOF/failover guarantees.
Choose Stream retention longer than the slowest required consumer recovery window;
monitor pending/lag/oldest idle and archive before trimming required history.
Do not automatically approximate-MAXLEN trim unacknowledged messages.
Monitor permanent receipt growth and restricted result/audit storage. Approved
retention/purge and archive recovery remain deployment work.

Compatibility: additions may be optional under schemaVersion 1. Removal, type or
semantic changes require a new schema version and migration. Never put content
evaluation events in lifecycle output; the existing Post lifecycle consumer ACKs
unrecognized event types and does not implement content review.
