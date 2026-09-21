'use strict';

function usageScore(event) {
  const tokens = event?.tokens || {};
  return (tokens.input || 0) + (tokens.cachedInput || 0) + (tokens.cacheWrite || 0) + (tokens.output || 0);
}

// One call can be recorded in more than one place, for instance when a session
// is resumed into a new file. The record showing the most usage wins; equal
// usage is settled by the earlier record and then by model name, so the result
// never depends on the order the files were scanned.
function supersedes(candidate, current) {
  const difference = usageScore(candidate) - usageScore(current);
  if (difference !== 0) return difference > 0;
  const byTime = String(candidate.timestamp).localeCompare(String(current.timestamp));
  if (byTime !== 0) return byTime < 0;
  return String(candidate.model).localeCompare(String(current.model)) < 0;
}

// A daily row holds one pricing tier. Non-standard-tier calls get their own
// row, so a day's standard calls can still be priced.
function dailyKey(date, provider, model, nonStandardTier) {
  return `${date}|${provider}|${model}${nonStandardTier === true ? '|non-standard' : ''}`;
}

function mergeEvents(...collections) {
  const events = new Map();
  for (const collection of collections) {
    for (const event of collection || []) {
      if (!event?.id) continue;
      const previous = events.get(event.id);
      const flagged = event.nonStandardTier === true || previous?.nonStandardTier === true;
      const chosen = !previous || supersedes(event, previous) ? event : previous;
      events.set(event.id, flagged && chosen.nonStandardTier !== true ? {...chosen, nonStandardTier: true} : chosen);
    }
  }
  return [...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function applyRetention(events, days, now = new Date()) {
  const cutoff = now.getTime() - days * 86_400_000;
  return events.filter((event) => Date.parse(event.timestamp) >= cutoff);
}

function afterTimestamp(events, timestamp) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return events;
  const cutoff = Date.parse(timestamp);
  return events.filter((event) => Date.parse(event.timestamp) > cutoff);
}

function emptyTotals() {
  return {calls: 0, input: 0, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoningOutput: 0};
}

const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'output', 'reasoningOutput'];

function aggregateByDay(events) {
  const days = {};
  for (const event of events) {
    const date = event.timestamp.slice(0, 10);
    const key = dailyKey(date, event.provider, event.model, event.nonStandardTier);
    const total = days[key] ||= {date, provider: event.provider, model: event.model,
      ...(event.nonStandardTier === true ? {nonStandardTier: true} : {}), ...emptyTotals()};
    total.calls += 1;
    for (const field of TOKEN_FIELDS) {
      total[field] += event.tokens[field] || 0;
    }
  }
  return days;
}

function updateDaily(previousDaily, previousDetail, incoming) {
  const days = Object.fromEntries(Object.entries(previousDaily || {}).map(([key, value]) => [key, {...value}]));
  const seen = new Map((previousDetail || []).map((item) => [item.id, item]));
  const emptied = new Set();
  for (const event of mergeEvents(incoming)) {
    const prior = seen.get(event.id);
    if (prior && JSON.stringify(prior) === JSON.stringify(event)) continue;
    for (const [item, sign] of [[prior, -1], [event, 1]]) {
      if (!item) continue;
      const date = item.timestamp.slice(0, 10);
      const key = dailyKey(date, item.provider, item.model, item.nonStandardTier);
      const total = days[key] ||= {date, provider: item.provider, model: item.model,
        ...(item.nonStandardTier === true ? {nonStandardTier: true} : {}), ...emptyTotals()};
      total.calls = Math.max(0, total.calls + sign);
      for (const field of TOKEN_FIELDS) {
        total[field] = Math.max(0, total[field] + sign * (item.tokens[field] || 0));
      }
      if (sign < 0) emptied.add(key);
    }
  }
  // A call that moved to another row, for instance on learning its tier,
  // leaves nothing behind. Checked once all changes are applied, so a row
  // updated in place keeps its other fields.
  for (const key of emptied) {
    const total = days[key];
    if (total.calls === 0 && TOKEN_FIELDS.every((field) => !total[field])) delete days[key];
  }
  return days;
}

