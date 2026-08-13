# Architecture

```text
DSH device A ─┐                         ┌─ PostgreSQL authority
DSH device B ─┼─ HTTP/SSE Teleport API ├─ encrypted snapshots (future)
observer     ─┘                         └─ cross-instance wake-up (future)
```

The DSH adapter sits above the HTTP API and delegates persistence to the
Teleport authority. Lazy session creation is materialized together with the
first event batch, so a failed first write cannot publish an empty session.

## Authority tuple

- Commit point: PostgreSQL transaction commit.
- Head condition: `expectedRevision` and `expectedNextSeq` under a locked row.
- Writer fencing: increasing `writerEpoch` plus a random token whose SHA-256
  hash is stored.
- Idempotency: session-scoped key bound to a canonical request digest and the
  committed result.
- Availability: `/health` executes `SELECT 1`; database outage returns 503 and
  the connection pool can reconnect after recovery.

## Handoff transition

```text
writer A (epoch 7)
  └─ issues an expiring one-time code
       └─ device B accepts under a row lock
            ├─ code is consumed
            ├─ session epoch becomes 8
            ├─ token is replaced
            └─ writer device becomes B
```

An append from A still carries epoch 7 or the previous token, so the data
transaction rejects it even if A was disconnected during handoff.

## Recovery transition

Admin recovery is a separate, explicit path protected by both the normal API
token and a distinct admin token. It locks the Session row, checks the
expected revision and writer epoch, increments the epoch, stores the new token
hash and appends one audit record in the same transaction. Exact request
replays return the committed result without advancing the epoch again.

## Import rollback window

An existing backend produces one consistent portable prefix. Dry-run validates
that prefix and the target without writing. Apply reuses lazy materialization,
so the complete prefix and its deterministic import mutation commit together.
The old store remains untouched.

An admin rollback locks the imported Session and requires revision `1`, writer
epoch `1`, one import mutation, and the exact imported next sequence. The first
append, handoff or recovery invalidates at least one guard. This intentionally
makes rollback a pre-write cutover escape hatch rather than reverse replication.

## Deliberate non-features in v0.2

- No automatic lease expiry; recovery requires an administrator and a reason.
- No event merge; competing writes fail with a revision conflict.
- No direct client-to-PostgreSQL access.
- No NAS-mounted live SQLite authority.
- No multi-service SSE fan-out.

## Future offline branches

An offline device could record a local segment rooted at
`{sessionId, parentRevision, parentSeq}`. On reconnect:

- matching authority head: publish normally;
- advanced authority head: create a branch manifest instead of mutating main;
- identical mutation digest: acknowledge without duplication.

Branch resolution should be semantic; raw event streams should never be
interleaved automatically.
