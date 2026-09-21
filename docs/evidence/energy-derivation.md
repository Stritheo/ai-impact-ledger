# Energy derivation for token-class coefficients

Date: 17 September 2026. Sprint item: Track 2.1 (finding F-02), with Track 2.2
(water boundary). Status: **reviewed and approved by the owner on 18 September
2026. Option 1 of section 8 is implemented: ranges only, with the
cached-context cost stated as excluded.**

Corrected on 18 September 2026 after independent verification. The changes are
listed in section 10.

## 1. Conclusion

No primary source supports a defensible **central** energy figure per token
for Claude or Codex. Anthropic and OpenAI publish neither per-token energy nor
the facts needed to derive it (model size, hardware, batch size, utilisation,
cache handling). What primary sources do measure is open models on known
hardware, and those measurements vary more than tenfold with batch size and
hardware for the same model.

The current coefficients (fresh input 0.39, cached input 0.015, cache write
0.49, output 1.4 Wh per 1,000 tokens) have no primary-source derivation. On the
owner's logs they give 147.5 kWh, with 38.5 per cent of that from the cached
input coefficient, which no approved source measures.

Recommendation: show energy, water and carbon as **ranges only**, built from
the measured open-model evidence below, labelled as such, with the cost of
re-reading cached context stated as not included.

## 2. What a defensible coefficient would need

For each token class: a measured energy per token for the model family in
question, on its production hardware, at production utilisation, with a stated
boundary (accelerator only, whole server, or whole facility). None of these is
published for Claude or GPT-5.6. Everything below is therefore a transfer from
other models, and section 6 states what the transfer does not cover.

## 3. Sources

All retrieved 17 September 2026 from approved domains. Hashes are of the PDF
files served at `arxiv.org/pdf/<id>` and of the LBNL PDF itself, not of the
abstract pages linked below, so a second reader can confirm they read the same
bytes. The monthly evidence check hashes the abstract pages instead, so its
recorded hashes differ by design.

