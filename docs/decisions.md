# Decisions

The owner's rulings, newest first. Each records what was decided, why, and
where it is carried out. Add new rulings here in the pull request that acts on
them. Commercial decisions are kept outside this public repository.

| Date | Decision | Why | Where |
|---|---|---|---|
| 2026-10-23 | The backlog lives in GitHub issues, labelled `beta` or `backlog`; CLAUDE.md points new sessions here | Context was living only in chat and was lost between sessions | CLAUDE.md "Start here" |
| 2026-10-23 | Beta testers get 0.3.0 as a direct VSIX with its SHA-256 published, not through the Marketplace | A closed group, and Marketplace signing is still pending | #15 |
| 2026-10-23 | Closed beta in about two weeks, testing cost and impact measurement; no offsetting | Core is ready, but macOS and Windows are untested, log folders are fixed, and reviews fall due mid-beta | #10 to #15 |
| 2026-10-23 | The companion extension's private repository is created later, once partner terms are known | Its design depends on them | — |
| 2026-10-23 | 0.3.0 is the first public release; the Unreleased entries are folded into it | One coherent first release that includes the accuracy fixes | `CHANGELOG.md` |
| 2026-10-23 | CI shows the VSIX hash on the run summary page | Release requires a hosted build matching a clean local build; the hash was buried in the job log | `scripts/assurance-summary.mjs` |
| 2026-10-23 | Ember held | Its intensity is lifecycle CO2e, failing the CO2-only condition, and every logged call is globally routed, so no region is known; revisit at the CO2e step | #16 |
| 2026-10-23 | Context-reading energy counted from 512 to 4,096 prompt tokens per call, no further (option a1) | The only measured span (ML.ENERGY Benchmark, Table 4); extending it to agentic contexts would be extrapolation | `docs/evidence/energy-derivation.md` section 11; #17 |
| 2026-10-23 | Offsetting, if built, lives in a separate private companion extension that reads this ledger through a read-only interface | Keeps this extension network-free and its privacy promise intact | #12 |
| 2026-10-22 | Named GitHub repositories at pinned commits may serve as primary sources, paired with a reviewed publication where one exists | Canonical home of SCI for AI and EcoLogits; pinning fixes the bytes reviewed | `scripts/check-evidence.mjs` |
| 2026-10-22 | Every carbon bound must be a 2025 value; the low bound becomes the EU's 170 g CO2/kWh | Review found the earlier 90 was the EU's 2030 forecast | `src/data/impact-registry.v1.json`; `test/energy-ranges.test.js` |
| 2026-10-22 | Improve estimate accuracy before building any offset feature | An offset sells the estimate as tonnes; the dominant token class was excluded | `docs/plans/2026-10-22-estimate-accuracy.md` |
