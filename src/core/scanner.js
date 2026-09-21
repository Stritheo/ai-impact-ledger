'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createLineAccumulator} = require('./parsers');

const MAX_FILES = 10_000;
const MAX_DEPTH = 20;
const LARGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1_048_576;
// Raised when a parser change alters what is read from a log, so every file is
// read again once. Version 5 records whether a Claude call used a non-standard
// speed or service tier.
const PARSER_VERSION = '5';

async function parseLargeLog(handle, provider, sourceName) {
  const accumulator = createLineAccumulator(provider, sourceName);
  let fragments = [];
  let lineBytes = 0;
  let dropping = false;
  let linesSkipped = 0;
  const finishLine = () => {
    if (dropping) linesSkipped += 1;
    else if (lineBytes) accumulator.add(Buffer.concat(fragments, lineBytes).toString('utf8').replace(/\r$/, ''));
    fragments = [];
    lineBytes = 0;
    dropping = false;
  };
  for await (const chunk of handle.createReadStream({autoClose: false, highWaterMark: 64 * 1024})) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(cursor, end);
      if (!dropping) {
        lineBytes += piece.length;
        if (lineBytes > MAX_LINE_BYTES) {
          dropping = true;
          fragments = [];
        } else if (piece.length) fragments.push(piece);
      }
      if (newline === -1) break;
      finishLine();
      cursor = newline + 1;
    }
  }
  if (lineBytes || dropping) finishLine();
  // diagnostics() settles the accumulator's counts, so read events first.
  const events = accumulator.events();
  const diagnostics = accumulator.diagnostics();
  return {events, linesSkipped,
    recordsSkipped: diagnostics.recordsSkipped, schemaUnknown: diagnostics.schemaUnknown,
    unmatchedLegacyRecords: diagnostics.unmatchedLegacyRecords};
}

async function scanRoot(root, provider, checkpoints = {}, secret = '') {
  const startedAt = performance.now();
  const diagnostics = {filesRead: 0, filesSkipped: 0, linesSkipped: 0, recordsSkipped: 0, schemaUnknown: 0,
    unmatchedLegacyRecords: 0, duplicateResponseIds: 0, linksSkipped: 0, unchangedFiles: 0, malformedRoots: 0};
  const events = [];
  const nextCheckpoints = {};
  let canonicalRoot;
  try {
    canonicalRoot = await fs.promises.realpath(root);
  } catch {
    diagnostics.malformedRoots += 1;
    diagnostics.durationMs = performance.now() - startedAt;
    return {events, diagnostics, checkpoints: nextCheckpoints};
  }

  async function walk(directory, depth) {
    if (depth > MAX_DEPTH || diagnostics.filesRead >= MAX_FILES) {
      diagnostics.filesSkipped += 1;
      return;
    }
    let entries;
    try {
      entries = await fs.promises.readdir(directory, {withFileTypes: true});
    } catch {
      diagnostics.filesSkipped += 1;
      return;
    }
    for (const entry of entries) {
      if (diagnostics.filesRead >= MAX_FILES) {
        diagnostics.filesSkipped += 1;
        break;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.linksSkipped += 1;
      } else if (entry.isDirectory()) {
        await walk(candidate, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let handle;
        try {
          const canonical = await fs.promises.realpath(candidate);
          const relative = path.relative(canonicalRoot, canonical);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside root');
          handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const stat = await handle.stat();
          const current = await fs.promises.lstat(canonical);
          if (!stat.isFile() || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) throw new Error('unsafe log file');
          if (stat.size > MAX_FILE_BYTES) throw new Error('file too large');
          const relativeName = path.relative(canonicalRoot, canonical);
          const fileKey = secret
            ? crypto.createHmac('sha256', secret).update(`${PARSER_VERSION}:${relativeName}`).digest('hex')
            : crypto.createHash('sha256').update(`${PARSER_VERSION}:${relativeName}`).digest('hex');
          const fingerprint = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
          const previous = checkpoints[fileKey];
          if (previous === fingerprint || (typeof previous === 'string' && previous.startsWith(`${fingerprint}:`))) {
            nextCheckpoints[fileKey] = previous;
            diagnostics.unchangedFiles += 1;
            const retained = previous.split(':');
            diagnostics.linesSkipped += Math.min(1_000_000, Number(retained[2]) || 0);
            diagnostics.recordsSkipped += Math.min(1_000_000, Number(retained[3]) || 0);
            diagnostics.schemaUnknown += Math.min(1_000_000, Number(retained[4]) || 0);
            diagnostics.unmatchedLegacyRecords += Math.min(1_000_000, Number(retained[5]) || 0);
            continue;
          }
          let fileLinesSkipped = 0;
          let fileRecordsSkipped = 0;
          let fileSchemaUnknown = 0;
          let fileUnmatchedLegacy = 0;
          if (stat.size > LARGE_FILE_BYTES) {
            const parsed = await parseLargeLog(handle, provider, entry.name);
            events.push(...parsed.events);
            fileLinesSkipped = parsed.linesSkipped;
            fileRecordsSkipped = parsed.recordsSkipped;
            fileSchemaUnknown = parsed.schemaUnknown;
            fileUnmatchedLegacy = parsed.unmatchedLegacyRecords;
          } else {
            const lines = (await handle.readFile({encoding: 'utf8'})).split(/\r?\n/);
            fileLinesSkipped = lines.filter((line) => line.length > MAX_LINE_BYTES).length;
            const accumulator = createLineAccumulator(provider, entry.name);
            for (const line of lines) accumulator.add(line);
            events.push(...accumulator.events());
            const fileDiagnostics = accumulator.diagnostics();
            fileRecordsSkipped = fileDiagnostics.recordsSkipped;
            fileSchemaUnknown = fileDiagnostics.schemaUnknown;
            fileUnmatchedLegacy = fileDiagnostics.unmatchedLegacyRecords;
            diagnostics.duplicateResponseIds += fileDiagnostics.duplicateResponseIds;
          }
          diagnostics.linesSkipped += fileLinesSkipped;
          diagnostics.recordsSkipped += fileRecordsSkipped;
          diagnostics.schemaUnknown += fileSchemaUnknown;
          diagnostics.unmatchedLegacyRecords += fileUnmatchedLegacy;
          diagnostics.filesRead += 1;
          nextCheckpoints[fileKey] = fileLinesSkipped || fileRecordsSkipped || fileSchemaUnknown || fileUnmatchedLegacy
            ? `${fingerprint}:${fileLinesSkipped}:${fileRecordsSkipped}:${fileSchemaUnknown}:${fileUnmatchedLegacy}`
            : fingerprint;
        } catch {
          diagnostics.filesSkipped += 1;
        } finally {
          await handle?.close();
        }
      }
    }
  }

  await walk(canonicalRoot, 0);
  diagnostics.durationMs = performance.now() - startedAt;
  return {events, diagnostics, checkpoints: nextCheckpoints};
}

module.exports = { scanRoot };
