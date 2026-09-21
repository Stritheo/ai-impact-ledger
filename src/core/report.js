'use strict';

const crypto = require('node:crypto');
const { addEstimates, estimateEvent, formatAnalogy } = require('./estimate');
const {normaliseSettings, convertCost, convertWater, significant, fx} = require('./settings');
const {dailyKey} = require('./ledger');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

const dayFormatters = new Map();

function dayFormatter(timeZone) {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {year: 'numeric', month: '2-digit', day: '2-digit', timeZone});
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function todayLocal(timestamp = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function subtractCalendarDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - count);
  return date.toISOString().slice(0, 10);
}

function buildSummary(events, registry, locationContext, options = {}) {
  const settings = normaliseSettings({...options.settings, period: options.period || options.settings?.period});
  const now = options.now || new Date();
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = todayLocal(now, timeZone);
  const days = {today: 1, '7d': 7, '30d': 30, '90d': 90};
  const start = settings.period === 'cumulative' ? null : subtractCalendarDays(day, days[settings.period] - 1);
  const localised = events.map((event) => ({event, localDay: todayLocal(new Date(event.timestamp), timeZone)}));
  const selected = localised.filter(({localDay}) => localDay <= day && (!start || localDay >= start));
  const allRows = Object.values(options.daily || {});
  // Aggregates and detail are compared on the same basis: both carry a UTC date,
  // so a row supplies a day only when no detail exists for that UTC day. That
  // makes double counting impossible. A UTC day also straddles two local days,
  // so a row is admitted only from the second day of the period onwards: work
  // either side of the opening boundary cannot be told apart, while inside the
  // period both local days it touches belong to the period anyway. For a
  // single-day period this admits nothing, which is correct.
  // Detail is cut at an instant, not at midnight: a purge, a storage trim and
  // the retention cut-off all leave the day they fall in partly covered. The
  // presence of some detail for a day therefore does not mean the day is
  // complete, and that day must still be taken from its daily total.
  // Nothing said means detail is complete; something unreadable means the
  // opposite, because assuming completeness is how calls go missing.
  const declared = options.detailCompleteFrom;
  const completeFrom = declared === null || declared === undefined ? null
    : typeof declared === 'string' && Number.isFinite(Date.parse(declared)) ? new Date(declared).toISOString() : 'unknown';
  const dayIsComplete = (date) => completeFrom === null ? true
    : completeFrom === 'unknown' ? false : `${date}T00:00:00.000Z` >= completeFrom;
  // Coverage is judged per row, not per day: detail for one model says nothing
  // about another model on the same day.
  const coveredKeys = new Set(events.filter((item) => dayIsComplete(item.timestamp.slice(0, 10)))
    .map((item) => dailyKey(item.timestamp.slice(0, 10), item.provider, item.model, item.nonStandardTier)));
  const firstWholeDay = start ? subtractCalendarDays(start, -1) : null;
  // A local day maps onto two UTC days, so the totals that can supply the edges
  // of a window sit one UTC day either side of it. A day the detail does not
  // fully cover is taken from its total in any period, including today and the
  // opening day: losing most of a day is worse than a total whose UTC date
  // reaches a few hours either side, which is disclosed below. Interior days
  // keep the narrower rule, which cannot reach outside the period at all.
  const edgeStart = start ? subtractCalendarDays(start, 1) : null;
  const edgeEnd = subtractCalendarDays(day, -1);
  const dailyRows = settings.period === 'cumulative'
    ? allRows.filter((row) => row.date <= day)
    : allRows.filter((row) => {
      const covered = coveredKeys.has(dailyKey(row.date, row.provider, row.model, row.nonStandardTier));
      if (covered && dayIsComplete(row.date)) return false;
      const insidePeriod = row.date <= day && (!start || row.date >= start);
      if (insidePeriod) return !dayIsComplete(row.date) || !covered
        ? (!firstWholeDay || row.date >= firstWholeDay || !dayIsComplete(row.date)) : false;
      // An edge day, one UTC day either side of the window.
      return !dayIsComplete(row.date) && row.date >= edgeStart && row.date <= edgeEnd;
    });
  const dailyKeys = new Set(dailyRows.map((row) => dailyKey(row.date, row.provider, row.model, row.nonStandardTier)));
  const entries = [
    ...selected.map(({event}) => event)
      .filter((event) => !dailyKeys.has(dailyKey(event.timestamp.slice(0, 10), event.provider, event.model, event.nonStandardTier)))
      .map((event) => ({event, calls: 1})),
    ...dailyRows.map((row) => ({calls: row.calls, aggregate: true, event: {
      provider: row.provider, model: row.model, inferenceGeo: null,
      ...(row.nonStandardTier === true ? {nonStandardTier: true} : {}),
      tokens: {input: row.input, cachedInput: row.cachedInput, cacheWrite: row.cacheWrite,
        cacheWrite5m: row.cacheWrite5m, cacheWrite1h: row.cacheWrite1h,
        cacheWriteUnclassified: row.cacheWriteUnclassified !== undefined
          ? row.cacheWriteUnclassified
          : Math.max(0, (row.cacheWrite || 0) - (row.cacheWrite5m || 0) - (row.cacheWrite1h || 0)),
        output: row.output, reasoningOutput: row.reasoningOutput}
    }}))
  ];
  const estimates = entries.map(({event, aggregate}) => estimateEvent(event, registry, locationContext, {aggregate}));
  const processingLocations = {confirmed: 0, configured: 0, unknown: 0};
  for (let index = 0; index < entries.length; index += 1) {
    const state = estimates[index].processingLocation.state;
    processingLocations[state === 'confirmed' ? 'confirmed' : state === 'configured-not-verified' ? 'configured' : 'unknown'] += entries[index].calls;
  }
  const total = addEstimates(estimates);
  const providers = {};
  const models = {};
  for (const provider of ['anthropic', 'openai']) {
    const indices = entries.map(({event}, index) => event.provider === provider ? index : -1).filter((index) => index >= 0);
    const own = addEstimates(indices.map((index) => estimates[index]));
    providers[provider] = {
      calls: indices.reduce((sum, index) => sum + entries[index].calls, 0),
      tokens: indices.reduce((sum, index) => sum + ['input', 'cachedInput', 'cacheWrite', 'output'].reduce((value, field) => value + (entries[index].event.tokens[field] || 0), 0), 0),
      energyWh: own.energyWh.mid,
      costUsd: own.cost.central,
      unpricedCalls: indices.filter((index) => estimates[index].cost.central === null).reduce((sum, index) => sum + entries[index].calls, 0),
      legacyCacheCalls: indices.filter((index) => estimates[index].cost.reason === 'cache-duration-unavailable')
        .reduce((sum, index) => sum + entries[index].calls, 0),
      nonStandardTierCalls: indices.filter((index) => estimates[index].cost.reason === 'non-standard-tier')
        .reduce((sum, index) => sum + entries[index].calls, 0)
    };
    const byModel = new Map();
    for (const index of indices) {
      const {event, calls} = entries[index];
      const row = byModel.get(event.model) || {model: event.model, calls: 0, tokens: 0, energyWh: 0, costUsd: 0, unpricedCalls: 0};
      row.calls += calls;
      row.tokens += ['input', 'cachedInput', 'cacheWrite', 'output'].reduce((sum, field) => sum + (event.tokens[field] || 0), 0);
      row.energyWh += estimates[index].energyWh.mid;
      if (estimates[index].cost.central === null) row.unpricedCalls += calls;
      else row.costUsd += estimates[index].cost.central;
      byModel.set(event.model, row);
    }
    models[provider] = [...byModel.values()];
  }
  const periodStart = start || [...selected.map(({localDay}) => localDay), ...dailyRows.map((row) => row.date)].sort()[0] || day;
  return {day, start: periodStart, end: day, timeZone, period: settings.period, lastScanAt: now.toISOString(),
    calls: entries.reduce((sum, entry) => sum + entry.calls, 0),
    tokens: Object.values(providers).reduce((sum, provider) => sum + provider.tokens, 0),
    providers, models, total, analogy: formatAnalogy(total, registry),
    historicalUtc: dailyRows.length > 0,
    aggregateDays: settings.period !== 'cumulative' && dailyRows.length > 0,
    preCorrectionDays: dailyRows.some((row) => row.preCorrection === true),
    trimmedBefore: typeof options.trimmedBefore === 'string' ? options.trimmedBefore.slice(0, 10) : null,
    purgedBefore: typeof options.purgedBefore === 'string' ? options.purgedBefore.slice(0, 10) : null,
    // A total carries a UTC date, so a boundary day may reach either side of a
    // period whose days are local.
    boundaryDayFromTotals: Boolean(start) && dailyRows.some((row) => !dayIsComplete(row.date)
      && (row.date <= start || row.date >= day)),
    processingLocations,
    registryVersion: registry.version, registryReviewedAt: registry.reviewedAt,
    waterInterpretation: registry.water.contexts.unknown,
    waterConfidence: registry.water.confidence, settings};
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat('en-AU', {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(value || 0);
}

function formatCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return String(value || 'Unknown date');
  return new Intl.DateTimeFormat('en-AU', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'})
    .format(new Date(`${value}T12:00:00Z`));
}

function formatClock(timestamp, timeZone) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return 'time unavailable';
  try {
    return new Intl.DateTimeFormat('en-AU', {hour: 'numeric', minute: '2-digit', hour12: true, timeZone})
      .format(new Date(timestamp)).replace(/\u202f/g, ' ');
  } catch {
    return 'time unavailable';
  }
}

// Ranges only: no reviewed source supports a central figure, so the range is
// the figure. The unit follows the top of the range.
function rangeMetric(figures, threshold, divisor, unit) {
  const scale = figures.high >= threshold ? divisor : 1;
  const displayUnit = scale === 1 ? unit[0] : unit[1];
  return {
    range: `${significant(figures.low / scale)}–${significant(figures.high / scale)} ${displayUnit}`,
    unit: displayUnit
  };
}

function energyMetric(energyWh) {
  return rangeMetric(energyWh, 1000, 1000, ['Wh', 'kWh']);
}

// Status bar figures, at the same precision as the report.
function statusSummary(summary) {
  const energy = energyMetric(summary.total.energyWh);
  return {energy: energy.range, energyRange: energy.range};
}

function reportHtml(summary) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const settings = normaliseSettings(summary.settings);
  const providers = summary.providers || {};
  const unpricedCalls = (providers.anthropic?.unpricedCalls || 0) + (providers.openai?.unpricedCalls || 0);
  const legacyCacheCalls = (providers.anthropic?.legacyCacheCalls || 0) + (providers.openai?.legacyCacheCalls || 0);
  const nonStandardTierCalls = (providers.anthropic?.nonStandardTierCalls || 0) + (providers.openai?.nonStandardTierCalls || 0);
  const moneyValue = convertCost(summary.total.cost.central, settings.currency);
  const moneySymbol = {USD: 'US$', AUD: 'A$', GBP: '£', EUR: '€'}[settings.currency];
  const money = summary.total.hasUnknownCost && summary.calls === unpricedCalls
    ? 'Not available' : `${moneySymbol}${formatNumber(moneyValue.value, 2)}`;
  const unpricedNote = summary.total.hasUnknownCost
    ? unpricedCalls > 0
      ? `${formatNumber(Math.max(0, summary.calls - unpricedCalls))} priced ${summary.calls - unpricedCalls === 1 ? 'call' : 'calls'}; ${formatNumber(unpricedCalls)} ${unpricedCalls === 1 ? 'call has' : 'calls have'} no reference price or reconstructable cache duration${[
        legacyCacheCalls ? `${formatNumber(legacyCacheCalls)} with older cache-write detail unavailable` : '',
        nonStandardTierCalls ? `${formatNumber(nonStandardTierCalls)} at a price the reference rates do not cover: fast mode, a priority tier or a prompt above the provider's long-context size` : ''
      ].filter(Boolean).map((note) => ` (${note})`).join('')}.`
      : 'Some calls have no reference price; cost covers priced calls only.'
    : 'At reference API prices';
  const partialNote = summary.total.hasPartialCost
    ? ` ${formatNumber(summary.total.unclassifiedCacheWriteTokens)} earlier cache-write tokens have no recorded duration and are excluded from cost.`
    : '';
  const energy = energyMetric(summary.total.energyWh);
  const carbon = rangeMetric(summary.total.carbonGrams, 1000, 1000, ['g CO₂', 'kg CO₂']);
  const waterLow = convertWater(summary.total.water.low, settings.waterUnits);
  const waterHigh = convertWater(summary.total.water.high, settings.waterUnits);
  const waterRange = `${significant(waterLow.value)}–${significant(waterHigh.value)} ${waterHigh.unit}`;
  const waterNote = summary.total.water.low === 0 ? 'Lower bound not established' : 'Derived range';
  const measure = settings.contributionMeasure;
  const field = {energy: 'energyWh', cost: 'costUsd', tokens: 'tokens', calls: 'calls'}[measure];
  const claude = providers.anthropic?.[field] || 0;
  const codex = providers.openai?.[field] || 0;
  const denominator = claude + codex;
  const claudeShare = denominator ? 100 * claude / denominator : 0;
  const codexShare = denominator ? 100 - claudeShare : 0;
  const shareBasis = measure === 'energy' ? '<p class="muted">Energy shares use the midpoint of each range.</p>' : '';
  const costCaveat = measure === 'cost' && unpricedCalls
    ? '<p class="muted">Cost shares exclude calls without a reference price.</p>' : '';
  const modelRows = ['anthropic', 'openai'].map((provider) => {
    const label = provider === 'anthropic' ? 'Claude' : 'Codex';
    const rows = [...(summary.models?.[provider] || [])].sort((a, b) => b[field] - a[field]);
    const ownTotal = rows.reduce((sum, row) => sum + row[field], 0);
    return rows.length ? `<h3>${label}</h3><table><thead><tr><th scope="col">Model</th><th scope="col">${escapeHtml(measure)} share within ${label}</th></tr></thead><tbody>${rows.map((row) => {
      const share = ownTotal ? 100 * row[field] / ownTotal : 0;
      const caveat = measure === 'cost' && row.unpricedCalls ? ' (some calls have no reference price)' : '';
      return `<tr><td>${escapeHtml(row.model)}</td><td>${share.toFixed(1)}%${caveat}</td></tr>`;
    }).join('')}</tbody></table>` : '';
  }).join('');
  const drilldown = modelRows ? `<details><summary>Show model contribution</summary><p class="muted">The percentages below divide each provider's share between its models; they are not extra impact.</p>${modelRows}</details>` : '';
  const contribution = summary.providers ? `<h2>Claude and Codex contribution</h2><p class="muted">${escapeHtml(measure)} share of this period</p><div class="bar" role="img" aria-label="Claude ${claudeShare.toFixed(1)} percent; Codex ${codexShare.toFixed(1)} percent"><span id="contribution-claude" class="bar-segment claude"></span><span id="contribution-codex" class="bar-segment codex"></span></div><p class="legend"><span class="key claude"></span>Claude ${claudeShare.toFixed(1)}% · <span class="key codex"></span>Codex ${codexShare.toFixed(1)}%</p>${shareBasis}${costCaveat}${drilldown}` : '';
  const zone = summary.timeZone || 'Local time';
  const staleNote = summary.stale
    ? '<p role="alert">These figures could not be updated on the last check and may be out of date. The status bar shows the same.</p>'
    : '';
  const pausedNote = summary.downgraded
    ? '<p class="warn">Counting is paused. Another VS Code window is running an older version of this extension and has rewritten these records in an older format, so the figures below may be wrong. Close that window or reload it, reload this one, then run the "AI Impact Ledger: Rebuild From Logs" command.</p>'
    : '';
  const period = summary.period === 'cumulative'
    ? `${zone} · Everything recorded, to ${formatCalendarDay(summary.end)} · last checked ${formatClock(summary.lastScanAt, zone)}`
    : summary.period === 'today' || (!summary.start && summary.day) || (summary.start && summary.start === summary.end)
    ? `${zone} · Today, ${formatCalendarDay(summary.day)} · from midnight to last check at ${formatClock(summary.lastScanAt, zone)}`
    : `${zone} · ${formatCalendarDay(summary.start)}–${formatCalendarDay(summary.end)} · last checked ${formatClock(summary.lastScanAt, zone)}`;
  const historicalNote = summary.historicalUtc ? '<p>Historical daily totals use UTC dates; cumulative boundaries may differ from your local calendar day.</p>' : '';
  const aggregateNote = summary.aggregateDays
    ? '<p>Detailed records do not cover the whole period, so earlier days in this period come from daily totals. Those days use UTC dates and cannot be split by hour.</p>'
    : '';
  const preCorrectionNote = summary.preCorrectionDays
    ? '<p>Some days are shown as they were recorded, because the current logs no longer reproduce them. Days recorded before the counting correction of 16 September 2026 understate Codex activity.</p>'
    : '';
  const purgedNote = summary.purgedBefore
    ? `<p>Detailed records before ${escapeHtml(formatCalendarDay(summary.purgedBefore))} were deleted. Those days are reported from daily totals.</p>`
    : '';
  const boundaryNote = summary.boundaryDayFromTotals
    ? '<p>A day at the edge of this period comes from a daily total, which is recorded on a UTC date, so it may include work from just outside the period.</p>'
    : '';
  const trimmedNote = summary.trimmedBefore
    ? `<p>To stay within its 64 MiB storage limit, the ledger removed detailed records up to ${escapeHtml(formatCalendarDay(summary.trimmedBefore))}. Those days come from daily totals.</p>`
    : '';
  const locationCounts = summary.processingLocations || {confirmed: 0, configured: 0, unknown: summary.calls};
  const locationNote = `<p>Processing location: ${formatNumber(locationCounts.unknown)} ${locationCounts.unknown === 1 ? 'call' : 'calls'} unknown, ${formatNumber(locationCounts.confirmed)} with a confirmed region, ${formatNumber(locationCounts.configured)} with a configured region that is not verified per call. None identifies a facility, water source or community.</p>`;
  const waterContext = summary.waterInterpretation ? `<p>Data-centre location and water source are unknown. ${escapeHtml(summary.waterInterpretation)} Confidence: ${escapeHtml(summary.waterConfidence)}. Infrastructure location is not verified.</p>` : '';
  const analogy = settings.showAnalogy && settings.analogyFamily !== 'none' ? `<h2>In everyday terms</h2><p>${escapeHtml(summary.analogy)}</p>` : '';
  const monitor = summary.monitor
    ? `${summary.monitor.filesSkipped ? `<p role="alert">${summary.monitor.filesSkipped} log file skipped; totals may be incomplete.</p>` : ''}${summary.monitor.linesSkipped ? `<p role="alert">${summary.monitor.linesSkipped} log line skipped; totals may be incomplete.</p>` : ''}${summary.monitor.recordsSkipped ? `<p role="alert">${summary.monitor.recordsSkipped} malformed usage record skipped; totals may be incomplete.</p>` : ''}${summary.monitor.schemaUnknown ? `<p role="alert">${formatNumber(summary.monitor.schemaUnknown)} usage record(s) are in a format this version does not recognise, so totals are incomplete. The provider may have changed its log format.</p>` : ''}${summary.monitor.unmatchedLegacyRecords ? `<p role="alert">${formatNumber(summary.monitor.unmatchedLegacyRecords)} earlier usage record(s) could not be matched to a current record and are not counted; totals may be incomplete.</p>` : ''}<p class="muted">Last check took ${formatNumber(summary.monitor.durationMs, 0)} ms. The ledger made no AI calls; its computer electricity and water use have not been measured. It read ${formatNumber(summary.monitor.filesRead)} changed files and skipped ${formatNumber(summary.monitor.unchangedFiles)} unchanged files.</p>`
    : '';
  const stylesheet = `body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:28px;max-width:760px;line-height:1.5}h1{font-size:24px;margin-bottom:6px}h2{margin-top:30px}.intro{margin-top:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:20px}.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;min-width:0}.value{font-size:20px;overflow-wrap:anywhere}.muted{color:var(--vscode-descriptionForeground)}.warn{border:1px solid var(--vscode-inputValidation-warningBorder,#c93);border-radius:6px;padding:10px;margin-top:14px}.bar{display:flex;height:12px;border-radius:8px;overflow:hidden;background:var(--vscode-panel-border)}.bar-segment{display:block;height:100%}#contribution-claude{width:${claudeShare.toFixed(2)}%}#contribution-codex{width:${codexShare.toFixed(2)}%}.claude.bar-segment,.claude.key{background:var(--vscode-charts-blue,#4e9cf6)}.codex.bar-segment,.codex.key{background:var(--vscode-charts-orange,#f0a44c)}.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}.legend{display:flex;align-items:center;gap:4px}details{margin-top:14px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;width:50%;padding:6px;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}a{color:var(--vscode-textLink-foreground)}@media(max-width:520px){.grid{grid-template-columns:1fr}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><style nonce="${nonce}">${stylesheet}</style></head><body><h1>AI Impact Ledger</h1><p class="intro">A dashboard to track the cost and impacts of your AI work. You choose what to monitor in the <a href="command:aiImpactLedger.openSettings">settings</a> and learn how to draw insights in <a href="#how-to">How to read this report</a>.</p><p class="muted">${escapeHtml(period)}</p>${staleNote}${pausedNote}<p>${formatNumber(summary.calls)} model ${summary.calls === 1 ? 'call' : 'calls'} · ${formatNumber(summary.tokens)} tokens</p><div class="grid"><div class="card"><div>Cost at reference API prices</div><div class="value">${escapeHtml(money)}</div><div class="muted">${escapeHtml(`${unpricedNote}${partialNote}`)}</div></div><div class="card"><div>Energy</div><div class="value">${escapeHtml(energy.range)}</div><div class="muted">Derived range; excludes the energy of re-reading cached context</div></div><div class="card"><div>On-site cooling water</div><div class="value">${escapeHtml(waterRange)}</div><div class="muted">${escapeHtml(waterNote)}</div></div><div class="card"><div>Carbon</div><div class="value">${escapeHtml(carbon.range)}</div><div class="muted">Derived range</div></div></div>${contribution}${analogy}<section id="how-to"><h2>How to read this report</h2><p>These are estimates of the work involved in answering your AI calls (inference operations only), not a bill or a full lifecycle assessment. This is an API-equivalent estimate: what the same recorded tokens would cost at reference per-token prices. A subscription, discounts or credits can make your actual payment different. Calls without a reference price still count towards tokens and environmental estimates. Older stored cache-write totals without duration are also excluded from cost rather than guessed.</p><h3>How the calculations work</h3><p>We count recorded model calls and tokens, then apply reviewed reference API prices and derived energy ranges. No published source measures Claude or Codex electricity, so the energy figures are ranges derived from measurements of comparable open models, scaled to whole-facility electricity. There is no defensible single figure, so none is shown. The range excludes the energy of re-reading cached context, which is most of the tokens recorded here and may be material. Water is applied to IT-equipment electricity and carbon to whole-facility electricity, following each source's own basis. These are derived ranges, not a statistical confidence interval.</p><p>Where one number is needed, for the everyday comparison and the Claude and Codex share, we use the midpoint of the range and say so.</p><p>The water figure covers on-site cooling. Water used in electricity generation is not included, so a zero cooling-water assumption does not mean no water was used overall. We do not know which data centre handled a call or where its water came from.</p>${locationNote}${waterContext}${historicalNote}${aggregateNote}${purgedNote}${boundaryNote}${trimmedNote}${preCorrectionNote}<p>Everyday comparisons are illustrations, not lifecycle equivalents. Sources reviewed ${escapeHtml(formatCalendarDay(summary.registryReviewedAt || summary.registryVersion))}; reference exchange rate dated ${escapeHtml(formatCalendarDay(fx.sourceDate))}, for display only.</p></section>${monitor}</body></html>`;
}

module.exports = { buildSummary, reportHtml, statusSummary, todayLocal };
