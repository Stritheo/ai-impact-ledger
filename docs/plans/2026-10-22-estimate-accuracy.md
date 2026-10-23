# Plan: estimate accuracy before offsetting

Date: 22 October 2026. Status: **rulings recorded 23 October 2026
(section 6).** Research phase only; no feature code. Gates restored
(section 2).

## 1. Why now

An offset feature turns the carbon estimate into tonnes a user pays for. On
this machine's logs (33 Claude calls, 1 to 22 October) the estimate is 2.3 to
32.8 g CO2, a 14-fold spread (26-fold before the carbon correction in
section 2), and 96.8 per cent of the tokens behind it
(3,898,331 of 4,026,396) are cache reads that the registry counts as zero
energy. Offsetting even the high bound would not be conservative, because the
largest token class is outside it.

The sample is one cloud container, not the owner's workstation. The method
below must be re-run there before any figure in this plan is relied on.

## 2. Gates

`npm run security` was failing on 22 October because every evidence entry
passed its review date on 15 October. Three tests fail for the same reason on
`main` (44, 56, 80). This plan:

- **Re-reviews Anthropic pricing** against the live page on 22 October. Every
  existing Claude price still matches. Review dates move to 2026-11-22.
- **Adds Claude Opus 5.5** ($4 input, $0.20 cache read, $5 and $8 cache write,
  $20 output), **Sonnet 5.5** ($2, $0.10, $2.50, $4, $10) and **Haiku 5.5**
  ($0.10, $0.01, $0.125, $0.20, $0.50 up to a 100,000-token prompt). A Haiku
  5.5 prompt over 100,000 tokens, cache reads included, is left unpriced as
  non-standard tier, as long-context Codex calls already are. Tests written
  first. On the sample this prices all 33 calls, which were previously
  unpriced.

- **Re-reviews OpenAI pricing.** Astra, GPT-5.6 Sol and Terra match their
  model pages. Sol's page still calls its price promotional "at least through
  November 21, 2026", so OpenAI entries now fall due on 2026-11-21, and a test
  holds that date.
- **Adds GPT-6.1 Sol** ($2 input, $0.10 cached, $2.50 cache write, $10
  output) and **GPT-6 Luna** ($0.10, $0.01, $0.125, $0.50), both with the
  272K long-context rule. Tests written first.
- **Re-reviews the energy sources.** Neither arXiv paper has a new version
  (ML.ENERGY Benchmark is still v2 of 16 October 2025; Google is still v1),
  and both PDFs hash identically to the files the derivation recorded. The
  ML.ENERGY leaderboard index hashes identically to its September baseline.
  Every energy figure therefore stands unchanged.
- **Refreshes `evidence/source-baselines.json`** for each source re-read,
  keeping LBNL's September hash because LBNL could not be fetched.

- **Re-reviews LBNL water.** The PDF hashes identically to the file the
  derivation used.
- **Updates exchange rates** to the ECB reference rates of 22 October 2026
  (USD 1.1205, AUD 1.5980, GBP 0.83770 per EUR). Two tests that pin the
  displayed rate move with it.
- **Admits named GitHub repositories at pinned commits** as evidence sources,
  per the owner's ruling (section 3.3): `genai-impact/ecologits` and
  `Green-Software-Foundation/sci-ai`, on `raw.githubusercontent.com`, at a
  full 40-character commit hash only. Tests written first.

- **Re-reviews IEA carbon and corrects its low bound.** The report PDF
  (page 106) confirms 435 g CO2/kWh as the 2025 global average and 695 as
  India's 2025 value. The registry's low of 90 was the EU's forecast for
  2030, not a 2025 value; the lowest 2025 value given is the EU's 170. The
  low bound is now 170, so every bound is a 2025 figure. Low carbon estimates
  rise by a factor of 1.89; central and high are unchanged. Two tests pinning
  the old low output move with it, and a new test holds the 2025 rule.
- **Moves the registry-level review** to 2026-11-22, now that every entry is
  current. All gates pass.

## 3. Ranked by effect on the carbon range

| Rank | Lever | Direction | Effect on sample | Evidence status |
|---:|---|---|---|---|
| 1 | Cached-input energy | Raises both bounds | +16.8 to +45.6 Wh on a 13.8 to 47.2 Wh base (price-proxy scenario only) | No measured source |
| 2 | Grid intensity by region | Narrows the range | Carbon spread falls from 7.7-fold on the grid factor alone towards the regional spread | Data not yet read |
| 3 | Embodied emissions and CO2e | Raises both bounds | Not yet calculated | Method found, sources not on approved domains |
| 4 | Per-model scaling | Widens the range | Would separate Haiku from Opus, at very low confidence | Rejected for now |

### 3.1 Cached-input energy

The September derivation (`docs/evidence/energy-derivation.md`, section 5)
already established that a cache read skips prefill, but each output token
still attends over the whole cached context. It also established that no
reviewed source measures that cost. Nothing found since changes this:

- **EcoLogits does not solve it.** Its energy model is a function of active
  parameters and output tokens only. Input and context length do not enter it.
- **Linear extrapolation from S1 is unusable.** S1 Table 4 shows decode energy
  per output token rising from 0.350 J at 512-token prompts to 1.458 J at
  4,096. Carried straight to this sample's mean context of 118,131 tokens, it
  gives about 420 Wh at the low facility multiplier: nine times the whole
  current high bound, from a confounded trend extended 29-fold beyond its
  data.
