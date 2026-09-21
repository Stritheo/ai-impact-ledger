'use strict';

const path = require('node:path');
const {normaliseModel, normaliseGeo} = require('./security');

const MAX_TOKENS = 100_000_000;
const EARLIEST_MS = Date.parse('2023-01-01T00:00:00Z');
const FUTURE_TOLERANCE_MS = 86_400_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function number(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : 0;
}

function validCounters(object, fields) {
  return fields.every((field) => object[field] === undefined
    || (Number.isSafeInteger(object[field]) && object[field] >= 0 && object[field] <= MAX_TOKENS));
}

function hasTokenSignal(object, fields) {
  return object && typeof object === 'object' && fields.some((field) => object[field] !== undefined && object[field] !== 0);
}

// Providers record ISO-8601 with an explicit zone. Anything else parseable (a
// locale string, or a stamp with no zone at all, which would be read as the
// reader's local time) is rejected rather than stored, because the stored value
// is also the ledger's day key. Offsets are normalised to UTC.
function validTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value.trim())) return null;
  const milliseconds = Date.parse(value.trim());
  if (!Number.isFinite(milliseconds)) return null;
  if (milliseconds < EARLIEST_MS || milliseconds > Date.now() + FUTURE_TOLERANCE_MS) return null;
  return new Date(milliseconds).toISOString();
}

function shortText(value, fallback) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback;
}

