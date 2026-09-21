// Reconciles what the ledger counts against what the provider logs state.
// Reads local logs and emits counts only: no prompt, response, path or model
// content leaves this script. Run with: npm run verify:counting
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {scanRoot} = require('../src/core/scanner.js');
const {mergeEvents} = require('../src/core/ledger.js');

const ROOTS = [
  [path.join(os.homedir(), '.claude', 'projects'), 'anthropic'],
  [path.join(os.homedir(), '.codex', 'sessions'), 'openai']
];

function logFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(target);
    }
  };
  walk(root);
  return found;
}

// Codex states its own per-turn total alongside each response. That figure is
// the independent check: the ledger's events for a turn must sum to it.
function codexTruth() {
  const perTurn = new Map();
  let responses = 0;
  let turnsWithStatedTotal = 0;
  for (const file of logFiles(ROOTS[1][0])) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || !line.includes('token_usage_record')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'token_usage_record') continue;
      const payload = record.payload || {};
      const usage = payload.usage || {};
      const key = `${file}|${payload.turn_id}`;
      const entry = perTurn.get(key) || {summed: 0, stated: null, responses: 0};
      entry.summed += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      entry.responses += 1;
      const stated = payload.turn_token_usage;
      if (stated) entry.stated = (stated.input_tokens || 0) + (stated.output_tokens || 0);
      perTurn.set(key, entry);
      responses += 1;
    }
  }
  let matching = 0;
  let differing = 0;
  let unexplained = 0;
  for (const entry of perTurn.values()) {
    if (entry.stated === null) continue;
    turnsWithStatedTotal += 1;
    if (entry.summed === entry.stated) matching += 1;
    else {
      differing += 1;
      unexplained += Math.abs(entry.summed - entry.stated);
    }
  }
  return {responses, turns: perTurn.size, turnsWithStatedTotal, matching, differing, unexplainedTokens: unexplained};
}

const tokensOf = (events) => events.reduce((sum, event) =>
  sum + event.tokens.input + event.tokens.cachedInput + event.tokens.cacheWrite + event.tokens.output, 0);

const scans = await Promise.all(ROOTS.map(([root, provider]) => scanRoot(root, provider, {}, 'verify')));
const [claude, codex] = scans;
// The ledger stores one record per identifier, so de-duplicate before counting:
// a request written to two session files is one call, not two.
const claudeEvents = mergeEvents(claude.events);
const codexEvents = mergeEvents(codex.events);
const truth = codexTruth();

const report = {
  checkedAt: new Date().toISOString(),
  claude: {filesRead: claude.diagnostics.filesRead, parsedRecords: claude.events.length,
    calls: claudeEvents.length, duplicatesAcrossFiles: claude.events.length - claudeEvents.length,
    tokens: tokensOf(claudeEvents)},
  codex: {filesRead: codex.diagnostics.filesRead, parsedRecords: codex.events.length,
    calls: codexEvents.length, duplicatesAcrossFiles: codex.events.length - codexEvents.length,
    tokens: tokensOf(codexEvents)},
  codexReconciliation: {
    responsesInLogs: truth.responses,
    turnsWithProviderStatedTotal: truth.turnsWithStatedTotal,
    turnsMatchingProviderTotal: truth.matching,
    turnsDifferingFromProviderTotal: truth.differing,
    unexplainedTokens: truth.unexplainedTokens
  },
  coverage: {
    filesSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.filesSkipped, 0),
    linesSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.linesSkipped, 0),
    recordsSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.recordsSkipped, 0),
    unrecognisedSchemas: scans.reduce((sum, scan) => sum + scan.diagnostics.schemaUnknown, 0),
    unmatchedLegacyRecords: scans.reduce((sum, scan) => sum + scan.diagnostics.unmatchedLegacyRecords, 0)
  }
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (truth.differing > 0 || report.coverage.unrecognisedSchemas > 0) process.exitCode = 1;
