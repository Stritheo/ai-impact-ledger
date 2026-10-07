# AI Impact Ledger

AI Impact Ledger is a local-first VS Code extension that estimates the cost,
energy, operational water consumption and carbon impact of Claude Code and
Codex activity. It is designed to inform rather than alarm: it reports derived
ranges, evidence boundaries and unknowns rather than presenting false precision.

## Current status

Version 0.3.0, published as source and as a hash-verified VSIX for manual
installation. It is not distributed through the Marketplace or Open VSX.

**What this is.** Estimates, not an invoice and not a lifecycle assessment.
Cost is what the same recorded tokens would cost at published API prices; a
subscription, discounts or credits make the real payment different. Energy,
water and carbon are derived ranges with a stated boundary and stated
exclusions, because no published source measures these models directly. Treat
every figure as an order of magnitude, not a measurement.

**What leaves your machine: nothing.** No telemetry, no network calls, no
subprocesses. `npm run security` fails the build if any of those appear in the
source, so the claim is enforced rather than promised. Prompts, responses and
file paths are discarded at parse time.

**Known limitations** are tracked as open issues and listed in `CHANGELOG.md`.

AI Impact Ledger is an independent project. It is not affiliated with,
endorsed by or sponsored by Anthropic or OpenAI. Claude and Codex are
trademarks of their respective owners and are used here only to name the local
log formats this extension reads.

The quiet status-bar item shows the selected cost or energy measure. Selecting
it opens a local dashboard with reporting periods, Claude and Codex
contribution, model detail, derived ranges, plain-language comparisons and
methodology.

## What it reads

The extension reads recognised numeric usage metadata from local Claude Code
and Codex JSONL logs. Claude and Codex remain separately attributable,
including when a Claude session runs Codex, and each call is counted once. It
does not retain prompts, responses, tool arguments, repository contents,
credentials, usernames or raw log lines.

## What the figures mean

- **Cost** is an API-price equivalent estimate, not an invoice. A call is left
  unpriced rather than guessed when its model is unknown, when a Claude call
  used a non-standard speed or service tier such as fast mode, or when an
  OpenAI prompt exceeded that model's standard size. Codex logs carry no tier
  field today, so only prompt size applies there.
- **Energy, water and carbon are ranges, with no central figure.** No published
  source measures Claude or Codex electricity, so the ranges are derived from
  measurements of comparable open models, scaled to whole-facility electricity.
  The working is in [the energy derivation](docs/evidence/energy-derivation.md).
- **The ranges exclude the energy of re-reading cached context**, which is most
  of the tokens recorded here and which no reviewed source measures. The report
  says so wherever the figures appear.
- Where one number is unavoidable, for the everyday comparison and the Claude
  and Codex share, the midpoint is used and labelled.

## Trust boundaries

- No prompts or responses are stored.
- No credentials or keychains are accessed.
- No telemetry or runtime network requests are permitted.
- Numeric per-call records expire after 90 days by default. If the store
  reaches its 64 MiB limit, the oldest detail is removed, its daily totals are
  kept, and the report discloses the date it was trimmed to.
- Daily numeric aggregates are retained until the user deletes them.
- The rollback copy kept during migration is deleted 14 days after the new
  store is first read back successfully, and immediately on purge.
- Processing location remains unknown unless a provider log contains an
  allowlisted region value; workstation location is never used as a proxy.
- After its initial inventory, each refresh reads only changed log files and
  reports its own scan time in the local report.

## Usage export for scripts

```sh
npm run export:usage -- --out ~/usage.json
node src/cli/usage-export.js --key-for /path/to/project
```

A read-only command that writes JSON totals of tokens and API-price cost for
the rolling 5 hours, today, the last seven days and the calendar month to date,
split by provider and by project. It reads the same logs with the same parsers
and prices as the extension, never opens the extension's store, and writes
only the file named by `--out` (owner-only), or standard output.

A project is the folder a session was started in, identified by a SHA-256 key
of that folder, never by the folder itself. `--key-for` prints the key for a
folder, so a script can find its own project. The key keeps folder names out
of the file; anyone who can guess a folder can still confirm it. The figures
are partial: use of the same plans on the web, desktop or phone is not in the
local logs. A call the registry cannot price is counted as unpriced, not
guessed.

## Development and assurance

Requirements and controls are indexed in [the documentation guide](docs/README.md).

```sh
npm test
npm run verify
npm run assure
npm run verify:counting
```

`npm run assure` performs a clean install, dependency audit, tests, coverage,
security checks, SBOM generation and reproducible VSIX packaging. The same
commit produces the same artefact hash on any host.

`npm run verify:counting` reconciles what the ledger counts against the
providers' own logs, printing counts only. Codex records a per-turn total for
some turns, and those are the turns that can be checked against the provider's
own arithmetic; Claude publishes no such total, so its records are reconciled
against each other. It is the daily check during the pilot: zero unexplained
Codex tokens and zero coverage warnings.

The separate monthly evidence workflow compares every source the registry
cites against a stored baseline hash and fails on any change, unreachable
source or overdue manual review. It has no write permission and can never
change a production factor.

## Evidence for this release

- [Energy derivation](docs/evidence/energy-derivation.md), reviewed and approved.
- [How this product is verified](docs/verification.md), including what
  independent review found and what verification does not cover.
- [Source provenance ledger](docs/provenance.md).
