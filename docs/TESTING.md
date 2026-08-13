# Testing and release gates

No finite suite proves a distributed system correct in every deployment. The
repository exercises the storage authority and transport behavior that can run
without copying DSH packages or deployment-specific compatibility fixtures.

## Repository checks

```bash
export NPM_TOKEN
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm audit --prod
```

The concrete read token belongs only in the process environment. The repository
stores a literal `${NPM_TOKEN}` placeholder and the package gate rejects `.npmrc`
from the tarball.

The tests cover:

- authority CAS, fencing, handoff, idempotent admin recovery, audit and exact event replay;
- HTTP authentication, malformed requests, explicit errors and SSE;
- schema creation, migrations and fail-loud incompatible stores;
- owner-only atomic writer credential files;
- dry-run zero-write behavior, exact import replay, response-loss recovery,
  conflicting target refusal, audited rollback and rollback-window closure;
- owner-only, atomic, no-clobber source bundles, target-secret scrubbing and
  bounded source-profile process control.
- plan-only lifecycle behavior, immutable commit pins, restart/cutover guards,
  structural verification, automatic dependency rollback, diagnostic secret
  redaction and credential preservation across uninstall.

`pnpm typecheck:adapter` strictly checks the adapter and public entry point
against exact npm next development packages: Cordis `4.0.1-rc.4`, plus DSH
Session, Session Persistence and Session Persistence JSONL `0.0.1-rc.5`.
`pnpm build` uses those real package types to regenerate declarations,
JavaScript and source maps in `dist/`; it does not use a DSH source checkout or
package snapshot. Repository installs use committed build output and deliberately
run no install-time build script. A source change without matching `dist/`
output is a release failure.

## Real PostgreSQL recovery checks

Against a dedicated disposable database:

```bash
POSTGRES_TEST_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE \
  pnpm test:postgres
```

These cases use independent connection pools to verify that competing admin
recoveries serialize to one writer and concurrent retries of one request
converge to one epoch and one audit record. They also race import rollback with
the first post-cutover append; exactly one operation may advance.

## Real DSH loader check

Point the opt-in test at the built CLI from a compatible DSH installation:

```bash
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/dsh/bin.js \
  pnpm vitest run tests/dsh-capture.integration.spec.ts
```

This boots a disposable Profile in the real DSH process, loads the temporary
absolute `file://` export overlay, executes the public `capture` CLI, verifies
the exact bundle and removes the fixture. No DSH package, fixture or snapshot is
copied into this repository.

The complete opt-in migration test also needs a disposable real PostgreSQL
database and exercises every public CLI step plus authoritative readback:

```bash
POSTGRES_TEST_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE \
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/dsh/bin.js \
  pnpm vitest run tests/migration.postgres.integration.spec.ts
```

The final release gate replaces the source fixture with DSH's real JSONL
backend, proves that physical session files were created, and checks their
exact event prefix after PostgreSQL round-trip:

```bash
POSTGRES_TEST_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE \
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/dsh/bin.js \
  pnpm vitest run tests/jsonl-migration.postgres.integration.spec.ts
```

## Real plugin lifecycle check

First validate the package tarball and DSH plugin composition. Supply a built
DSH CLI plus the exact npm next baseline package specs:

```bash
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/dsh/bin.js \
DSH_TELEPORT_TEST_SESSION_SPEC=0.0.1-rc.5 \
DSH_TELEPORT_TEST_SESSION_PERSISTENCE_SPEC=0.0.1-rc.5 \
DSH_TELEPORT_TEST_JSONL_SPEC=0.0.1-rc.5 \
DSH_TELEPORT_TEST_CORDIS_SPEC=4.0.1-rc.4 \
  pnpm test:lifecycle:local
```

This packs the current source, installs it into a disposable profile, checks
the adapter and every packaged binary, then removes it and verifies the JSONL
composition is restored.

After that, validate repository install and upgrade pins.

After the candidate branch is available in the release repository, exercise the
DSH plugin manager against two real commit pins:

```bash
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/built/dsh/bin.js \
DSH_TELEPORT_TEST_FROM_REVISION=<previous-full-sha> \
DSH_TELEPORT_TEST_TO_REVISION=<candidate-full-sha> \
  pnpm test:lifecycle:real
```

This uses a disposable `DSH_HOME`, installs the previous revision, runs offline
doctor, upgrades to the candidate, verifies the exact profile dependency and
effective config, uninstalls, and confirms local credentials survive. DSH
compatibility is supplied by npm package versions; only the Teleport plugin
itself uses repository commit pins. The test never writes the caller's normal
package-manager or Git configuration into the repository or test evidence.

If the profile cannot resolve the peer packages through its normal software
sources, supply the same four `DSH_TELEPORT_TEST_*_SPEC` variables used by the
local lifecycle check. The variables must be provided together and affect only
the disposable profile.

## Compatibility boundary

DSH packages, source trees and compatibility fixtures are intentionally not
included in this repository. Exact npm next versions provide the reproducible
compile baseline; maintainers should still validate a release with a compatible
DSH installation before updating a pinned deployment commit.

## Not yet certified

- physical multi-host or WAN partition behavior;
- TLS, reverse-proxy setup and credential rotation;
- PostgreSQL HA promotion, failover and PITR restore drills;
- sustained load, quotas, pagination and very large Sessions;
- SSE fan-out across multiple service replicas;
- cross-platform plugin lifecycle behavior.

The complete physical two-machine, TLS, network-fault, database-restart and
backup/restore procedure is maintained in
[Real-device acceptance](REAL_DEVICE_ACCEPTANCE.md). Those tests are required
for a release candidate because simulation cannot prove deployment behavior.
