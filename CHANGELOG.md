# Changelog

Notable changes to AI Impact Ledger. This file starts at 0.3.0, the first
public release; earlier versions were private.

Dates are ISO 8601. Versions follow semantic versioning.

## 0.3.0 — unreleased

### Added

- Energy, water and carbon are shown as derived ranges with no single figure,
  each stating its confidence, its evidence date and what it excludes. Where
  one number is unavoidable, for the everyday comparison and the provider
  share, the midpoint is used and labelled as such.
- Everyday comparisons are sourced: hours of television and 250 mL glasses of
  water. The unsourced e-bike comparison was withdrawn and is tracked in
  issue #18.
- A monthly evidence check that detects when a published source has changed.
- `npm run verify:counting`, which reconciles what the ledger counts against
  the totals the providers state in their own logs.
- Command "AI Impact Ledger: Rebuild From Logs", which recomputes the daily
  totals from the local logs after a confirmation stating what is replaced.
  Detailed records deleted by a purge are not restored.

### Fixed

- Counting pauses, and says so in the status bar and the report, when an older
  version of the extension is found writing to the same records from another
  VS Code window. Installing a new version does not replace the code already
  running in an unreloaded window, and the older version removes the
  counting-basis stamp and re-adds calls it can no longer recognise. In the
  incident that prompted this, stored totals reached roughly 290 times the
  number of calls the logs contained.
- An open report now redraws itself when a setting, a purge or a refresh
  changes what it shows, instead of holding the figures it was opened with.
- The status bar tooltip keeps the energy range, and the statement that the
  range excludes re-reading cached context, on a refresh that finds nothing
  new.
- Calls are counted once against each provider's own totals, including where
  one provider's session invokes the other.
- A day only partly covered by detailed records is taken from its daily total
  rather than from the records that survive, so a purge or a trim no longer
  shrinks that day.
- Long-context and non-standard-tier calls are no longer priced at standard
  rates; calls that cannot be priced defensibly are left unpriced and
  disclosed rather than guessed.

### Known limitations

- Calls older than the retention window never reach the daily totals
  (issue #19).
- A day at the edge of a period can include work from the neighbouring local
  day, because totals carry UTC dates while periods are local (issue #20).
