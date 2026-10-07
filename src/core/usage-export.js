'use strict';

const {estimateEvent} = require('./estimate');
const {mergeEvents} = require('./ledger');
const {todayLocal, subtractCalendarDays} = require('./report');

const SCHEMA = 'ai-impact-ledger.usage-export.v1';
const FIVE_HOURS_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;
const PROVIDERS = ['anthropic', 'openai'];
const TOKEN_CLASSES = ['input', 'cachedInput', 'cacheWrite', 'output'];
const WINDOW_NAMES = ['fiveHours', 'day', 'week', 'month'];
const LOCAL_DAYS = 'local calendar days';

function windowBounds(now, timeZone) {
  const day = todayLocal(now, timeZone);
  return {
    fiveHours: {from: new Date(now.getTime() - FIVE_HOURS_MS).toISOString(), to: now.toISOString(), basis: 'rolling'},
    day: {from: day, to: day, basis: LOCAL_DAYS},
    // The same seven days as the report's "7d" period.
    week: {from: subtractCalendarDays(day, 6), to: day, basis: LOCAL_DAYS},
    month: {from: `${day.slice(0, 8)}01`, to: day, basis: LOCAL_DAYS}
  };
}

// The earliest instant any window can reach, with two days of margin because a
// local day starts up to fourteen hours either side of its UTC date.
function scanFloor(now, timeZone) {
  const {week, month} = windowBounds(now, timeZone);
  const earliest = week.from < month.from ? week.from : month.from;
  return Date.parse(`${earliest}T00:00:00Z`) - 2 * DAY_MS;
}

function emptyFigures() {
  return {calls: 0, tokens: {input: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0},
    costUsd: 0, unpricedCalls: 0, unpricedTokens: 0};
}

function emptyWindow() {
  return {...emptyFigures(), byProvider: Object.fromEntries(PROVIDERS.map((provider) => [provider, emptyFigures()]))};
}

function emptyWindows() {
  return Object.fromEntries(WINDOW_NAMES.map((name) => [name, emptyWindow()]));
}

function add(figures, event, cost) {
  let total = 0;
  for (const tokenClass of TOKEN_CLASSES) {
    const count = event.tokens[tokenClass] || 0;
    figures.tokens[tokenClass] += count;
    total += count;
  }
  figures.calls += 1;
  figures.tokens.total += total;
  if (cost === null) {
    figures.unpricedCalls += 1;
    figures.unpricedTokens += total;
  } else figures.costUsd += cost;
}

function addToWindow(window, event, cost) {
  add(window, event, cost);
  if (window.byProvider[event.provider]) add(window.byProvider[event.provider], event, cost);
}

function roundCosts(window) {
  for (const figures of [window, ...Object.values(window.byProvider)]) {
    figures.costUsd = Math.round(figures.costUsd * 1e6) / 1e6;
  }
}

function buildUsageExport(events, registry, options = {}) {
  const now = options.now || new Date();
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const windows = windowBounds(now, timeZone);
  const rollingFrom = Date.parse(windows.fiveHours.from);
  const merged = mergeEvents(events);
  const totals = emptyWindows();
  const projects = {};
  let unattributedCalls = 0;
  for (const event of merged) {
    const at = Date.parse(event.timestamp);
    if (!(at <= now.getTime())) continue;
    const localDay = todayLocal(new Date(at), timeZone);
    const inside = WINDOW_NAMES.filter((name) => name === 'fiveHours'
      ? at >= rollingFrom
      : localDay >= windows[name].from && localDay <= windows[name].to);
    if (inside.length === 0) continue;
    // Priced exactly as the report prices a call: a call the registry cannot
    // price defensibly stays unpriced and is counted as such.
    const cost = estimateEvent(event, registry).cost.central;
    const key = typeof event.project === 'string' ? event.project : 'unattributed';
    if (key === 'unattributed') unattributedCalls += 1;
    projects[key] ||= emptyWindows();
    for (const name of inside) {
      addToWindow(totals[name], event, cost);
      addToWindow(projects[key][name], event, cost);
    }
  }
  for (const windowSet of [totals, ...Object.values(projects)]) Object.values(windowSet).forEach(roundCosts);
  return {
    schema: SCHEMA,
    generatedAt: now.toISOString(),
    timeZone,
    scope: 'Calls recorded in local Claude Code and Codex logs on this machine. Use of the same plans on the web, desktop or phone is not here, so these are partial counts, not a plan-limit reading.',
    tokenBasis: 'total is input + cachedInput + cacheWrite + output; reasoning tokens are part of output.',
    cost: {currency: 'USD',
      basis: 'API-price equivalent at registry prices as reviewed: not an invoice, not historical event-time prices. A call that cannot be priced defensibly is counted as unpriced, never guessed.',
      registryVersion: registry.version, registryReviewedAt: registry.reviewedAt, registryNextReviewDue: registry.nextReviewDue},
    projectKey: 'SHA-256 of "ai-impact-ledger/project/v1:" followed by the absolute folder the session started in. "unattributed" holds calls whose session recorded no folder.',
    windows,
    totals,
    projects,
    coverage: {...options.coverage, duplicateCalls: events.length - merged.length, unattributedCalls}
  };
}

module.exports = {buildUsageExport, scanFloor, SCHEMA};
