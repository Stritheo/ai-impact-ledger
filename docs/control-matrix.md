# Security, privacy and compliance control matrix

This matrix records the control baseline for version 0.3.0. It demonstrates
controls;
it does not claim legal certification. Legal applicability depends on where and
how the extension is distributed and used.

| Objective | Design control | Evidence | Release gate |
|---|---|---|---|
| Data minimisation | Extract only timestamp, provider, model, token counts, hashed request identifier, explicit inference geography and uncertainty | `PRIVACY.md`; parser allowlist; privacy tests | No prohibited field may cross the parser boundary |
| Purpose limitation | Use metadata only to calculate and display personal AI usage impacts | Product specification; no telemetry or export feature | Any new use requires a specification and privacy review |
| Confidentiality | Never collect prompts, responses, tool arguments, repository contents, credentials, usernames or raw log lines | Privacy tests; source-policy scan; packaged VSIX review | Any collection is a release blocker |
| Local processing | Process recognised local logs in memory; store sanitised numeric records in a fixed extension-owned directory, with owner-only permissions, atomic per-file writes and schema validation | Architecture, storage and integration tests | Runtime network, credential or subprocess API is a release blocker |
| Retention and deletion | Keep per-call metadata for 90 days by default; preserve anonymous daily totals; make purge durable against old source logs; delete the migration rollback copy 14 days after the new store is read back, or at once on purge; at the 64 MiB storage limit trim the oldest detail after its totals are kept, and disclose the trim | Retention, rollback-copy, capacity and durable-purge tests | Tests must prove expired, purged or trimmed detail cannot return, and that recording never stops |
| Secure parsing | Restrict roots, reject traversal and symbolic links, bound files and lines, parse JSON as data | Threat model; hostile-input, traversal and symlink tests | Parser security tests must pass |
| Integrity and double counting | Deduplicate streaming updates and nested Claude-to-Codex activity using locally keyed identifiers; one hashing secret per installation across windows | Deduplication, nested-attribution and hashing-secret tests; `npm run verify:counting`, which checks the Codex turns that carry a provider-stated total (184 of 1,565 responses on 17 September) and reconciles Claude against its own logs | A provider request or response is counted once; zero unexplained tokens among the turns that can be checked |
| Transparent estimates | Label cost as an estimate; show energy, water and carbon as derived ranges with no central figure, to two significant figures, stating what the range excludes; leave a call unpriced rather than guess its price | Energy derivation; registry schema and confidence tests; report and precision tests | A central environmental figure, a missing confidence or a missing exclusion blocks a registry update |
| Controlled evidence updates | Update environmental factors through reviewed monthly pull requests, never at runtime; compare every cited source with a stored baseline hash | Versioned registry; evidence workflow run 35268287354; baseline file | A changed, unreachable or overdue source fails the run; the workflow has no write permission |
| Supply-chain security | Zero runtime dependencies; SHA pinning required and actions restricted to GitHub-owned by repository policy; audit, secret and source scan, SBOM, and packaging that is byte-identical across hosts | `npm run assure`; CycloneDX SBOM; repository Actions settings; matching local and CI artefact hashes | Critical/high unresolved findings or an artefact that differs between hosts block release |
| Licence and provenance | Import only allowlisted code with source-to-destination records and attribution | Adoption report; provenance ledger; licence | Unrecorded retained upstream code blocks release |
| Access and publication | Private repository; branch protection on `main` requiring the verify check and applying to administrators; no automatic publishing | Repository settings and hosted checks | Public distribution requires an approved signing route and a higher evidence bar |
| Operational efficiency | Incremental scans skip unchanged files and disclose monitor runtime | Measured on the owner's logs, 18 September 2026 (424 files, 17,934 calls): cold scan 2.7 s, warm scan 49 ms reading no files, summary build 109 ms, peak memory 294 MiB | Budget: warm scan under 500 ms and summary build under 400 ms, the latter enforced by test |
| Multi-window integrity | Coordinate bulk-store updates across VS Code extension hosts; reject symlinked or malformed state | Concurrent-update, malformed-state and symlink tests | Lost updates or unsafe file resolution block release |

## Executive release rule

- **Green:** the control has automated or independently reviewable evidence.
- **Amber:** the control is designed but awaits external evidence or a human
  decision. Alpha use may proceed only if the recorded compensating control is
  accepted.
- **Red:** a test failed, evidence is absent, or a critical/high risk is open.
  Release stops.

The evidence for this release is the
[energy derivation](evidence/energy-derivation.md), the
[verification summary](verification.md), which records what independent
review found and how those findings were closed.

Two controls are designed but not automated, and are stated in `SECURITY.md`:
CodeQL and GitHub secret scanning both need a paid licence on a private
repository. Their compensating controls are the source-policy scan, the pattern
scan over tracked files and history, and independent verification per release.