function tokensFromClaude(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (!validCounters(usage, ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'])
      || !validCounters(usage.cache_creation || {}, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])
      || !validCounters(usage.output_tokens_details || {}, ['thinking_tokens'])) return null;
  const cacheWrite = number(usage.cache_creation_input_tokens);
  const cacheWrite5m = number(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1h = number(usage.cache_creation?.ephemeral_1h_input_tokens);
  if (cacheWrite5m + cacheWrite1h > cacheWrite || number(usage.output_tokens_details?.thinking_tokens) > number(usage.output_tokens)) return null;
  const tokens = {
    input: number(usage.input_tokens),
    cachedInput: number(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite5m: cacheWrite5m + cacheWrite1h <= cacheWrite ? cacheWrite5m : 0,
    cacheWrite1h: cacheWrite5m + cacheWrite1h <= cacheWrite ? cacheWrite1h : 0,
    output: number(usage.output_tokens),
    reasoningOutput: number(usage.output_tokens_details?.thinking_tokens)
  };
  return Object.values(tokens).some(Boolean) ? tokens : null;
}

function tokensFromCodex(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (!validCounters(usage, ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'])) return null;
  const totalInput = number(usage.input_tokens);
  const cachedInput = number(usage.cached_input_tokens);
  const cacheWrite = number(usage.cache_write_input_tokens);
  if (cachedInput + cacheWrite > totalInput || number(usage.reasoning_output_tokens) > number(usage.output_tokens)) return null;
  const tokens = {
    input: Math.max(0, totalInput - cachedInput - cacheWrite),
    cachedInput,
    cacheWrite,
    output: number(usage.output_tokens),
    reasoningOutput: number(usage.reasoning_output_tokens)
  };
  return Object.values(tokens).some(Boolean) ? tokens : null;
}

function parseLine(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > 8 * 1_048_576) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function score(tokens) {
  return tokens.input + tokens.cachedInput + tokens.cacheWrite + tokens.output;
}

const CODEX_USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const CLAUDE_USAGE_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];

// A usage-bearing record the parser does not recognise means the provider
// changed its schema. Disclose it as incomplete coverage instead of letting
// totals shrink silently.
function carriesUsage(record, fields) {
  return [record?.payload?.usage, record?.payload?.info?.last_token_usage, record?.message?.usage, record?.usage]
    .some((candidate) => hasTokenSignal(candidate, fields));
}

// Fast mode and other service tiers are priced differently from the standard
// rates in the registry. Only the fact that a call was not standard is kept.
function nonStandardTier(usage) {
  return ['speed', 'service_tier'].some((field) => usage?.[field] !== undefined && usage[field] !== null
    && usage[field] !== 'standard');
}

function createClaudeAccumulator(sourceName) {
  const requests = new Map();
  let recordsSkipped = 0;
  let schemaUnknown = 0;
  return {
    add(line) {
      const record = parseLine(line);
      if (!record) return;
      if (record.type !== 'assistant' || typeof record.requestId !== 'string') {
        if (carriesUsage(record, CLAUDE_USAGE_FIELDS)) schemaUnknown += 1;
        return;
      }
      const tokens = tokensFromClaude(record.message?.usage);
      const timestamp = validTimestamp(record.timestamp);
      if (!tokens || !timestamp) {
        const usage = record.message?.usage;
        if (hasTokenSignal(usage, CLAUDE_USAGE_FIELDS)
            || hasTokenSignal(usage?.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])
            || hasTokenSignal(usage?.output_tokens_details, ['thinking_tokens'])) recordsSkipped += 1;
        return;
      }
      const event = {
        id: `claude:${shortText(record.requestId, 'unknown')}`,
        provider: 'anthropic',
        model: normaliseModel('anthropic', record.message?.model),
        timestamp,
        tokens,
        inferenceGeo: normaliseGeo(record.message?.usage?.inference_geo)
      };
      const previous = requests.get(event.id);
      if (nonStandardTier(record.message.usage) || previous?.nonStandardTier) event.nonStandardTier = true;
      if (!previous || score(event.tokens) >= score(previous.tokens)) requests.set(event.id, event);
      else if (event.nonStandardTier) previous.nonStandardTier = true;
    },
    events() { return [...requests.values()]; },
    diagnostics() { return {recordsSkipped, schemaUnknown, unmatchedLegacyRecords: 0,
      duplicateResponseIds: 0, recordsWithoutIdentifier: 0}; }
  };
}

// Codex records one usage entry per model response. Current sessions carry a
// unique response_id; older sessions carry only a running total, from which a
// response is inferred each time that total changes. A file holding both
// schemas describes the same requests twice, so the current schema wins and any
// legacy entry it does not account for is disclosed rather than added.
function createCodexAccumulator(sourceName) {
  const responses = new Map();
  const legacy = [];
  const source = path.basename(sourceName || 'unknown');
  let context = null;
  let lastTotal = null;
  let sequence = 0;
  let recordsSkipped = 0;
  let schemaUnknown = 0;
  let unmatchedLegacyRecords = 0;
  let duplicateResponseIds = 0;
  let recordsWithoutIdentifier = 0;
  let lastLegacyUsage = null;
  let counted = false;

  const usageKey = (tokens) => `${tokens.input}/${tokens.cachedInput}/${tokens.cacheWrite}/${tokens.output}`;

  return {
    add(line) {
      const record = parseLine(line);
      if (!record) return;
      if (record.type === 'turn_context') {
        context = {
          id: shortText(record.payload?.turn_id, null),
          model: normaliseModel('openai', record.payload?.model),
          timestamp: validTimestamp(record.timestamp)
        };
        return;
      }
      const isLegacy = record.type === 'event_msg' && record.payload?.type === 'token_count';
      const isCurrent = record.type === 'token_usage_record';
      if (!isLegacy && !isCurrent) {
        if (carriesUsage(record, CODEX_USAGE_FIELDS)) schemaUnknown += 1;
        return;
      }
      const usage = isLegacy ? record.payload?.info?.last_token_usage : record.payload?.usage;
      const tokens = tokensFromCodex(usage);
      const timestamp = validTimestamp(record.timestamp) || context?.timestamp || null;
      if (!tokens || !timestamp) {
        if (hasTokenSignal(usage, CODEX_USAGE_FIELDS)) recordsSkipped += 1;
        return;
      }
      const model = context?.model || 'unknown';
      if (isCurrent) {
        const responseId = shortText(record.payload?.response_id, null);
        sequence += 1;
        // The rollout format does not guarantee a response identifier, and does
        // not guarantee it is unique. Without one, each record is its own call
        // rather than collapsing the turn; with a repeated one, the larger
        // usage wins and the repeat is disclosed.
        if (!responseId) recordsWithoutIdentifier += 1;
        const id = responseId
          ? `codex:${responseId}`
          : `codex:${source}:${shortText(record.payload?.turn_id, context?.id || 'no-turn')}:${sequence}`;
        const event = {id, provider: 'openai', model, timestamp, tokens, inferenceGeo: null};
        const previous = responses.get(id);
        if (previous) duplicateResponseIds += 1;
        if (!previous || score(event.tokens) >= score(previous.tokens)) responses.set(id, event);
        return;
      }
      // token_count is a usage snapshot, not a request record: it can repeat
      // without a new request. Count a request only where the running total
      // moves, or where there is no running total and the usage itself changes.
      const total = JSON.stringify(record.payload?.info?.total_token_usage ?? null);
      const usageSignature = usageKey(tokens);
      if (total !== 'null') {
        if (total === lastTotal) return;
      } else if (usageSignature === lastLegacyUsage) return;
      lastTotal = total;
      lastLegacyUsage = usageSignature;
      sequence += 1;
      legacy.push({
        id: `codex:${source}:${context?.id || 'no-turn'}:${sequence}`,
        provider: 'openai', model, timestamp, tokens, inferenceGeo: null
      });
    },
    events() {
      if (responses.size === 0) return legacy;
      if (!counted) {
        counted = true;
        const remaining = new Map();
        for (const event of responses.values()) {
          const key = usageKey(event.tokens);
          remaining.set(key, (remaining.get(key) || 0) + 1);
        }
        for (const event of legacy) {
          const key = usageKey(event.tokens);
          const left = remaining.get(key) || 0;
          if (left > 0) remaining.set(key, left - 1);
          else unmatchedLegacyRecords += 1;
        }
      }
      return [...responses.values()];
    },
    // Reading diagnostics must not depend on whether events() has been called.
    diagnostics() {
      this.events();
      return {recordsSkipped, schemaUnknown, unmatchedLegacyRecords, duplicateResponseIds, recordsWithoutIdentifier};
    }
  };
}

function createLineAccumulator(provider, sourceName) {
  return provider === 'anthropic' ? createClaudeAccumulator(sourceName) : createCodexAccumulator(sourceName);
}

function parseClaudeLines(lines, sourceName) {
  const accumulator = createClaudeAccumulator(sourceName);
  for (const line of lines) accumulator.add(line);
  return accumulator.events();
}

function parseCodexLines(lines, sourceName) {
  const accumulator = createCodexAccumulator(sourceName);
  for (const line of lines) accumulator.add(line);
  return accumulator.events();
}

module.exports = { parseClaudeLines, parseCodexLines, createLineAccumulator };
