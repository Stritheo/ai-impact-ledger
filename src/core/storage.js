'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {sanitiseEvent, normaliseModel, normaliseGeo} = require('./security');
const {reconcileDailyFloor, dailyKey} = require('./ledger');

const EMPTY = Object.freeze({detail: [], daily: {}, checkpoints: {}});
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const LOCK_RETRIES = 500;
const LOCK_WAIT_MS = 10;
const STALE_LOCK_MS = 30_000;
// A process id can be reused by an unrelated process, which would otherwise
// hold the ledger shut for good. An update takes well under a second, so a
// lock this old is abandoned whatever its holder says.
const ABANDONED_LOCK_MS = 10 * 60_000;
// The v1 rollback copy is kept for this long after the v2 store has been read
// back successfully, then deleted. A purge deletes it at once.
const ROLLBACK_RETENTION_MS = 14 * 86_400_000;
// When a write would exceed the cap, the oldest detail is trimmed until the
// store is back under this share of it.
const TRIM_TARGET = 0.9;

function needsCapacityWarning(bytes, limit) {
  return Number.isFinite(bytes) && Number.isFinite(limit) && limit > 0 && bytes / limit >= 0.8;
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitiseDaily(value) {
  const result = {};
  if (!validObject(value)) return result;
  for (const [key, record] of Object.entries(value)) {
    if (key.length > 300 || !validObject(record) || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) continue;
    if (!['anthropic', 'openai'].includes(record.provider)) continue;
    const model = normaliseModel(record.provider, record.model);
    const safeKey = dailyKey(record.date, record.provider, model, record.nonStandardTier);
    result[safeKey] = {
      date: record.date,
      provider: record.provider,
      model,
      ...(record.nonStandardTier === true ? {nonStandardTier: true} : {}),
      calls: safeInteger(record.calls),
      input: safeInteger(record.input),
      cachedInput: safeInteger(record.cachedInput),
      cacheWrite: safeInteger(record.cacheWrite),
      ...(record.cacheWrite5m !== undefined ? {cacheWrite5m: safeInteger(record.cacheWrite5m)} : {}),
      ...(record.cacheWrite1h !== undefined ? {cacheWrite1h: safeInteger(record.cacheWrite1h)} : {}),
      ...(record.cacheWriteUnclassified !== undefined ? {cacheWriteUnclassified: safeInteger(record.cacheWriteUnclassified)} : {}),
      ...(record.preCorrection === true ? {preCorrection: true} : {}),
      output: safeInteger(record.output),
      reasoningOutput: safeInteger(record.reasoningOutput)
    };
  }
  return result;
}

function sanitiseCheckpoints(value) {
  const result = {};
  if (!validObject(value)) return result;
  for (const provider of ['anthropic', 'openai']) {
    if (!validObject(value[provider])) continue;
    result[provider] = {};
    for (const [key, fingerprint] of Object.entries(value[provider])) {
      if (/^[a-f0-9]{64}$/.test(key) && /^\d+:\d+(?::\d{1,6}){0,4}$/.test(fingerprint)) result[provider][key] = fingerprint;
    }
  }
  return result;
}

function normalise(value) {
  if (!validObject(value) || !Array.isArray(value.detail) || !validObject(value.daily) || !validObject(value.checkpoints)) {
    return {detail: [], daily: {}, checkpoints: {}};
  }
  return {
    detail: value.detail.filter(validObject).map(sanitiseEvent),
    daily: sanitiseDaily(value.daily),
    checkpoints: sanitiseCheckpoints(value.checkpoints)
  };
}

function isoOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function laterOf(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  return first > second ? first : second;
}

function normaliseV2(value) {
  const safe = normalise(value);
  return {...safe, purgedBefore: isoOrNull(value?.purgedBefore),
    basisVersion: Number.isSafeInteger(value?.basisVersion) && value.basisVersion >= 0 ? value.basisVersion : null,
    rollbackConfirmedAt: isoOrNull(value?.rollbackConfirmedAt),
    trimmedBefore: isoOrNull(value?.trimmedBefore)};
}

function stateContents(value) {
  return {daily: value.daily, checkpoints: value.checkpoints, purgedBefore: value.purgedBefore ?? null,
    basisVersion: value.basisVersion ?? null, rollbackConfirmedAt: value.rollbackConfirmedAt ?? null,
    trimmedBefore: value.trimmedBefore ?? null};
}

function partitionContents(safe) {
  const byDay = new Map();
  for (const event of safe.detail) {
    const day = event.timestamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid ledger date');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  const contents = new Map([...byDay].map(([day, records]) => [`${day}.json`, records]));
  contents.set('state.json', stateContents(safe));
  return contents;
}

function contentBytes(contents) {
  return [...contents.values()].reduce((sum, part) => sum + Buffer.byteLength(JSON.stringify(part)) + 1, 0);
}

// Detail is trimmed oldest first, and never before its calls are covered by
// the daily totals. Records sharing the cut-off timestamp go together, so the
// cut-off cleanly separates what was trimmed from what was kept.
function fitWithinCapacity(value, maxBytes) {
  let current = value;
  let bytes = contentBytes(partitionContents(current));
  if (bytes <= maxBytes) return current;
  const target = Math.floor(maxBytes * TRIM_TARGET);
  const sorted = [...current.detail].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let index = 0;
  while (bytes > target) {
    if (index >= sorted.length) throw new Error('ledger capacity exceeded; existing records preserved');
    let estimate = bytes;
    while (index < sorted.length && estimate > target) {
      estimate -= Buffer.byteLength(JSON.stringify(sorted[index])) + 1;
      index += 1;
    }
    while (index < sorted.length && sorted[index].timestamp === sorted[index - 1].timestamp) index += 1;
    const dropped = sorted.slice(0, index);
    current = {...value, detail: sorted.slice(index), daily: reconcileDailyFloor(value.daily, dropped),
      trimmedBefore: laterOf(value.trimmedBefore, dropped.at(-1).timestamp)};
    bytes = contentBytes(partitionContents(current));
  }
  return current;
}

function validV2State(value) {
  if (!validObject(value) || !validObject(value.daily) || !validObject(value.checkpoints)) return false;
  if (value.purgedBefore !== null && value.purgedBefore !== undefined
      && (typeof value.purgedBefore !== 'string' || !Number.isFinite(Date.parse(value.purgedBefore)))) return false;
  if (value.basisVersion !== undefined && value.basisVersion !== null
      && !(Number.isSafeInteger(value.basisVersion) && value.basisVersion >= 0)) return false;
  for (const field of ['rollbackConfirmedAt', 'trimmedBefore']) {
    if (value[field] !== undefined && value[field] !== null
        && (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field])))) return false;
  }
  for (const [key, row] of Object.entries(value.daily)) {
    if (!validObject(row) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        || !['anthropic', 'openai'].includes(row.provider)
        || typeof row.model !== 'string' || row.model.length > 80
        || (row.nonStandardTier !== undefined && row.nonStandardTier !== true)
        || key !== dailyKey(row.date, row.provider, row.model, row.nonStandardTier)) return false;
    if (['calls', 'input', 'cachedInput', 'cacheWrite', 'output', 'reasoningOutput'].some((field) => safeInteger(row[field]) !== row[field])) return false;
    if (['cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnclassified'].some((field) => row[field] !== undefined && safeInteger(row[field]) !== row[field])) return false;
    if (row.preCorrection !== undefined && row.preCorrection !== true) return false;
  }
  for (const [provider, records] of Object.entries(value.checkpoints)) {
    if (!['anthropic', 'openai'].includes(provider) || !validObject(records)) return false;
    if (Object.entries(records).some(([key, fingerprint]) => !/^[a-f0-9]{64}$/.test(key) || !/^\d+:\d+(?::\d{1,6}){0,4}$/.test(fingerprint))) return false;
  }
  return true;
}