| ID | Source | Publisher, date | SHA-256 of retrieved file |
|---|---|---|---|
| S1 | [The ML.ENERGY Benchmark](https://arxiv.org/abs/2505.06371) (PDF, 29 pages) | Chung et al., arXiv 2505.06371 | `9583e03c1c4ed2dc880cce87a7b6de06ce1bfd7ef8d57f39793a9d32ac13aaa5` |
| S2 | [ML.ENERGY Leaderboard data](https://ml.energy/leaderboard/) (`data/index.json`, `data/tasks/lm-arena-chat.json`, `gpqa.json`, `sourcegraph-fim.json`) | ML.ENERGY, data last updated 16 February 2026 | index `b638d291…ac65`; chat `24e25d46…a7ec`; gpqa `792582ef…32dc`; fim `e74db077…7034` |
| S3 | [Measuring the environmental impact of delivering AI at Google Scale](https://arxiv.org/abs/2508.15734) (PDF, 10 pages) | Elsworth et al. (Google), arXiv 2508.15734, 21 August 2025 | `348b58c832076258e1792a710fab3f0ac60f02001857532a7136771b52b30339` |
| S4 | [2024 United States Data Center Energy Usage Report](https://eta-publications.lbl.gov/sites/default/files/2024-12/us_data_center_energy_usage_report_lbnl-2001637_0.pdf) | Lawrence Berkeley National Laboratory, December 2024 | `791f95feb348b406f0817bca11a65a9147883ade988c7426ebc4e28bfe35a3c5` |

Not used: the current coefficients' upstream repository (github.com is not an
approved research domain, and the review already established it gives no
derivation); IEA Energy and AI (secondary to S1 and S3 for this question, and
it refuses automated clients).

### Figures taken from each source

- **S1, Table 4** (page 25; Llama 3.1 70B at tensor parallelism 4, deployed as
  one prefill and one decode instance, so 8 GPUs; the table does not state the
  GPU generation, and the paper uses H100 elsewhere; GPU energy only; J per
  generation, decode share):
  input mean 512 / output mean 512: 276.93 J, 64.8 per cent;
  512 / 4,096: 907.60 J, 89.2 per cent;
  4,096 / 512: 1,492.59 J, 50.0 per cent.
- **S1, method** (section 3): energy per request is steady-state energy per
  output token times output tokens, so prefill energy is folded into the
  per-output-token figure.
- **S2**, `energy_per_token_joules` for configurations of models with at least
  100 billion total parameters whose maximum batch is at least 64 sequences
  (GPU energy only, prefill folded in as above). That filter is a proxy for
  well-utilised serving, not a statement about any provider's production batch
  sizes:

  | Task | Configurations | P10 | P25 | Median | P75 | P90 |
  |---|---:|---:|---:|---:|---:|---:|
  | lm-arena-chat | 82 | 0.421 | 0.612 | 0.964 | 1.506 | 2.378 |
  | gpqa | 51 | 0.061 | 0.099 | 0.268 | 1.199 | 1.811 |
  | sourcegraph-fim | 17 | 1.525 | 3.052 | 5.274 | 7.572 | 11.715 |

  Models: Qwen 3 235B, Qwen 3 Coder 480B, DeepSeek V3.1 and R1 (671B),
  Llama 3.1 405B, Llama 4 Maverick (400B) and Scout (109B), GPT OSS 120B
  (117B, and not in the chat subset); B200 and H100 GPUs.
  Percentiles use linear interpolation between ranked values.
- **S3, Table 1 and section 4.1**: median Gemini Apps text prompt, May 2025,
  comprehensive approach 0.24 Wh: active accelerators 0.14, host CPU and DRAM
  0.06, idle machines 0.02, overhead 0.02. "A scaling of 1.72 would need to be
  applied to active AI accelerator energy consumption to include the energy
  consumed in a production serving environment, compared to a 2 times scaling
  from existing estimates." Fleet PUE 1.09. Water is calculated as (total
  energy − overhead energy) × WUE, and Google's own WUE "for both 2023 and
  2024" was "1.15 L/kWh".
- **S4, page 38**: "Water Usage Effectiveness is similarly defined as the total
  water consumption of the data center divided by the electricity demand of the
  IT equipment." **Page 47**: average PUE "falls from 1.6 in 2014 to 1.4 in
  2023". **Page 48**: average WUE "stays just over 0.36 L/kWh through 2023",
  then "between 0.45 and 0.48 L/kWh" by 2028.

## 4. Conversions and boundary

- J per token to Wh per 1,000 tokens: multiply by 1000 / 3600 = 0.2778.
- Multipliers are rounded to two decimal places before use, and the result to
  three. Carrying full precision instead moves the fresh-input low bound from
  0.086 to 0.087, which is within the rounding of a range this wide.
- **GPU to IT equipment** (servers, including host and provisioned idle
  capacity): S3 gives (0.24 − 0.02) / 0.14 = **1.571**.
- **IT equipment to whole facility**: multiply by PUE. Low 1.09 (S3, Google
  fleet); high 1.40 (S4, US average 2023).
- **GPU to whole facility**: low 1.571 × 1.09 = **1.71** (matches S3's 1.72);
  high 1.571 × 1.40 = **2.20**.

This fixes the boundary question raised by the review (Track 2.2):

- **Water** is defined per kWh of IT equipment electricity (S4, and S3 applies
  it the same way). It must be applied to IT energy, not facility energy. Each
  energy bound is divided by the overhead multiplier it was derived with, not
  by the other one, or the range would be wider than the derivation supports.
- **The water high bound is Google's 1.15 L/kWh (S3), not LBNL's 0.48.** S4's
  figure is a United States fleet average across all data centres; S3's is the
  fleet actually serving a production AI product, and it is 2.4 times higher.
  S4 also notes its hyperscale category may be understated. 0.36 (S4) remains
  the midpoint and zero the unestablished lower bound.
- The bounds mix years: PUE 1.40 is S4's 2023 average, while S4 projects 1.15
  to 1.35 by 2028. Both choices are conservative in the same direction.
- **Carbon** from grid electricity applies to all electricity the facility
  draws, so it must be applied to facility energy.
- The dashboard's energy figure should be facility energy, since that is what
  the grid supplies.

The current code applies water and carbon to the same energy figure, with no
stated boundary. Under this derivation, water = facility energy ÷ PUE × WUE.

## 5. Token classes

Figures below are **facility** Wh per 1,000 tokens: low uses the low source
value × 1.71, high uses the high source value × 2.20.

### Output tokens

- **Source:** S2, lm-arena-chat, P10 0.421 and P90 2.378 J per output token.
  Chat is chosen because its prompts are short, so least prefill is folded in.
- **Arithmetic:** low 0.421 × 1.71 × 0.2778 = **0.20**; high 2.378 × 2.20 ×
  0.2778 = **1.45**.
- **Boundary:** facility.
- **Confidence:** low.
- **Transfer:** measured on open models of 120B to 671B parameters; Claude and
  GPT-5.6 sizes and hardware are not published. The chat figures still carry
  some prefill.

### Fresh input tokens

- **Source:** S1, Table 4: prefill energy per input token from the three
  workloads: 276.93 × 0.352 / 512 = **0.190**; 907.60 × 0.108 / 512 =
  **0.191**; 1,492.59 × 0.500 / 4,096 = **0.182** J.
- **Arithmetic:** low 0.182 × 1.71 × 0.2778 = **0.086**; high 0.191 × 2.20 ×
  0.2778 = **0.117**.
- **Boundary:** facility.
- **Confidence:** low.
- **Transfer:** one dense 70B model on H100. The range reflects boundary only,
  not model scale, so it is narrower than the real uncertainty. Larger models,
  or ones on less efficient hardware, would sit higher.

### Cache-write tokens

- **Source:** none measures cache writes separately. Writing a prompt to the
  cache means running prefill over it, then storing the result.
- **Derivation:** the same as fresh input: **0.086 to 0.117**. Storage energy
  is not measured and is excluded.
- **Confidence:** low.
- **Why the current 0.49 is rejected:** it exceeds fresh input (0.39) by the
  same 1.25 ratio as the price. Price is not energy, and no source gives a
  physical reason for writes to cost more energy than prefill.

### Cached input tokens

- **Source:** none of S1 to S4 measures reading from a prompt cache. A cache
  read skips prefill. What remains is the cost of attending over the cached
  context while generating output, plus holding the cache in memory.
- **Evidence of the effect:** S1, Table 4: decode energy per output token rises
  from 179.45 / 512 = **0.350** J (512-token prompts) to 746.30 / 512 =
  **1.458** J (4,096-token prompts). The three columns differ in their input
  and output length distributions, so the rise mixes context length with output
  length and is not a clean measurement of context cost.
- **Why no coefficient is derived:**
  - The effect scales with output length as well as context length, so it is
    not a per-cached-token constant.
  - Extending a 512-to-4,096-token trend to the 100,000-token contexts in
    Claude Code sessions would be extrapolation far beyond the data.
- **Conclusion:** lower bound **0**; upper bound **not established**.
- **Confidence:** none for a number. The current 0.015 has no source.

## 6. What this does not cover

- Model scale and architecture of Claude and GPT-5.6, and whether they are
  mixture-of-experts models.
- Production hardware: TPU, Trainium or other accelerators, and newer
  generations than B200.
- Provider batch sizes and utilisation.
- Speculative decoding.
- The cost of long cached contexts (section 5).
- Networking, training, embodied emissions and end-user devices. The existing
  boundary, "inference operations only", already excludes these.

## 7. Effect on the owner's usage

**Basis:** the owner's logs scanned on 18 September 2026 at 07:50 UTC, counts
only. Totals grow between scans as work continues, so figures taken minutes
apart differ; this scan saw 18,053 calls, while the reconciliation record of 17
September saw 17,857. Token totals by class, which make every figure below
reproducible:

| Class | Tokens | Share |
|---|---:|---:|
| Fresh input | 10,663,029 | 0.27% |
| Cached input | 3,870,237,988 | 96.22% |
| Cache write | 119,978,260 | 2.98% |
| Output | 21,381,936 | 0.53% |
| Total | 4,022,261,213 | 100% |

| Basis | Energy |
|---|---|
| Superseded coefficients, central (range ÷3 to ×3) | 150.9 kWh (50.3 to 452.7) |
| Section 5 ranges, cached input excluded | 15.5 to 46.3 kWh |

Multiply each class's tokens by its coefficient and divide by 1,000 to check
either row. The difference comes almost entirely from two changes: the cached
input coefficient is removed, and it was 38.5 per cent of the superseded central
figure; and cache writes fall from 0.49 to about 0.1 Wh per 1,000 tokens.

The evidence-based range is lower, but its upper end is **open**, because cached
context has a real cost this evidence cannot size.

### A cross-check the ranges pass

S3 measures 0.24 Wh for a median production prompt. Dividing by the midpoint of
the derived output range, 0.825 Wh per 1,000 tokens, implies about 291 output
tokens for that prompt, which is a plausible median for an assistant reply. The
only production measurement available does not contradict the range.

### What the code-completion figures would imply

S2's `sourcegraph-fim` task is the closest workload in the evidence to an agent
reading a large context and writing a little: its measured P10 to P90 is 1.525
to 11.715 J per output token, which is 0.72 to 7.16 Wh per 1,000 tokens at the
facility boundary, three to five times the chat figures used for output above.
That is not used here, for two reasons. It measures fresh prefill of a long
prompt, not the re-reading of a cache, so it is an envelope rather than an
estimate. And it is expressed per output token, so applying it would attribute
the cost of a long prompt to a handful of output tokens, which is the very
confusion section 5 avoids by keeping the classes apart.

It does, though, put a shape on what is excluded: a workload of this kind can
cost several times the chat-derived output figure once the prompt is counted.
That supports the decision to publish the exclusion prominently rather than to
imply the upper bound is real.

## 8. Decision for the owner

1. **Recommended: ranges only, cached-context cost stated as not included.**
   - **Status bar and report:** show "15–45 kWh" style ranges, with "excludes
     the energy of re-reading cached context, which may be material".
   - **Water:** facility energy ÷ PUE × WUE, applied to both ends of the range.
   - **Carbon:** facility energy × grid intensity.
   - **Analogy and energy share:** use the range midpoint, labelled as such.
   - **Registry:** holds the section 5 low and high values, with this document
     as the evidence.
2. **Ranges only, with an illustrative cached-context upper bound** taken from
   the S1 trend. Rejected: it rests on extrapolating 4K-token data to
   100K-token contexts.
3. **Keep the current coefficients with stronger caveats.** Rejected by the
   sprint plan: the gate asks for derivation, not disclosure.
4. **Remove energy, water and carbon until providers publish.** Not
   recommended: it removes the product's purpose. It remains the fallback if
   option 1 is judged still too uncertain to show.

## 9. Reproducing this derivation

- **Downloads:** fetch S1, S3 and S4 and confirm their hashes. The S4 server
  refused a plain `curl` request on 17 September.
- **Text extraction:** `pdftotext -layout` gives the passages quoted above
  (S1 Table 4 is on page 24; S4 is on pages 38 and 47).
- **S2 percentiles:** fetch the three task files from
  `https://ml.energy/leaderboard/data/tasks/`. Keep configurations with
  `total_params_billions >= 100` and `max_num_seqs >= 64`, then take
  percentiles of `energy_per_token_joules`.
- **Arithmetic:** every figure in sections 4 and 5 is shown in full above.

## 10. Corrections after independent verification, 18 September 2026

A session with no part in writing this document re-derived it from the sources.
It confirmed all four file hashes, every quotation, the S2 percentiles and all
of the arithmetic in sections 4 and 5. The following were corrected:

- **Astra's long-context rule.** The registry recorded that OpenAI states no
  long-context modifier for Astra. Astra's own model page states the same 272K
  rule as Sol and Terra, and doubles cache rates as well as input. The earlier
  check used the model comparison page, which omits it. Astra prompts above
  272K would have been priced at standard rates, and are now left unpriced.
- **Water bounds.** The high bound was LBNL's 2028 projection of 0.48 L/kWh.
  Google reports 1.15 L/kWh for the fleet serving its AI products, the only
  production AI measurement in the evidence base, and that is now the high
  bound. Each energy bound is also divided by the overhead multiplier it was
  derived with, rather than by the other one, which had inflated the upper
  water figure by about 28 per cent.
- **Source attribution.** The benchmark paper now has its own evidence entry,
  rather than sharing the leaderboard's entry with a different URL, publisher
  and date, and it is covered by the monthly evidence check.
- **Cached input.** The registry records that its zero is an exclusion, not a
  measurement, and that the published range is therefore not an upper bound on
  total energy. The security gate fails if that is ever dropped.
- **Quotation and locators.** The S3 quotation carries its full sentence; the
  LBNL WUE figures are on page 48, not 47; S1 Table 4 is on page 25; its
  deployment is 8 GPUs, not 4, and the table does not state the GPU generation;
  the chat subset spans 109B to 671B parameters.
- **Section 7** now records the token totals by class, so every figure can be
  reproduced, and states that totals grow between scans.
- **Wording.** "Production batch sizes" became the filter actually applied; the
  unsupported caveat about batch sizes differing between Table 4's columns was
  removed; the hash basis is stated.

Findings raised and not acted on: none.
