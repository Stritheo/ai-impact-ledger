# How this product is verified

Verification here means re-deriving a result independently, not re-reading the
code that produced it.

## Gates on every change

- Unit tests across parsing, counting, pricing, storage, reporting and
  security policy. Coverage is gated at 90% of lines.
- A source and JSON syntax check across every tracked file.
- A security policy audit that fails the build if a runtime dependency,
  network call, subprocess, credential API or dynamic evaluation appears.
- A reproducibility gate: the packaged artefact must hash identically when
  built again from the same source, whatever the builder's file modes or
  directory order.

## Counting, checked against the provider

`npm run verify:counting` reads the local logs and compares what the ledger
counts against the totals the providers state in their own records. The release
of version 0.3.0 reconciled every turn that carried a provider-stated total,
with no unexplained tokens and no unrecognised record schemas.

## Independent review

Version 0.3.0 was reviewed by three independent sessions that re-derived
results rather than reading the implementation. They found nine defects that
would have put wrong figures in front of a user, including a purge that
silently dropped most of a day's calls, calls priced at standard rates when
their tier was not standard, and a long-context pricing rule taken from a
secondary source that omitted it. Each is fixed, and each carries a test that
fails without the fix.

A later defect, found during owner acceptance, is the reason for the store
guard in 0.3.0: two versions of the extension running in different VS Code
windows wrote to one store, and the older one inflated the stored totals to
roughly 290 times the number of calls the logs contained. The product now
detects that condition, pauses counting, says so, and offers a rebuild from the
logs.

## What verification does not cover

The extension has not been driven in an automated live extension host. Host
behaviour is exercised through a stub and confirmed by hand against an
acceptance checklist before a release.
