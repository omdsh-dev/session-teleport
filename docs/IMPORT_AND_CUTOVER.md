# Import and reversible cutover

This workflow moves an existing Session without dual writes or event merging.
The old backend remains untouched and is the rollback authority until the first
new Teleport write.

## 1. Produce a portable snapshot

Let the active turn finish and flush, then stop the source profile. Capture the
final consistent snapshot with:

```bash
dsh-teleport-import capture <source-profile> <session-id> \
  session-id.session-import.json
```

The command boots that profile once with a temporary absolute `file://`
overlay. The overlay injects the profile's existing `sessionPersistence`, calls
`inspect(sessionId)` and writes into an owner-only staging directory. The
parent validates the digest and shape, then atomically publishes the requested
mode `0600` no-clobber file and requests normal DSH shutdown. A failed source
boot therefore does not leave a final bundle. It never edits the
profile patch, activates the Teleport backend there, or writes to the source
backend. Target database, Teleport admin and package-manager credential
environment variables are removed from the source child.

For embedding or specialized orchestration, the same consistent seam remains
available programmatically:

```ts
import { exportSessionImportBundle } from "@mattheliu/session-teleport/importer";

const bundle = await exportSessionImportBundle(sourcePersistence, sessionId);
```

The document contains the complete
Session history and may contain prompts, tool results and credentials emitted
by tools. Never commit it, upload it to an issue, or retain it longer than the
migration requires. The repository ignores `*.session-import.json`.

Capture refuses to overwrite an existing path. The importer rejects empty,
partial or non-contiguous prefixes. It preserves
every event object and unknown extension field rather than filtering or
renumbering them.

## 2. Dry-run

Keep the old profile active while preparing the bundle, but stop new writes
before the final snapshot. Then run:

```bash
dsh-teleport-import dry-run session-id.session-import.json
```

The command validates the file and reads the target. It does not create a
Session, writer credential or rollback receipt. `targetStatus` is:

- `ready`: the Session id is absent and can be imported;
- `already-present`: exact content already exists; apply is allowed only when
  this device has retry material from its own earlier import;
- `conflict`: the id exists with different content and will never be overwritten.

Record the reported digest, event count, next sequence and byte size. The
service accepts 4 MiB request bodies by default. For a larger reviewed import,
raise `TELEPORT_MAX_BODY_BYTES` on the service explicitly; this version keeps
the all-or-nothing one-request transaction and does not stage chunked imports.

## 3. Apply and switch

With the old writer stopped and flushed:

```bash
dsh-teleport-import apply session-id.session-import.json
```

Apply saves retry credentials before making the request, materializes the
header and complete event prefix in one PostgreSQL transaction, reads the
target back, and stores an owner-only rollback receipt. A lost HTTP response is
safe to retry with the same command.

Only after apply verifies exact content should the profile be switched to the
pinned Teleport plugin commit. Installation still uses the controlled restart
procedure in [DSH integration](DSH_INTEGRATION.md); it is not a hot replacement
of an active writer.

## 4. Roll back a failed cutover

If the new profile fails its read-only smoke check, stop it before it appends,
hands off, or recovers the writer. Restore the old profile configuration, then
remove the unchanged imported target:

```bash
dsh-teleport-import rollback <session-id> "cutover smoke check failed"
```

Rollback requires `DSH_TELEPORT_ADMIN_TOKEN`. PostgreSQL locks the Session and
checks the receipt, import mutation, revision, next sequence and writer epoch
before deletion. The action is audited and idempotent. On success, local
Teleport writer credentials and the receipt are removed; the old backend was
never changed.

Rollback deliberately fails with `IMPORT_NOT_ROLLBACKABLE` after any Teleport
append, accepted handoff or writer recovery. At that point the old backend is a
stale prefix, so silently switching back would lose history. Recovery then
requires a deliberate export/migration operation, not this lightweight path.
