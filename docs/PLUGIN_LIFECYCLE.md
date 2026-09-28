# Plugin lifecycle

Teleport is a persistence authority. Installing its bundle is fail-safe and
leaves JSONL authoritative by default; enabling or removing an active Teleport
backend is a controlled cutover, not a hot reload. Only the affected DSH profile
must stop; the PostgreSQL service and unrelated profiles can remain online.

The lifecycle CLI is intentionally dependency-free and accepts only a full
40-character commit SHA for repository installs. Mutation commands are plans by
default. They require `--apply` plus explicit safety acknowledgements before
they call the official `dsh plugin` command.

The adapter has required peer dependencies on matching DSH Session, Session
Persistence and Cordis packages. Configure the target DSH installation to
resolve those peers through its supported software sources before install. The
lifecycle tool does not create or persist package-manager configuration. The
current npm next validation baseline is Cordis `4.0.4` and DSH Session,
Session Persistence and Session Persistence JSONL `0.2.0-rc.1`.

## Bootstrap

For the first install, run the CLI from a local checkout:

```bash
git clone https://github.com/omdsh-dev/session-teleport.git
cd session-teleport
git checkout <full-commit-sha>
node dist/plugin-cli.js install --profile web --revision <full-commit-sha>
```

The first invocation prints a plan and changes nothing. After the target
Teleport service is healthy, existing Sessions are imported or the profile is
known to be new, finish the current turn, flush, stop that profile, and apply:

```bash
node dist/plugin-cli.js install \
  --profile web \
  --revision <full-commit-sha> \
  --apply --profile-stopped --cutover-safe
```

`--cutover-safe` is an operator assertion: it means an old Session will not be
silently resumed against the new authority without the documented import and
cutover checks. It is still required for install because the target service
manager may already provide `DSH_TELEPORT_ENABLE=1`; the lifecycle process does
not assume or rewrite that external environment.

## Doctor and restart

Before enabling Teleport, start the service, export the same adapter variables
that the profile will receive (including `DSH_TELEPORT_ENABLE=1`), then run:

```bash
$DSH_HOME/profiles/web/node_modules/.bin/dsh-teleport-plugin doctor --profile web
```

Doctor checks the Node and DSH runtime, immutable dependency pin, final bundle
order, effective persistence rows, selected cutover mode, credential-directory
permissions, explicit device identity, token presence, and `/health`. It never
prints token values. Service health is informationally skipped while JSONL is
still authoritative, but becomes a hard failure when `DSH_TELEPORT_ENABLE=1`.
Use `--offline` only for package/config verification; an online doctor is
required before enabling or resuming Teleport. `--json` produces evidence
suitable for a redacted test bundle.

## Upgrade

Use the target revision's local checkout so the lifecycle process is outside the
profile it replaces:

```bash
git fetch origin
git checkout <new-full-commit-sha>
node dist/plugin-cli.js upgrade --profile web --revision <new-full-commit-sha>
node dist/plugin-cli.js upgrade \
  --profile web \
  --revision <new-full-commit-sha> \
  --apply --profile-stopped
```

The apply step verifies the installed pin, bundle order and composed authority.
If that structural verification fails, it re-adds the previous exact dependency
before returning an error. Runtime smoke tests happen after restart; if they
fail, stop the profile and upgrade back to the previous SHA.

Schema compatibility remains the service's responsibility. A database backup and
restore drill is required before any release that changes the schema; the plugin
lifecycle command never rolls back PostgreSQL migrations.

## Uninstall

Uninstall does not export Session history. Before applying it, either complete
an explicit reverse migration or confirm that no Teleport Session ID will be
continued through the fallback backend:

```bash
node dist/plugin-cli.js uninstall --profile web
node dist/plugin-cli.js uninstall \
  --profile web \
  --apply --profile-stopped --cutover-safe
```

It removes the profile dependency and bundle only. It deliberately preserves:

- PostgreSQL tables and events;
- `$DSH_HOME/session-teleport/writers` credentials;
- import receipts and audit history.

Keeping those files makes a failed cutover recoverable. Delete them only in a
separate, reviewed data-retention procedure.

## Failure and concurrency behavior

Only one lifecycle mutation may run for a profile at a time. A local owner-only
lock prevents concurrent mutation and is removed on clean exit. Child-process
diagnostics redact inherited token, password, secret, credential and database
URL values. A failed plugin-manager command does not claim success; a
post-mutation verification failure triggers best-effort dependency rollback and
reports loudly if rollback also fails.
