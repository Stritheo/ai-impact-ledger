'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const registry = require('./data/impact-registry.v1.json');
const fxRegistry = require('./data/fx-registry.v1.json');
const { scanRoot } = require('./core/scanner');
const { mergeEvents, applyRetention, afterTimestamp, updateDaily, rebuildDaily, reconcileDailyFloor, aggregateByDay } = require('./core/ledger');
const { sanitiseEvent, hashEventId } = require('./core/security');
const { pricedAtStandardRates } = require('./core/estimate');
const { buildSummary, reportHtml, statusSummary, todayLocal } = require('./core/report');
const { PartitionedStore, needsCapacityWarning } = require('./core/storage');
const {normaliseSettings, convertCost} = require('./core/settings');
const {reviewStatus} = require('./core/evidence');

const DETAIL_KEY = 'detail.v1';
const DAILY_KEY = 'daily.v1';
const SECRET_KEY = 'localHashSecret.v1';
const PURGED_BEFORE_KEY = 'purgedBefore.v1';
const CHECKPOINT_KEY = 'scanCheckpoints.v1';
// Raised when the meaning of a stored event changes. A store written under an
// earlier basis is rebuilt from source logs rather than added to, because every
// event identifier changed with the basis.
const CURRENT_BASIS = 2;
const SECRET_FILE = 'hash-secret';
const SECRET_FORMAT = /^[a-f0-9]{64}$/;
const timers = new Set();
const DEFAULT_REFRESH_MINUTES = 5;

function refreshMinutes() {
  const value = vscode.workspace.getConfiguration('aiImpactLedger').get('refreshMinutes', DEFAULT_REFRESH_MINUTES);
  return Number.isFinite(value) ? Math.min(1440, Math.max(1, value)) : DEFAULT_REFRESH_MINUTES;
}

async function readSecret(file) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error('unsafe hashing secret');
  const value = await fs.promises.readFile(file, 'utf8');
  if (!SECRET_FORMAT.test(value)) throw new Error('malformed hashing secret');
  return value;
}