function validV2Event(value) {
  return validObject(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500
    && ['anthropic', 'openai'].includes(value.provider)
    && typeof value.model === 'string' && value.model.length <= 80
    && (value.model === 'unknown' || normaliseModel(value.provider, value.model) === value.model)
    && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
    && validObject(value.tokens)
    && ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoningOutput'].every((field) => safeInteger(value.tokens[field]) === value.tokens[field])
    && ['cacheWrite5m', 'cacheWrite1h'].every((field) => value.tokens[field] === undefined || safeInteger(value.tokens[field]) === value.tokens[field])
    && (value.nonStandardTier === undefined || value.nonStandardTier === true)
    && (value.inferenceGeo === null || normaliseGeo(value.inferenceGeo) === value.inferenceGeo)
    && (value.configuredGeo === undefined || value.configuredGeo === null || normaliseGeo(value.configuredGeo) === value.configuredGeo);
}

function holderRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readHolder(file) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return validObject(parsed) && typeof parsed.token === 'string' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    return {};
  }
}

class LocalStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'ledger.v1.json');
    this.lock = path.join(this.root, '.ledger.lock');
    this.lockRetries = options.lockRetries ?? LOCK_RETRIES;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  }

  async read() {
    try {
      const stat = await fs.promises.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) return {...EMPTY};
      return normalise(JSON.parse(await fs.promises.readFile(this.file, 'utf8')));
    } catch {
      return {...EMPTY};
    }
  }

  async write(value) {
    const safe = normalise(value);
    await fs.promises.mkdir(this.root, {recursive: true, mode: 0o700});
    const temporary = path.join(this.root, `.ledger-${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, `${JSON.stringify(safe)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await fs.promises.rename(temporary, this.file);
      await fs.promises.chmod(this.file, 0o600);
    } finally {
      await fs.promises.rm(temporary, {force: true});
    }
  }

  // The lock names its holder. It is published complete, by linking a written
  // temporary file into place, so no reader ever sees it half written.
  async publishLock(token) {
    const temporary = path.join(this.root, `.ledger-lock-${token}.tmp`);
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({token, pid: process.pid}), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await fs.promises.link(temporary, this.lock);
    } finally {
      await fs.promises.rm(temporary, {force: true});
    }
  }

  // A lock is taken over only when it is older than 30 seconds and its holder
  // is no longer running. A lock with no recorded holder, as left by an earlier
  // version, is judged on age alone. The lock is moved aside before removal and
  // checked, so a contender that won in the meantime is put back, not deleted.
  async clearStaleLock() {
    let stat;
    let observed;
    try {
      stat = await fs.promises.lstat(this.lock);
      observed = await readHolder(this.lock);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const age = Date.now() - stat.mtimeMs;
    if (age <= STALE_LOCK_MS) return;
    if (age <= ABANDONED_LOCK_MS
        && Number.isSafeInteger(observed.pid) && observed.pid > 0 && holderRunning(observed.pid)) return;
    const aside = path.join(this.root, `.ledger-lock-${crypto.randomUUID()}.stale`);
    try {
      await fs.promises.rename(this.lock, aside);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const moved = await readHolder(aside);
      if (moved.token !== observed.token) {
        await fs.promises.link(aside, this.lock).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      }
    } finally {
      await fs.promises.rm(aside, {force: true});
    }
  }

  async acquireLock() {
    await fs.promises.mkdir(this.root, {recursive: true, mode: 0o700});
    const token = crypto.randomUUID();
    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      try {
        await this.publishLock(token);
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.clearStaleLock();
        await new Promise((resolve) => setTimeout(resolve, this.lockWaitMs));
      }
    }
    throw new Error('local ledger is busy');
  }

  async releaseLock(token) {
    try {
      if ((await readHolder(this.lock)).token === token) await fs.promises.rm(this.lock, {force: true});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async update(change) {
    const token = await this.acquireLock();
    try {
      const next = normalise(await change(await this.read()));
      await this.write(next);
      return next;
    } finally {
      await this.releaseLock(token);
    }
  }
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

async function readPrivateJson(file, maximumBytes = MAX_STORE_BYTES) {
  const stat = await fs.promises.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const error = new Error('unsafe ledger file: a link, not a file');
    error.code = 'UNSAFE_LEGACY_LINK';
    throw error;
  }
  if (stat.size > maximumBytes) throw new Error('unsafe or oversized ledger file');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

async function atomicJson(file, value) {
  const temporary = path.join(path.dirname(file), `.ledger-${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await fs.promises.rename(temporary, file);
    await fs.promises.chmod(file, 0o600);
  } finally {
    await fs.promises.rm(temporary, {force: true});
  }
}

class PartitionedStore extends LocalStore {
  constructor(root, maxBytes = MAX_STORE_BYTES, options = {}) {
    super(root, options);
    this.v2 = path.join(this.root, 'ledger.v2');
    this.maxBytes = maxBytes;
  }

  async readMetadata() {
    try {
      const directory = await fs.promises.lstat(this.v2);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe ledger directory');
    } catch (error) {
      if (error.code === 'ENOENT') return {checkpoints: {}, revision: null, basisVersion: null};
      throw error;
    }
    const file = path.join(this.v2, 'state.json');
    const state = await readPrivateJson(file);
    const stat = await fs.promises.lstat(file);
    if (!validV2State(state)) throw new Error('invalid ledger state');
    let storageBytes = stat.size;
    for (const name of await fs.promises.readdir(this.v2)) {
      if (!DAY_FILE.test(name)) continue;
      const part = await fs.promises.lstat(path.join(this.v2, name));
      if (!part.isFile() || part.isSymbolicLink()) throw new Error('unsafe ledger partition');
      storageBytes += part.size;
    }
    return {checkpoints: sanitiseCheckpoints(state.checkpoints), revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}`,
      basisVersion: Number.isSafeInteger(state.basisVersion) ? state.basisVersion : null,
      storageBytes, limitBytes: this.maxBytes};
  }

  async read() {
    let stat;
    try {
      stat = await fs.promises.lstat(this.v2);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        const legacy = await readPrivateJson(this.file);
        if (!validObject(legacy) || !Array.isArray(legacy.detail) || !validObject(legacy.daily) || !validObject(legacy.checkpoints)) {
          throw new Error('invalid legacy ledger');
        }
        const safe = normalise(legacy);
        for (const event of safe.detail) {
          if (event.provider !== 'openai') continue;
          event.tokens.input = Math.max(0, event.tokens.input - event.tokens.cachedInput - event.tokens.cacheWrite);
        }
        for (const row of Object.values(safe.daily)) {
          if (row.provider !== 'openai') continue;
          row.input = Math.max(0, row.input - row.cachedInput - row.cacheWrite);
        }
        return normaliseV2(safe);
      } catch (legacyError) {
        // A missing copy is ordinary. A copy that is a symbolic link is not
        // ours to read: it is skipped, never followed, and the store still
        // opens. Anything else wrong with it fails closed rather than starting
        // empty and appearing to lose the user's history. Either way
        // settleRollbackCopy never deletes what it could not read.
        if (legacyError.code === 'ENOENT' || legacyError.code === 'ELOOP') return normaliseV2(EMPTY);
        if (legacyError.code === 'UNSAFE_LEGACY_LINK') return normaliseV2(EMPTY);
        throw legacyError;
      }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe ledger directory');
    const state = await readPrivateJson(path.join(this.v2, 'state.json'));
    if (!validV2State(state)) throw new Error('invalid ledger state');
    const partitions = [];
    let totalBytes = (await fs.promises.lstat(path.join(this.v2, 'state.json'))).size;
    if (totalBytes > this.maxBytes) throw new Error('ledger capacity exceeded');
    // A store over its cap is read newest day first, within the trim target.
    // Older days are left unread and removed by the next write; their calls
    // are already in the daily totals, which are maintained alongside detail.
    let trimmedBefore = state.trimmedBefore;
    const days = (await fs.promises.readdir(this.v2)).filter((name) => DAY_FILE.test(name)).sort().reverse();
    const sizes = new Map();
    for (const name of days) sizes.set(name, (await fs.promises.lstat(path.join(this.v2, name))).size);
    const overCap = [...sizes.values()].reduce((sum, size) => sum + size, totalBytes) > this.maxBytes;
    const budget = overCap ? Math.floor(this.maxBytes * TRIM_TARGET) : this.maxBytes;
    for (const name of days) {
      totalBytes += sizes.get(name);
      if (totalBytes > budget) {
        trimmedBefore = laterOf(isoOrNull(trimmedBefore), `${name.slice(0, 10)}T23:59:59.999Z`);
        break;
      }
      const records = await readPrivateJson(path.join(this.v2, name));
      if (!Array.isArray(records) || records.some((record) => !validV2Event(record))) throw new Error('invalid ledger record');
      partitions.push(records);
    }
    const detail = partitions.reverse().flat();
    return normaliseV2({detail, daily: state.daily, checkpoints: state.checkpoints,
      purgedBefore: state.purgedBefore, basisVersion: state.basisVersion, rollbackConfirmedAt: state.rollbackConfirmedAt,
      trimmedBefore});
  }

  async write(value, previous = null) {
    const safe = normaliseV2(value);
    await fs.promises.mkdir(this.root, {recursive: true, mode: 0o700});
    const contents = partitionContents(safe);
    if (contentBytes(contents) > this.maxBytes) throw new Error('ledger capacity exceeded; existing records preserved');
    const previousContents = new Map();
    if (previous) {
      const priorDays = new Map();
      for (const event of normalise(previous).detail) {
        const name = `${event.timestamp.slice(0, 10)}.json`;
        if (!priorDays.has(name)) priorDays.set(name, []);
        priorDays.get(name).push(event);
      }
      for (const [name, records] of priorDays) previousContents.set(name, JSON.stringify(records));
      previousContents.set('state.json', JSON.stringify(stateContents(previous)));
    }

    let exists = false;
    try {
      const stat = await fs.promises.lstat(this.v2);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe ledger directory');
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!exists) {
      const staged = path.join(this.root, `.ledger-v2-${crypto.randomUUID()}.tmp`);
      await fs.promises.mkdir(staged, {mode: 0o700});
      try {
        for (const [name, contentsValue] of contents) await atomicJson(path.join(staged, name), contentsValue);
        await fs.promises.rename(staged, this.v2);
      } catch (error) {
        await fs.promises.rm(staged, {recursive: true, force: true});
        throw error;
      }
      return;
    }
    for (const [name, contentsValue] of contents) {
      const target = path.join(this.v2, name);
      const wanted = JSON.stringify(contentsValue);
      let existing = previousContents.get(name);
      if (!previous) {
        try { existing = JSON.stringify(await readPrivateJson(target)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (existing !== wanted) await atomicJson(target, contentsValue);
    }
    for (const name of await fs.promises.readdir(this.v2)) {
      if (DAY_FILE.test(name) && !contents.has(name)) await fs.promises.rm(path.join(this.v2, name));
    }
  }

  // Only a copy this store could read is a copy it may delete.
  async rollbackCopyReadable() {
    try {
      await readPrivateJson(this.file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      return false;
    }
  }

  // The rollback copy is the only other record of pre-v2 history, so nothing
  // about its lifetime is decided until the v2 store has been read back whole.
  async settleRollbackCopy(written, now, purge) {
    if (!await this.rollbackCopyReadable()) return written;
    const confirmed = await this.read();
    let next = written;
    if (!confirmed.rollbackConfirmedAt) {
      next = {...written, rollbackConfirmedAt: now.toISOString()};
      await this.write(next, confirmed);
    }
    if (purge || now.getTime() - Date.parse(next.rollbackConfirmedAt) >= ROLLBACK_RETENTION_MS) {
      await fs.promises.rm(this.file, {force: true});
    }
    return next;
  }

  async update(change, options = {}) {
    const now = options.now || new Date();
    const token = await this.acquireLock();
    try {
      const previous = await this.read();
      // The confirmation date and the trim cut-off belong to the store: a
      // caller cannot forge the first or move the second backwards.
      const changed = normaliseV2(await change(previous));
      const trimmedBefore = laterOf(previous.trimmedBefore, changed.trimmedBefore);
      const next = fitWithinCapacity({...changed, rollbackConfirmedAt: previous.rollbackConfirmedAt, trimmedBefore,
        detail: trimmedBefore ? changed.detail.filter((event) => event.timestamp > trimmedBefore) : changed.detail}, this.maxBytes);
      await this.write(next, previous);
      return await this.settleRollbackCopy(next, now, options.purgeRollback === true);
    } finally {
      await this.releaseLock(token);
    }
  }
}

module.exports = {LocalStore, PartitionedStore, needsCapacityWarning};