- **A price-proxy scenario** sets cache-read energy at 5 to 10 per cent of
  fresh-input energy, matching the 0.05x to 0.1x that Anthropic charges.
  It adds 16.8 to 45.6 Wh on the sample, roughly doubling the estimate. The
  derivation rejected price as an energy proxy for cache writes, and the same
  objection applies. It is shown here for scale, not proposed.

**Proposal.** Find a measured source before choosing a number. Two routes:
- ML.ENERGY leaderboard configurations with long prompts, if its data carries
  input length (S2 is already an approved source).
- A first-principles bound from published open-model architectures: bytes of
  KV cache read per decode step times accelerator energy per byte. This
  needs the owner's ruling, because it is a derivation, not a measurement.
Until then, the report and any offset must state that the dominant token
class is excluded.

### 3.2 Grid intensity by region

The carbon factor is now 170 to 695 g CO2/kWh around a 435 global average,
all 2025 values (IEA, low confidence).
Events already carry `inferenceGeo` where Claude logs record it. A provider's
published regions, plus open country data (Ember, released under CC BY 4.0,
confirmed on its site on 22 October), could replace the global range with the range across the
regions each provider actually serves from. Market-based figures from
provider sustainability reports should be shown separately, not used: the
SCI for AI specification excludes RECs and PPAs from any reduction.

**Proposal.** Add `ember-energy.org` to the evidence allowlist, take the
annual intensity for each country a provider names as an inference region,
and use their min and max as the range. Where `inferenceGeo` confirms a
country, use that country's figure.

### 3.3 Embodied emissions and the CO2e boundary

Offsets are sold in tonnes of CO2e. The ledger counts CO2 from electricity
only. The Green Software Foundation's SCI for AI (`(O + M) per R`, functional
unit per token for LLMs) requires embodied emissions M for hardware inside
the consumer boundary. EcoLogits supplies a method: server embodied
5,700 kg CO2e (BoaviztAPI), 273 kg CO2e per H100 (Lees-Perasso et al.),
allocated over a three-year life by time share of the batch.

**Proposal.** Adopt SCI for AI as the reporting boundary. Derive M per token
from the EcoLogits method with ML.ENERGY throughput, and source a CO2 to CO2e
uplift for grid electricity. Both EcoLogits (MPL-2.0) and the SCI for AI
specification are hosted on github.com, which the derivation excluded as a
research domain. Recommended conditions if the owner admits them: allow
named repositories, not the github.com host, since anyone can publish there
and the evidence checker must not be pointable anywhere new; cite commit
permalinks, not branches, so the hashed bytes cannot move; and pair each with
its reviewed publication where one exists (EcoLogits has a JOSS paper).

### 3.4 Per-model scaling

EcoLogits scales energy linearly with active parameters. Its estimates for
closed models come from leaks, benchmarks and pricing, for older models
(Claude 3 Opus, GPT-4) only, with a 3-fold active-parameter range. Adopting it
would widen each range further without evidence about current models.

**Proposal.** Keep `energyMultiplier` at 1. Revisit if a provider discloses
size, or a measured per-model source appears.

## 4. Open-source projects considered

| Project | Licence | Used for | Decision |
|---|---|---|---|
| ML.ENERGY leaderboard and benchmark | per source | energy per token, already cited | keep; mine long-prompt data |
| Google full-system paper | arXiv | facility overhead, already cited | keep |
| EcoLogits (GenAI Impact) | MPL-2.0 | embodied method; cross-check fixture | port method, not code |
| GSF SCI for AI | MIT / CC BY 4.0 (repo statement) | boundary and functional unit | adopt as frame |
| Ember | CC BY 4.0 (confirmed) | regional grid intensity; replaces IEA, which refuses automated checks | adopt |
| CodeCarbon, Cloud Carbon Footprint | open | local or cloud-bill measurement | wrong boundary; skip |

No runtime dependency is proposed. Other tools' figures enter only as test
fixtures or as sourced registry entries.

## 5. For the offset feature

- Offset quantity waits for 3.1 and 3.3. Until then it would knowingly
  undercount.
- Under SCI for AI, offsets do not reduce a footprint. Report gross emissions
  and offsets as separate lines.

## 6. Owner rulings

Ruled by the owner on 22 and 23 October 2026:

1. **Overdue sources:** the environment's allowlist was widened and every
   source re-reviewed here (section 2). Done.
2. **GitHub sources:** approved, on the conditions in section 3.3: named
   repositories only, at pinned commits, paired with a reviewed publication
   where one exists. Implemented in the evidence checker.
3. **Cached input:** route (a), mine ML.ENERGY's long-prompt data for a
   measured figure. Next research item.
4. **Ember:** approved for the evidence allowlist, to derive a regional
   carbon range (section 3.2), subject to its boundary meeting the
   registry's CO2-only rule.
5. **Offset feature:** to be built as a separate, private companion
   extension that reads this ledger's figures, so this extension stays
   network-free. Questions to TEM and for legal advice go out from the owner.

## 7. Six design-time controls

- **Compartment integrity:** registry and documentation only; no new file
  access.
- **PII:** none; figures are aggregate token counts.
- **Credentials:** none.
- **External data:** source pages are read by a person and transcribed with
  provenance; nothing fetched at runtime.
- **Outbound actions:** none added.
- **Access control:** unchanged.

## Sources read on 22 October 2026

- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- EcoLogits repository and methodology:
  https://github.com/genai-impact/ecologits,
  `docs/methodology/llm_inference.md`, `docs/methodology/proprietary_models.md`
- SCI for AI: https://github.com/Green-Software-Foundation/sci-ai, `SPEC.md`