// When the counting basis changes, every event identifier changes with it, so
// incremental aggregation would add corrected totals on top of the old ones.
// Recompute each day the current logs still cover, and keep the rest as they
// were, marked as produced by the earlier basis.
function rebuildDaily(previousDaily, retainedDetail, options = {}) {
  const rebuilt = aggregateByDay(retainedDetail);
  // A day the retained detail only partly covers, because a purge, a trim or
  // the retention cut-off falls inside it, must not shrink to what the rebuild
  // can see.
  const boundary = [options.purgedBefore, options.completeFrom]
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => new Date(value).toISOString())
    .sort().at(-1) || null;
  // A day is partly covered only when the cut-off falls inside it. A cut-off at
  // midnight leaves the day whole, and it is rebuilt from its detail.
  const partlyCovered = (date) => Boolean(boundary) && `${date}T00:00:00.000Z` < boundary;
  // A row the rebuild reproduces is replaced. A row it does not reproduce is
  // real history the current logs no longer reach, and is kept: a model whose
  // log has rotated away must not be deleted because another model on the same
  // day survived. The exception is a row whose model was never identified,
  // which the rebuild supersedes once it names the models for that day.
  const recomputed = new Set(Object.values(rebuilt).map((row) => `${row.date}|${row.provider}`));
  const work = (record) => TOKEN_FIELDS.reduce((sum, field) => sum + (record?.[field] || 0), 0);
  // The same calls can move to another key when the rebuild learns something
  // the old basis did not record, such as the pricing tier. A carried row the
  // rebuild has accounted for elsewhere, under the same day, provider and
  // model, is superseded rather than kept alongside its replacement.
  const replaced = new Map();
  for (const [key, row] of Object.entries(rebuilt)) {
    const base = `${row.date}|${row.provider}|${row.model}`;
    const entry = replaced.get(base) || {calls: 0, work: 0};
    replaced.set(base, {calls: entry.calls + (row.calls || 0), work: entry.work + work(row)});
  }
  const result = {};
  for (const [key, row] of Object.entries(previousDaily || {})) {
    if (rebuilt[key]) continue;
    if (row.model === 'unknown' && recomputed.has(`${row.date}|${row.provider}`)) continue;
    const elsewhere = replaced.get(`${row.date}|${row.provider}|${row.model}`);
    if (elsewhere && elsewhere.calls >= (row.calls || 0) && elsewhere.work >= work(row)) continue;
    result[key] = {...row, preCorrection: true};
  }
  for (const [key, row] of Object.entries(rebuilt)) {
    const carried = previousDaily?.[key];
    // A purge or trim deletes detail but deliberately leaves daily totals
    // standing, so a rebuild on or before that day must not shrink them. Keep
    // whichever record is the more complete, never a field-by-field blend.
    // A day may also be incomplete because its logs rotated away, which no
    // cut-off records. Whichever record holds more work is kept, whole.
    if (carried && ((carried.calls || 0) > (row.calls || 0) || work(carried) > work(row))) {
      result[key] = {...carried, preCorrection: true};
    } else {
      result[key] = row;
    }
  }
  return result;
}

function reconcileDailyFloor(previousDaily, retainedDetail) {
  const result = Object.fromEntries(Object.entries(previousDaily || {}).map(([key, value]) => [key, {...value}]));
  for (const [key, row] of Object.entries(aggregateByDay(retainedDetail))) {
    const current = result[key] ||= {...row};
    for (const field of ['calls', ...TOKEN_FIELDS]) {
      current[field] = Math.max(current[field] || 0, row[field]);
    }
  }
  return result;
}

module.exports = { dailyKey, mergeEvents, applyRetention, afterTimestamp, aggregateByDay, updateDaily, rebuildDaily, reconcileDailyFloor };
