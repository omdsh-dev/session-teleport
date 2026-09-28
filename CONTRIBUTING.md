# Contributing

## Local checks

Use a supported Node.js version and the package-manager version declared in
`package.json`:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack:check
```

Dependencies are public npm packages; no npm token is required. Keep credentials
out of repository files, logs, issues and test fixtures.

`pnpm build` updates the committed `dist/` output. A source change and its
generated output belong in the same review. Source maps must remain relative
and must not embed source text. `pnpm typecheck:adapter` checks
`src/dsh-adapter.ts` and `src/index.ts` strictly against the pinned published
development baselines declared in `package.json`; declaration generation uses
the same real package types.

## External compatibility checks

The opt-in integration tests accept a caller-provided DSH CLI and explicit
package-manager specs for Cordis, Session, Session Persistence and the JSONL
composition baseline. Do not copy DSH source,
non-public fixtures, package-manager configuration or credentials into this
repository to make a test self-contained. See [Testing and release gates](docs/TESTING.md).

## Submitting a change

- Add or update tests for behavior changes.
- Keep import bundles, production logs, database dumps and writer credentials
  out of commits and issues.
- Replace accounts, hosts, paths and secrets in examples with placeholders.
- Update public documentation when an operator-facing contract changes.
- Preserve the BSD-3-Clause notices for files distributed by this repository;
  external peer packages retain their own licenses.
