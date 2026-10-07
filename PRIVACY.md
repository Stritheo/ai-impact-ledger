# Privacy model

AI Impact Ledger processes local Claude Code and Codex usage logs in memory.
It extracts only timestamps, provider, model, token counts, request identifiers
used for deduplication, inference geography when explicitly present, and a flag
marking a call that was not priced at standard rates. The stored record also
allows a configured region, which nothing currently sets.

It must not persist prompt text, response text, tool arguments, repository
contents, usernames, project paths, credentials or raw log lines. Request
identifiers are converted to keyed local hashes before storage.
File-change checkpoints are also keyed hashes; log paths are not stored.
Where a call used a non-standard speed or service tier, only the fact that it
was non-standard is kept, never the tier itself.

## Usage export

The usage export (`npm run export:usage`) reads the same logs. To group calls
by project it reads the folder each session was started in and, inside the
parser, replaces it with a SHA-256 key; the folder is never stored or written.
The key is not secret, so that a local script can find its own project, which
means anyone who can guess a folder can confirm it. The export contains keys,
counts, model names and cost totals only, and is written only where you ask,
with owner-only permissions.

## Retention

Detailed numeric records expire after the configured retention period, which
defaults to 90 days. Daily aggregates contain only date, provider, model
family, call counts and token totals; impact estimates are calculated for
display. The extension makes no runtime network requests. Location is never
inferred from IP address or the user's workstation.

If the store reaches its 64 MiB limit, the oldest detailed records are removed
until it is back under 90 per cent of that limit. Their daily totals are kept
first, so nothing stops being recorded, and the report discloses the date
detail was trimmed to.

## Storage

Bulk records are stored in a fixed extension-owned directory, partitioned by
UTC day, with owner-only permissions, atomic per-file writes and schema
validation. The local hashing secret is an owner-only file in that directory,
created atomically so that simultaneous VS Code windows share one secret; a
copy is kept in VS Code global state so an existing installation keeps its
identifiers. A compatibility deletion watermark also remains in global state;
the authoritative watermark is in the locked ledger. Simultaneous windows
coordinate writes through a lock that records its holder. A lock is taken over
after thirty seconds only when its holder is no longer running, or when it
records no holder, as a lock written by version 0.2 does not. A lock older than
ten minutes is taken over regardless, because a process id can be reused and no
update takes that long.

## Migration and rollback

During v1-to-v2 migration, the original `ledger.v1.json` is kept for rollback.
It may contain records older than the configured retention period. That copy is
deleted 14 days after the new store has been read back successfully, and
immediately when the user purges detailed records. Nothing about the copy is
decided until a read-back succeeds, so a damaged new store never costs the only
other record, and a copy that cannot be read is never deleted. A copy that is a
symbolic link is skipped rather than followed. The purge dialogue states that
the copy will also be deleted.

A purge sets a watermark at the moment it runs. A call completed shortly before
that moment, but not yet scanned, is not recorded afterwards: the watermark is
what makes a purge durable against logs that still hold the call.
