# Impact methodology

## Boundary

Estimates cover model inference operations represented by token counts. They do
not yet include training, hardware manufacture, buildings, networking, user
devices, staff travel or end-of-life impacts.

## Cost

Cost applies published API list prices to fresh input, cached input, cache-write
and output tokens. Subscription charges, batch discounts, regional premiums and
provider credits may differ. The UI therefore says "API-equivalent estimate".
Codex's `input_tokens` includes cached input: cached tokens are subtracted once
before applying fresh-input rates. Claude's fresh and cached input arrive as
separate counters. Unknown model versions remain unpriced rather than borrowing
a price from a similar name. Version 0.2 corrects both live parsing and the
numeric v1 ledger at migration, without changing the original rollback copy.

USD is the stored calculation currency. AUD, GBP and EUR are presentation-only
conversions using the dated ECB information-only reference rate in the offline
FX registry. It is not a transaction rate and no live currency request is made.

## Energy, water and carbon

Energy is a range, not a single figure. No published source measures Claude or
Codex electricity, so per-token ranges are derived from measurements of
comparable open models and scaled to whole-facility electricity; the working is
in `docs/evidence/energy-derivation.md`. The range excludes the energy of
re-reading cached context, which no reviewed source measures and which accounts
for most recorded tokens. Where a single number is unavoidable, for the
everyday comparison and the Claude and Codex share, the midpoint is used and
labelled.

Direct operational water uses the LBNL 2024 US fleet average of just over
0.36 L/kWh and its 2028 upper projection of 0.48 L/kWh; zero is retained as the
lower bound for cooling that consumes no onsite water. That metric is defined
per kWh of IT-equipment electricity, so it is applied to IT energy, which is
the facility figure divided by the overhead multiplier (PUE). Carbon uses the
IEA's 2025 global midpoint and disclosed regional examples, applied to
whole-facility electricity, which is what the grid supplies. Water stress is
interpreted only when the log or user supplies defensible infrastructure
context; workstation location is not a proxy for data-centre location.

Comparisons use the midpoint of the operational energy range. Energy is
compared with hours of television at 100 watts, a figure from the measured
Google study in `docs/evidence/energy-derivation.md`. Water is compared with
250 mL glasses, which is a stated unit rather than a measurement, and the
report says so. An e-bike comparison is held in the backlog until a primary
source for its energy per kilometre is approved. Coffee's agricultural water footprint is deliberately excluded because
it is a different lifecycle boundary.

## Update policy

The registry is reviewed monthly through a pull request. Every value carries a
source URL, publication or review date, geography, boundary and confidence.

A scheduled workflow checks every source the registry cites against a stored
baseline hash in `evidence/source-baselines.json`, which is not shipped with
the extension. Pages are hashed on their visible text, so scripts and build
identifiers do not raise false alarms. The European Central Bank reference
page changes daily by design and is checked for structure only. The IEA
refuses automated clients, so it is declared a manual source: the run fails
once its recorded review date passes. The workflow reports to the job summary
and can never change a figure; a person updates the registry and then the
baselines with `node scripts/check-evidence.mjs --write-baselines` in a
reviewed pull request.
The FX registry has its own monthly review date and source. Historical daily
aggregates use UTC dates; exact local-day attribution is available only while
per-call detail remains. The report labels cumulative history accordingly.
