# Threat model

## Assets

Prompts, responses, source code, credentials, identity, local filesystem and the
integrity of reported impact figures.

## Untrusted inputs

Git repositories, JSONL records, model names, request identifiers, configuration
values, monthly registry updates and packaged extension artefacts.

## Controls

- Fixed allowlisted roots; no path taken from log contents is ever opened.
- The usage export reads a session's starting folder only to hash it inside
  the parser. The folder is never opened, stored or written; the export is
  written atomically, owner-only, and only where the caller names.
- Symbolic links are not followed and files outside their canonical root fail.
- 8 MiB line and 256 MiB file limits bound parsing; oversized inputs are
  disclosed as incomplete coverage rather than silently omitted.
- JSON is parsed as data. No evaluation, shell, HTML interpolation or commands.
- Only allowlisted numeric and short metadata fields cross the parser boundary.
- Stored identifiers are hashed with a locally generated secret.
- Incremental scan checkpoints use keyed path hashes, never stored paths.
- The v2 store uses a fixed extension-owned directory, owner-only permissions,
  atomic per-file replacement, strict read validation and a cross-window lock.
- No runtime networking, subprocesses, credential APIs or workspace reads.
- Registry changes require schema tests, cited evidence and human review.
- A nonce-only webview policy applies to the report.

## Residual risks

Providers can change undocumented log formats. Environmental estimates depend
on broad research ranges because model-specific operational measurements are
generally unavailable. Compromised VS Code or operating-system access is beyond
the extension's isolation boundary. A terminated process can leave a temporary
file or lock, but stale locks expire and temporary files contain only sanitised
ledger data. The final file is opened without following a symlink and its
identity is checked, but an intermediate-directory race is not fully excluded
by the Node filesystem API. A multi-file v2 update is not one transaction; only
one interrupted-commit recovery scenario is tested. Very large directory trees
may be expensive to enumerate or exceed scanner depth and changed-file limits.
The usage export's project keys are unkeyed hashes by design, so a consumer
can find its own project without a shared secret; anyone holding an export and
a guess at a folder can confirm the guess.
