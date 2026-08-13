# Multiwriter strategy: branch, do not interleave

The current product has one writer per Session and does not implement this
proposal. The safest future multiwriter model is not a CRDT that interleaves
conversation events. It is an explicit, Git-like branch model.

## Why automatic event weaving is wrong

Two devices can independently observe the same head and then produce different
assistant replies, tool calls and external side effects. Although event order
can be made deterministic, the resulting transcript may be semantically
impossible: a tool result can precede its call, two purchases can both occur,
or one branch can answer context that never existed on the other. Storage-level
convergence is not Session-level correctness.

## Proposed protocol

Every offline-capable writer starts from an immutable base identity:

```text
(session incarnation, branch id, base revision, base head digest)
```

It appends to its own branch with the existing revision, sequence, idempotency
and writer-fencing rules. On reconnect:

1. If the authority head still equals the branch base, commit by a PostgreSQL
   compare-and-swap: a normal fast-forward.
2. If the authority advanced, upload the local branch as an immutable sibling.
   Never insert its events into the main branch automatically.
3. Expose both heads and their common ancestor to a resolver.
4. Resolve explicitly by selecting one branch, continuing from a new merge
   Session that references both parents, or creating a reviewed summary/rebase.
5. Keep both original branches and the merge decision in the audit history.

Tool calls are merge barriers. A resolver may quote their recorded results, but
must not replay an external side effect automatically. Conflicting tool effects
require a human decision or a tool-specific compensation protocol.

## Minimal data model

- `session_branches`: branch identity, parent head, base digest, owner and state;
- `branch_events`: immutable ordered events within one branch;
- `session_head`: one CAS-selected default branch and revision;
- `merge_decisions`: parent heads, resolver, strategy, result branch and reason.

Writer epochs remain per branch. Selecting the default branch and accepting a
merge both require head CAS, so a stale resolver cannot replace a newer choice.
Content hashes make an exact retry recognizable after a lost response.

## Merge modes

- **Fast-forward**: automatic and lossless when the base head is unchanged.
- **Choose branch**: one branch becomes default; the other stays visible.
- **Merge continuation**: create a new continuation referencing both parents;
  no historical event is rewritten.
- **Reviewed rebase**: replay only explicitly approved, side-effect-free intent
  onto the current head. This is never the default.

The MVP should implement fast-forward plus visible conflict branches only. A
semantic merge UI and tool-effect policy come later. This is materially larger
than single-writer handoff because it changes schema, API, local queues,
recovery, UX and audit rules; it should not be hidden inside the current append
endpoint.
