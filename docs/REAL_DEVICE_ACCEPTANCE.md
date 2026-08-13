# Real-device acceptance

Simulation and PGlite establish deterministic behavior, but they cannot certify
network, process, filesystem, TLS or PostgreSQL failover behavior. A release
candidate needs the following two-machine acceptance run.

## Test environment

- two physical machines with distinct `DSH_HOME` directories and device IDs;
- the same pinned plugin commit on both machines;
- one disposable PostgreSQL database and Teleport service, never a production
  database;
- TLS reverse proxy or an authenticated VPN between devices;
- synthetic Session content only—no production prompt, credential,
  or real user data;
- short-lived API/admin tokens supplied through environment variables, never
  committed or copied into the evidence bundle.

Record plugin SHA, DSH SHA/version, Node version, OS, PostgreSQL version, network
topology and UTC timestamps. Preserve redacted command output and doctor JSON.

## Gate 1: lifecycle

On an isolated profile, exercise plan and apply for install, online doctor,
upgrade from the prior approved SHA, online doctor again, and uninstall. Verify:

- plan mode changes no files;
- install and upgrade use exact commit pins;
- Teleport is the final bundle and JSONL is not simultaneously authoritative;
- the profile is restarted, not live-reloaded during a turn;
- uninstall restores the intended fallback composition but retains writer
  credentials and PostgreSQL data;
- a deliberately invalid target revision or broken configuration fails loudly
  and leaves/restores the previous dependency.

The repository provides an opt-in lifecycle test for commit-pinned installs:

```bash
DSH_TELEPORT_TEST_DSH_BIN=/absolute/path/to/built/dsh/bin.js \
DSH_TELEPORT_TEST_FROM_REVISION=<previous-full-sha> \
DSH_TELEPORT_TEST_TO_REVISION=<candidate-full-sha> \
pnpm test:lifecycle:real
```

## Gate 2: happy-path handoff

1. Machine A creates a synthetic Session and appends several turns.
2. Capture the authoritative event count, next sequence, revision and digest.
3. Finish and flush the active turn; A creates a one-time handoff code.
4. Machine B accepts it and continues the same Session.
5. Compare an exact readback with the expected event prefix and new events.
6. Retry the accepted code and confirm it cannot create another writer.
7. Attempt an append with A's old credential and require `WRITER_FENCED`.

Pass means no lost, duplicate, renumbered or reordered event and exactly one
current writer epoch.

## Gate 3: races and network faults

Run each case with independent DSH processes and connections:

- A and B race the same handoff acceptance;
- the response is cut after PostgreSQL commit, then the request is retried with
  the same idempotency key;
- A sends a delayed append after B has taken ownership;
- the client loses the network before commit and during response delivery;
- the Teleport process is killed during a request and restarted;
- PostgreSQL is restarted while clients poll `/health`, then recovers;
- two manual recovery requests race at the same observed head.

Use a disposable proxy such as Toxiproxy or an isolated firewall rule to inject
loss; never point a kill/restart test at a database containing useful data.
After every case, query the authority and assert one legal committed prefix,
one writer epoch advance and one idempotency/audit outcome.

## Gate 4: migration and rollback

Create a disposable real JSONL Session, capture it through the public
persistence seam, dry-run, apply to PostgreSQL and compare the exact event JSON
and digest. Before any new Teleport append, exercise rollback. Repeat the import,
append once on Teleport, and prove that rollback is then rejected. No physical
JSONL parser or environment-specific fixture is copied into this repository.

## Gate 5: operations

- restore a PostgreSQL backup into a fresh disposable instance and compare all
  Session heads/digests;
- rotate service and admin credentials without printing them;
- verify TLS certificate and hostname failure behavior;
- confirm logs and evidence contain no tokens or Session body content;
- run a bounded sustained append/read workload and report latency distribution,
  disconnects and retries rather than only average throughput.

Release acceptance requires all safety gates to pass. Performance failure may
block a target deployment; any lost/duplicated event, stale-writer commit,
silent history split, token leak or unverifiable restore blocks the release.
