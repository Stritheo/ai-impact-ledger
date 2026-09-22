# AI Impact Ledger — project instructions

A local-first VS Code extension that estimates the cost and environmental
impact of AI coding work. Nothing it records leaves the machine.

## Commands

- `npm test` — the full unit suite (`node --test`).
- `npm run check` — source and JSON syntax across every tracked file.
- `npm run security` — fails if a runtime dependency, network call,
  subprocess, credential API or dynamic evaluation appears anywhere in `src`.
- `npm run verify` — the three above. Everything must pass before a commit.
- `npm run verify:counting` — reconciles what the ledger counts against the
  totals the providers state in their own logs. Reads local logs and emits
  counts only.
- `npm run evidence:check` — checks that every factor and price resolves to a
  sourced evidence entry.
- `npm run package:vsix` — verifies, regenerates the SBOM and writes a
  reproducible VSIX to `build/`.

## Non-negotiables

- **No runtime dependencies.** The security audit enforces it.
- **No network calls, no telemetry, no subprocesses.** Same audit.
- **Never weaken a test to make it pass.** If a gate fails, fix the cause.
- **No content is ever recorded.** Prompts, responses, file paths and
  arguments are discarded at parse time. Event identifiers are HMAC-hashed
  with a locally generated secret.
- **Figures must be defensible.** Every price and factor resolves to an entry
  in `src/data/impact-registry.v1.json` with a source, a date and a boundary.
  A call that cannot be priced defensibly is left unpriced and disclosed, not
  guessed.
- **Ranges, not false precision.** Energy, water and carbon are derived
  ranges. Where one number is unavoidable, use the midpoint and say so.

## Conventions

- CommonJS, Node 24, two-space indent, no build step for `src`.
- Tests live in `test/` and run against the real modules; extension-host
  behaviour is driven through a stub, not a live VS Code instance.
- Comments explain why, not what.
- AU/UK spelling in user-facing copy.

## Packaging gotchas

- **`CHANGELOG.md` ships inside the VSIX.** Anything written there reaches every
  installation, not just readers of this repository.
- **Two file lists.** `scripts/package-vsix.mjs` keeps its own `included` array,
  separate from `files` in `package.json`. A new shipped file must be added to
  both, and to the fixture list in `test/artefact-reproducibility.test.js`.
- **The artefact must be reproducible.** The packaged VSIX has to hash
  identically when built again from the same source. A release is published only
  once a hosted build of the commit matches a clean local build.

## Layout

- `src/core/` — scanning, parsing, estimation, storage, reporting. Pure where
  it can be.
- `src/extension.js` — the VS Code surface: status bar, report panel, commands.
- `src/data/` — the impact registry and FX registry, both provenance-checked.
- `docs/` — specification, methodology, threat model, evidence derivations.