// Every window must hash with the same secret, or one call is stored under two
// identifiers. The secret is published by linking a complete temporary file
// into place, which fails if another window got there first; that window's
// secret is then used. An existing secret from global state is carried over so
// identifiers already in the ledger keep their meaning.
async function sharedSecret(root, globalState) {
  const file = path.join(root, SECRET_FILE);
  try {
    return await readSecret(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const carried = globalState.get(SECRET_KEY);
  const candidate = typeof carried === 'string' && SECRET_FORMAT.test(carried) ? carried : crypto.randomBytes(32).toString('hex');
  await fs.promises.mkdir(root, {recursive: true, mode: 0o700});
  const temporary = path.join(root, `.hash-secret-${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, candidate, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await fs.promises.link(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await fs.promises.rm(temporary, {force: true});
  }
  return readSecret(file);
}

async function activate(context) {
  const store = new PartitionedStore(context.globalStorageUri.fsPath);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.name = 'AI Impact Ledger';
  status.command = 'aiImpactLedger.showReport';
  status.text = '$(pulse) Impact: calculating';
  status.show();
  context.subscriptions.push(status);

  let latestSummary = null;
  let lastRevision = null;
  let lastSettingsKey = null;
  let capacityWarned = false;
  const panels = new Set();
  let stamped = false;
  let downgraded = false;
  // Resolved once: the home directory does not change during a session, and a
  // refresh still running at shutdown must not look anywhere else.
  const home = os.homedir();
  const roots = [
    [path.join(home, '.claude', 'projects'), 'anthropic'],
    [path.join(home, '.codex', 'sessions'), 'openai']
  ];
  const refresh = async () => {
    try {
      // Review dates pass while VS Code stays open, so status is recomputed on
      // every refresh rather than once at activation.
      const evidence = reviewStatus({impact: registry, FX: fxRegistry});
      const config = vscode.workspace.getConfiguration('aiImpactLedger');
      const retentionDays = config.get('detailRetentionDays', 90);
      const settings = normaliseSettings({
        currency: config.get('currency', 'USD'),
        waterUnits: config.get('waterUnits', 'metric'),
        period: config.get('reportingPeriod', 'today'),
        showAnalogy: config.get('showAnalogy', true),
        analogyFamily: config.get('analogyFamily', 'television'),
        statusBarMeasure: config.get('statusBarMeasure', 'cost'),
        contributionMeasure: config.get('contributionMeasure', 'energy')
      });
      const secret = await sharedSecret(context.globalStorageUri.fsPath, context.globalState);
      if (context.globalState.get(SECRET_KEY) !== secret) await context.globalState.update(SECRET_KEY, secret);
      const settingsKey = JSON.stringify({settings, retentionDays});
      const persisted = latestSummary ? await store.readMetadata() : await store.read();
      // Only a writer that does not understand the basis stamp can remove it.
      // Once this session has written the stamp, its absence means an older
      // version is writing these records from another window, so counting
      // stops here rather than compounding what that version has already done.
      if (downgraded || (stamped && persisted.basisVersion !== CURRENT_BASIS)) {
        downgraded = true;
        if (latestSummary) latestSummary.downgraded = true;
        status.text = '$(warning) Ledger paused: older version running';
        status.tooltip = 'Another VS Code window is running an older AI Impact Ledger and has rewritten these records in an older format, so the figures may be wrong. Counting is paused. Close that window or reload it with "Developer: Reload Window", reload this one, then run "AI Impact Ledger: Rebuild From Logs". Nothing was sent anywhere.';
        return;
      }
      const rebuilding = persisted.basisVersion !== CURRENT_BASIS;
      const previousCheckpoints = rebuilding
        ? {}
        : {...context.globalState.get(CHECKPOINT_KEY, {}), ...persisted.checkpoints};
      const scans = await Promise.all(roots.map(([root, provider]) => scanRoot(root, provider, previousCheckpoints[provider] || {}, secret)));
      const scannedCheckpoints = Object.fromEntries(scans.map((scan, index) => [roots[index][1], scan.checkpoints]));
      const monitor = {
        durationMs: scans.reduce((sum, scan) => sum + scan.diagnostics.durationMs, 0),
        filesRead: scans.reduce((sum, scan) => sum + scan.diagnostics.filesRead, 0),
        unchangedFiles: scans.reduce((sum, scan) => sum + scan.diagnostics.unchangedFiles, 0),
        filesSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.filesSkipped + scan.diagnostics.linksSkipped, 0),
        linesSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.linesSkipped, 0),
        recordsSkipped: scans.reduce((sum, scan) => sum + scan.diagnostics.recordsSkipped, 0),
        schemaUnknown: scans.reduce((sum, scan) => sum + scan.diagnostics.schemaUnknown, 0),
        duplicateResponseIds: scans.reduce((sum, scan) => sum + scan.diagnostics.duplicateResponseIds, 0),
        unmatchedLegacyRecords: scans.reduce((sum, scan) => sum + scan.diagnostics.unmatchedLegacyRecords, 0)
      };
      const coverageIncomplete = monitor.filesSkipped + monitor.linesSkipped + monitor.recordsSkipped + monitor.schemaUnknown > 0;
      const coverageText = [monitor.filesSkipped ? `${monitor.filesSkipped} log file(s) skipped` : '',
        monitor.linesSkipped ? `${monitor.linesSkipped} oversized log line(s) skipped` : '',
        monitor.recordsSkipped ? `${monitor.recordsSkipped} malformed usage record(s) skipped` : '',
        monitor.schemaUnknown ? `${monitor.schemaUnknown} usage record(s) in an unrecognised format` : ''].filter(Boolean).join('; ');
      // One wording for both paths, so a refresh with nothing new never
      // drops a disclosure the full refresh makes.
      const tooltip = () => `${latestSummary.start} to ${latestSummary.end} (${latestSummary.timeZone}). API-equivalent cost estimate${latestSummary.total.hasUnknownCost ? '; some calls lack a defensible reference cost' : ''}${latestSummary.total.hasPartialCost ? '; earlier cache writes without a recorded duration are excluded, so cost is understated' : ''}; energy ${statusSummary(latestSummary).energyRange}, excluding the energy of re-reading cached context.${coverageIncomplete ? ` ${coverageText}; totals may be incomplete.` : ''}${evidence.isOverdue ? ` Evidence review overdue: ${evidence.overdue.join(', ')}.` : ''} Select for context.`;
      if (!rebuilding && latestSummary && scans.every((scan) => scan.diagnostics.filesRead === 0)
          && JSON.stringify(scannedCheckpoints) === JSON.stringify(persisted.checkpoints)
          && persisted.revision === lastRevision && settingsKey === lastSettingsKey
          && latestSummary.day === todayLocal()) {
        latestSummary.monitor = monitor;
        latestSummary.lastScanAt = new Date().toISOString();
        status.text = status.text.replace(/\$\((pulse|warning)\)/, coverageIncomplete || evidence.isOverdue ? '$(warning)' : '$(pulse)');
        status.tooltip = tooltip();
        return;
      }
      const incoming = scans.flatMap((scan) => scan.events).map((event) => {
        const clean = sanitiseEvent(event);
        clean.id = hashEventId(clean.id, secret);
        // Flagged here, where the registry is known, so the daily totals keep
        // the call apart from standard-rate calls.
        if (!pricedAtStandardRates(clean, registry)) clean.nonStandardTier = true;
        return clean;
      });
      const saved = await store.update((current) => {
        const purgedBefore = current.purgedBefore || context.globalState.get(PURGED_BEFORE_KEY) || null;
        // Detail removed by a purge or by the storage cap is already in the
        // daily totals. A changed log re-emits those calls, so they are
        // excluded here rather than counted again.
        const cutoff = [purgedBefore, current.trimmedBefore].filter(Boolean).sort().at(-1) || null;
        // The rebuild needs the same notion of a partly covered day: the
        // latest of the purge watermark, the trim cut-off and the retention
        // window, as they stand before this write.
        const completeFrom = [cutoff, new Date(Date.now() - retentionDays * 86_400_000).toISOString()]
          .filter(Boolean).sort().at(-1);
        // Detail written under the old basis carries no tier flag, so a long
        // prompt in it would otherwise be folded into a standard-rate row.
        const stored = mergeEvents(context.globalState.get(DETAIL_KEY, []), current.detail)
          .map((event) => pricedAtStandardRates(event, registry) ? event : {...event, nonStandardTier: true});
        const existing = rebuilding ? [] : stored;
        const eligibleIncoming = applyRetention(afterTimestamp(incoming, cutoff), retentionDays);
        const retained = applyRetention(mergeEvents(afterTimestamp(existing, cutoff), eligibleIncoming), retentionDays);
        const carried = {...context.globalState.get(DAILY_KEY, {}), ...current.daily};
        // Detail recorded under the old basis is discarded, so fold what it
        // contributed into the daily totals first. Days the current logs still
        // cover are then recomputed; the rest survive, marked as pre-correction.
        const previousDaily = rebuilding
          ? reconcileDailyFloor(carried, afterTimestamp(stored, cutoff))
          : carried;
        return {
          detail: retained,
          daily: rebuilding
            ? rebuildDaily(previousDaily, retained, {purgedBefore: cutoff, completeFrom})
            : reconcileDailyFloor(updateDaily(previousDaily, existing, eligibleIncoming), retained),
          checkpoints: scannedCheckpoints,
          purgedBefore,
          basisVersion: CURRENT_BASIS
        };
      });
      stamped = true;
      await Promise.all([
        context.globalState.update(DETAIL_KEY, undefined),
        context.globalState.update(DAILY_KEY, undefined),
        context.globalState.update(CHECKPOINT_KEY, undefined)
      ]);
      // Read after the write, because the write itself may have trimmed and
      // moved the cut-off. Detail is complete only after the latest of the
      // purge watermark, the storage trim and the retention window.
      const detailCompleteFrom = [saved.purgedBefore, saved.trimmedBefore,
        new Date(Date.now() - retentionDays * 86_400_000).toISOString()].filter(Boolean).sort().at(-1);
      latestSummary = buildSummary(saved.detail, registry, 'unknown',
        {settings, daily: saved.daily, trimmedBefore: saved.trimmedBefore,
          purgedBefore: saved.purgedBefore, detailCompleteFrom});
      const metadata = await store.readMetadata();
      lastRevision = metadata.revision;
      lastSettingsKey = settingsKey;
      if (!capacityWarned && needsCapacityWarning(metadata.storageBytes, metadata.limitBytes)) {
        capacityWarned = true;
        vscode.window.showWarningMessage('AI Impact Ledger storage is approaching its 64 MiB limit. At the limit, the oldest detailed records are removed and their daily totals kept; a shorter detail-retention setting avoids this.');
      }
      latestSummary.monitor = monitor;
      const cost = convertCost(latestSummary.total.cost.central, settings.currency);
      const symbol = {USD: 'US$', AUD: 'A$', GBP: '£', EUR: '€'}[settings.currency];
      const icon = coverageIncomplete || evidence.isOverdue ? '$(warning)' : '$(pulse)';
      const unpricedCalls = (latestSummary.providers?.anthropic?.unpricedCalls || 0)
        + (latestSummary.providers?.openai?.unpricedCalls || 0);
      // A period in which nothing can be priced is not a period that cost nothing.
      const money = latestSummary.total.hasUnknownCost && latestSummary.calls > 0 && latestSummary.calls === unpricedCalls
        ? 'No reference price'
        : `${symbol}${cost.value.toFixed(2)}${latestSummary.total.hasPartialCost ? '+' : ''}`;
      const figures = statusSummary(latestSummary);
      status.text = settings.statusBarMeasure === 'energy'
        ? `${icon} ${figures.energy}`
        : `${icon} ${money} · ${figures.energy}`;
      status.tooltip = tooltip();
    } catch {
      // A stale report must say so: the panel would otherwise show the last
      // good figures with a fresh clock.
      if (latestSummary) latestSummary.stale = true;
      status.text = '$(warning) Impact unavailable';
      status.tooltip = 'AI Impact Ledger could not parse local usage metadata. No data was sent anywhere.';
    } finally {
      // An open report is redrawn on every path out, including the
      // nothing-changed shortcut, so a changed setting, a purge or a timed
      // refresh never leaves old figures on screen.
      for (const panel of panels) panel.webview.html = reportHtml(latestSummary || buildSummary([], registry, 'unknown'));
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand('aiImpactLedger.refresh', refresh));
  context.subscriptions.push(vscode.commands.registerCommand('aiImpactLedger.showReport', async () => {
    const panel = vscode.window.createWebviewPanel('aiImpactLedger.report', 'AI Impact Ledger', vscode.ViewColumn.Beside,
      {enableScripts: false, enableCommandUris: ['aiImpactLedger.openSettings'], localResourceRoots: [], retainContextWhenHidden: false});
    panels.add(panel);
    panel.onDidDispose?.(() => panels.delete(panel));
    await refresh();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('aiImpactLedger.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:stritheo.ai-impact-ledger');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('aiImpactLedger.rebuildFromLogs', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Rebuild AI Impact Ledger daily totals from your local logs? The stored totals are replaced by what the logs contain. Detailed records you deleted are not restored, and nothing is sent anywhere.',
      {modal: true}, 'Rebuild');
    if (answer !== 'Rebuild') return;
    const config = vscode.workspace.getConfiguration('aiImpactLedger');
    const retentionDays = config.get('detailRetentionDays', 90);
    const secret = await sharedSecret(context.globalStorageUri.fsPath, context.globalState);
    // Every log is read from the start, because a rebuild exists precisely
    // when the stored counts can no longer be trusted to resume from.
    const scans = await Promise.all(roots.map(([root, provider]) => scanRoot(root, provider, {}, secret)));
    const checkpoints = Object.fromEntries(scans.map((scan, index) => [roots[index][1], scan.checkpoints]));
    const events = mergeEvents(scans.flatMap((scan) => scan.events).map((event) => {
      const clean = sanitiseEvent(event);
      clean.id = hashEventId(clean.id, secret);
      if (!pricedAtStandardRates(clean, registry)) clean.nonStandardTier = true;
      return clean;
    }));
    const saved = await store.update((current) => {
      const purgedBefore = current.purgedBefore || context.globalState.get(PURGED_BEFORE_KEY) || null;
      const cutoff = [purgedBefore, current.trimmedBefore].filter(Boolean).sort().at(-1) || null;
      return {
        detail: applyRetention(afterTimestamp(events, cutoff), retentionDays),
        daily: aggregateByDay(events),
        checkpoints,
        purgedBefore,
        basisVersion: CURRENT_BASIS
      };
    });
    stamped = true;
    downgraded = false;
    await refresh();
    const days = Object.keys(saved.daily).length;
    vscode.window.showInformationMessage(`AI Impact Ledger rebuilt from your local logs: ${days} daily ${days === 1 ? 'total' : 'totals'} recomputed.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('aiImpactLedger.purgeDetail', async () => {
    const legacyBackupExists = fs.existsSync(store.file);
    const prompt = legacyBackupExists
      ? 'Delete all detailed AI Impact Ledger records? The older rollback copy will also be deleted. Daily aggregates will remain.'
      : 'Delete all detailed AI Impact Ledger records? Daily aggregates will remain.';
    const answer = await vscode.window.showWarningMessage(prompt, {modal: true}, 'Delete detail');
    if (answer === 'Delete detail') {
      const purgedBefore = new Date().toISOString();
      await store.update((persisted) => ({...persisted, detail: [], purgedBefore}), {purgeRollback: true});
      await context.globalState.update(PURGED_BEFORE_KEY, purgedBefore);
      await refresh();
      vscode.window.showInformationMessage(legacyBackupExists
        ? 'AI Impact Ledger detailed records and the older rollback copy deleted.'
        : 'AI Impact Ledger detailed records deleted.');
    }
  }));

  await refresh();
  let timer;
  const schedule = () => {
    if (timer) { clearInterval(timer); timers.delete(timer); }
    timer = setInterval(refresh, refreshMinutes() * 60_000);
    timers.add(timer);
  };
  schedule();
  context.subscriptions.push({dispose: () => { clearInterval(timer); timers.delete(timer); }});
  const watcher = vscode.workspace.onDidChangeConfiguration?.((event) => {
    if (event.affectsConfiguration('aiImpactLedger.refreshMinutes')) schedule();
    // Every other setting changes what the status bar and an open report say.
    else if (event.affectsConfiguration('aiImpactLedger')) return refresh();
    return undefined;
  });
  if (watcher) context.subscriptions.push(watcher);
}

function deactivate() {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
}

module.exports = { activate, deactivate };
