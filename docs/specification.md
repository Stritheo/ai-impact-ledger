# Product specification: version 0.3.0

## Outcome

Give one person a useful, calm account of the operational consequences of their
Claude Code and Codex usage without exposing what they worked on.

## Observable behaviour

1. The extension reads only recognised JSONL records beneath fixed Claude Code
   and Codex log roots.
2. It extracts numeric usage metadata and discards all content fields.
3. Repeated streaming records and repeated scans do not increase totals.
4. Claude and Codex calls remain separately attributable when one invokes the
   other; a provider request or turn is counted once.
5. The status bar reports the configured cost or energy measure for the selected
   reporting period; selecting it opens the local dashboard.
6. The report gives a derived range, with no central figure, for energy,
   operational water and carbon, with confidence, evidence dates and a
   statement of what the range excludes. Where one number is unavoidable, for
   the everyday comparison and the provider share, the midpoint is used and
   labelled.
7. Water interpretation distinguishes reported inference geography from the
   user's location. Unknown infrastructure location remains unknown.
8. Detailed records expire after 90 days by default; daily aggregates remain.
   At the storage limit the oldest detail is trimmed after its totals are
   kept, and the trim is disclosed; recording never stops.
9. Missing, malformed or hostile records are ignored without executing or
   rendering their contents.
10. After the first scan, unchanged logs are not reread; the monitor records
    only keyed file fingerprints and measures its own scan duration.
11. Display currency, water units, reporting period, contribution basis and
    analogy preferences change presentation only, not canonical stored usage.
12. Published factors and prices carry machine-checked provenance. Evidence
    checks run outside the extension and cannot silently update production data.
13. Counting pauses when an older version of the extension is found writing to
    the same records from another VS Code window. The status bar and the report
    both say so and say what to do, and nothing further is written. That
    combination inflates stored totals, because the older version removes the
    counting-basis stamp and re-adds calls it can no longer recognise.
14. The daily totals can be rebuilt from the local logs on request, after a
    confirmation stating what is replaced. Detailed records deleted by a purge
    are not restored.

## Non-functional requirements

- No runtime dependency, network request, credential access or subprocess.
- Warm scans avoid rereading unchanged logs and unnecessary ledger writes.
- Storage is bounded, owner-only, schema-validated and recoverable after an
  interrupted write or concurrent VS Code window update.
- Malformed, oversized, traversed and symbolic-link inputs fail closed while
  producing a visible coverage diagnostic.
- The dashboard remains keyboard-readable, screen-reader-labelled and usable in
  a narrow VS Code panel.
- Release artefacts are reproducible, accompanied by an SBOM and blocked when
  required evidence or assurance checks fail.

## Non-goals

This release is not a billing system, lifecycle assessment, provider audit,
personal carbon score, professional assurance opinion or source of exact
data-centre, grid, watershed or community-impact attribution.
