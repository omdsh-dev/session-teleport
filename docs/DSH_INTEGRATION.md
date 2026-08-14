# DSH integration

## 1. Run the authority service

The Teleport service and the DSH adapter run separately. DSH clients call the
HTTP API and never receive database credentials.

```bash
export NPM_TOKEN
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

export DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
export TELEPORT_HOST=127.0.0.1
export TELEPORT_PORT=43127
export TELEPORT_API_TOKEN=a-long-random-service-token
export TELEPORT_ADMIN_TOKEN=a-different-long-admin-token
pnpm start
```

For cross-machine access, use TLS at a reverse proxy or VPN boundary. The CLI
rejects a non-loopback bind when `TELEPORT_API_TOKEN` is missing.

## 2. Install into a profile

Bootstrap from a local checkout and preview the pinned install:

```bash
git checkout <full-commit-sha>
node dist/plugin-cli.js install --profile web --revision <full-commit-sha>
```

After the profile is stopped and its backend cutover is safe, apply it:

```bash
node dist/plugin-cli.js install --profile web --revision <full-commit-sha> \
  --apply --profile-stopped --cutover-safe
```

The package commits `dist/` and has no install-time build lifecycle, so a Git
install does not need to execute repository build scripts. Installation alone
is fail-safe: the bundle leaves the base JSONL authority enabled and inserts a
disabled Teleport adapter after the base bundles.

The published-package compatibility baseline is Cordis `4.0.1-rc.4` with DSH
Session, Session Persistence and Session Persistence JSONL `0.1.0-rc.6`.
Development checks compile against those exact npm next packages; no DSH source
checkout or generated package snapshot is used by the adapter typecheck.

Set these values on every device that runs the profile:

```bash
export DSH_TELEPORT_ENABLE=1
export DSH_TELEPORT_URL=https://teleport.example.com
export DSH_TELEPORT_API_TOKEN=a-long-random-service-token
export DSH_TELEPORT_DEVICE_ID=office-mac
export DSH_TELEPORT_HEALTH_TIMEOUT_MS=5000
```

Start the Teleport service and verify `/health` before enabling the adapter.
Only `DSH_TELEPORT_ENABLE=1` disables JSONL and activates Teleport. If the
service is then unreachable, profile startup fails closed instead of silently
falling back to a different authority.

Writer credentials live under `$DSH_HOME/session-teleport/writers`. Filenames
are SHA-256 identifiers and files use mode 0600. This is OS file-permission
protection, not hardware-backed or Keychain encryption.

### Restart boundary

Plugin installation changes the selected profile's dependency and bundle
configuration. Before adding, updating or removing the plugin:

1. Let the active turn finish and flush its writes.
2. Stop the affected profile/context.
3. Run the plugin command and inspect the resulting config if desired.
4. Verify the Teleport service `/health`, set or clear
   `DSH_TELEPORT_ENABLE=1` for the intended authority, then start the profile.

This is a controlled profile restart, not a live replacement of an active
writer. Other profiles and the PostgreSQL service do not need to stop.
Upgrade and uninstall use the same plan-first workflow and preserve database
and writer-credential data. See [Plugin lifecycle](PLUGIN_LIFECYCLE.md).

## 3. Hand off a Session

On the current writer device:

```bash
pnpm device create-handoff <session-id>
```

Move only the one-time code to the new device. Configure a distinct device ID,
then run:

```bash
pnpm device accept-handoff <one-time-code>
```

Acceptance increments `writer_epoch`, creates a new random writer token and
saves it locally. New appends from the previous device are rejected by the
same transaction that would write events.

## 4. Recover a lost writer

Recovery is disabled unless the service has a distinct `TELEPORT_ADMIN_TOKEN`.
On the replacement device, use the same value as `DSH_TELEPORT_ADMIN_TOKEN`,
set an operator identity, and provide a reason:

```bash
export DSH_TELEPORT_ADMIN_TOKEN=a-different-long-admin-token
export DSH_TELEPORT_ADMIN_ACTOR=operator-name
dsh-teleport-admin recover-writer <session-id> "lost device"
dsh-teleport-admin writer-audit <session-id>
```

The service checks the observed revision and writer epoch under a row lock,
increments the epoch, stores only the new token hash, and records the writer
transition. Replaying the same recovery request is idempotent. Recovery is a
manual emergency action; it never runs on a timer.

## 5. Import and reversible cutover

Use the portable migration CLI before replacing an existing backend. `capture`
reads through the old Profile's persistence seam without changing it, dry-run
is read-only, apply is one transaction, and rollback is allowed only before the
imported Teleport Session advances. See
[Import and reversible cutover](IMPORT_AND_CUTOVER.md).

## 6. Boundaries

- Single-writer handoff; no automatic multiwriter merge.
- Explicit portable snapshot import; no physical JSONL/SQLite parser or dual write.
- Explicit audited admin recovery is available; there is no automatic lease expiry.
- No production certification yet for WAN partitions, PostgreSQL failover or
  multi-instance SSE delivery.
- The list endpoint is not paginated yet.
- Physical two-machine acceptance is specified in
  [Real-device acceptance](REAL_DEVICE_ACCEPTANCE.md).
