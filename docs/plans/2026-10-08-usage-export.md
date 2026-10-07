# Plan: a read-only usage export

Date: 8 October 2026. Status: approved for build by the owner's ruling of the
same date.

## Requirement

A local usage governor and a scorecard need machine-readable totals. Add a
read-only command-line export that writes JSON totals of tokens and API-price
cost for the rolling 5 hours, the day, the week and the month, per project
keyed by a hash of the folder, reusing the ledger's own parsing and pricing.
No network call, no stored paths, `npm run security` and the existing tests
green, tests written first.

## Design

- **Entry point.** `src/cli/usage-export.js`, run with
  `node src/cli/usage-export.js [--out <file>]` or `npm run export:usage`.
  Inside `src/`, so the security audit covers it. JSON goes to stdout, or to
  `--out` written atomically with mode 0600. `--key-for <folder>` prints the
  key a folder would carry, so a consumer never reimplements the hash.
- **Read-only.** It scans the same log roots as the extension with the same
  `scanRoot` and parsers, opens logs read-only, and never opens the extension's
  store. The only file it writes is `--out`.
- **Project key.** A session's spend belongs to the folder it was started in:
  the first working folder a Claude session file records, or the `cwd` of a
  Codex `session_meta` record. Per-call folders were rejected: in a week of the
  owner's logs, 20 of 132 sessions changed folder mid-session (worktrees,
  subfolders, even a package directory), which would scatter one project's
  spend across dozens of keys. The key is SHA-256 of
  `ai-impact-ledger/project/v1:` plus the absolute folder, computed inside the
  parser; the folder itself is never put on an event, stored or written.
  The parser adds the key only when the caller asks, so the extension's stored
  records are unchanged (and `sanitiseEvent` would drop the field anyway).
- **Windows.** The rolling 5 hours ends now. Day, week and month are local
  calendar days in the machine's time zone, matching the report: the day is
  today; the week is today and the previous six days (the report's "7d"); the
  month is the calendar month to date. Each window states its bounds.
- **Figures.** Calls, tokens by class (input, cached input, cache write,
  output) and their total on the ledger's basis, and API-price cost in USD from
  `estimateEvent`. Unpriced calls and their tokens are counted and disclosed,
  never priced by guess. Every figure is split by provider, because Claude and
  Codex draw on different allowances.
- **Speed.** Files last modified before the earliest window, less two days of
  margin, are not read. A file cannot hold a call later than its last write.
- **Coverage.** Files read and skipped, records skipped, unrecognised schemas,
  calls with no recorded folder, and whether each log root was found. A
  missing root is reported as missing, not as zero.

## Six design-time controls

- **Compartment integrity:** reads only the two log roots; writes only `--out`.
- **PII:** no prompt, response or path leaves the parser. The export carries
  hashes, counts and model names only.
- **Credentials:** none touched.
- **External data:** log lines are untrusted and pass through the existing
  validating parsers unchanged.
- **Outbound actions:** none. No network module, no subprocess; the audit
  enforces it.
- **Access control:** the output is 0600, written to a temporary file and
  renamed, so a link at the target is replaced rather than followed.

## Tests first

1. Parser: a Claude file and a Codex file yield the session folder's key on
   every call when asked, no key when not asked, and never the folder text.
2. Key: deterministic, 64 hex, trailing slash ignored, distinct folders differ,
   relative or oversized input refused.
3. Scanner: files older than `modifiedSince` are not read and are counted.
4. Export builder: window membership at each edge, local-day boundaries in a
   non-UTC zone, provider and project splits, unpriced disclosure, duplicate
   calls counted once.
5. CLI end to end on fixture roots: output written 0600, no fixture path text
   anywhere in it, logs unchanged, no other file created, `--key-for` agrees
   with the keys in the export.

## Honest limits

- Local logs miss use of Claude on the web, desktop and phone, which draws on
  the same allowance. The export is a partial view and says so.
- A key is a pseudonym, not anonymity: anyone who can guess a folder can
  confirm it. It keeps folder names out of the file; it does not hide them
  from someone who already knows them.
- A worktree is its own folder, so it carries its own key.
- Claude Code deletes old session logs (30 days by default), so late in a long
  month the opening days may already be gone.
- Cost uses the registry's prices as reviewed, not historical event-time
  prices, and a model missing from the registry is unpriced.

SKIPPED: energy, water and carbon in the export. The ruling asks for tokens
and cost; the ranges can be added on the same windows later.
