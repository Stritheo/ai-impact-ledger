import fs from 'node:fs';
import path from 'node:path';

const forbidden = [
  ['network module', /require\(['"]node:(?:http|https|net|tls|dns)['"]\)/],
  ['network request', /\bfetch\s*\(/],
  ['subprocess', /require\(['"]node:child_process['"]\)/],
  ['credential API', /vscode\.authentication|keytar|Keychain|SecretStorage/],
  ['environment harvesting', /process\.env/],
  ['dynamic evaluation', /\beval\s*\(|new Function\s*\(/]
];

const failures = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.js')) {
      const source = fs.readFileSync(target, 'utf8');
      for (const [name, pattern] of forbidden) if (pattern.test(source)) failures.push(`${target}: ${name}`);
    }
  }
}
walk('src');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (Object.keys(manifest.dependencies || {}).length) failures.push('package.json: runtime dependencies are forbidden');
const registry = JSON.parse(fs.readFileSync('src/data/impact-registry.v1.json', 'utf8'));
if (Date.parse(registry.nextReviewDue) < Date.now()) failures.push('impact registry review is overdue');
const fxRegistry = JSON.parse(fs.readFileSync('src/data/fx-registry.v1.json', 'utf8'));
if (!Number.isFinite(Date.parse(fxRegistry.nextReviewDue)) || Date.parse(fxRegistry.nextReviewDue) < Date.now()) failures.push('FX registry review is overdue');
if (!fxRegistry.source || !fxRegistry.sourceDate || !fxRegistry.reviewedAt) failures.push('FX registry provenance is incomplete');
if (!registry.priceBasis || !registry.boundary || !registry.reviewedAt || !registry.nextReviewDue) failures.push('impact registry provenance is incomplete');
if (!registry.carbon?.gramsCo2PerKwh || registry.carbon.gramsCo2ePerKwh) failures.push('electricity emissions must use the sourced CO2 boundary');
const evidenceFields = ['sourceUrl', 'publisher', 'publicationDate', 'effectiveDate', 'geography',
  'unit', 'boundary', 'derivation', 'confidence', 'licence', 'reviewedAt', 'nextReviewDue'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
function validateEvidence(reference, owner) {
  const evidence = registry.evidence?.[reference];
  if (!evidence) {
    failures.push(`registry: missing evidence for ${owner}`);
    return;
  }
  for (const field of evidenceFields) {
    if (!Object.hasOwn(evidence, field)) failures.push(`registry: ${owner} evidence lacks ${field}`);
  }
  if (!/^https:\/\//.test(evidence.sourceUrl || '')) failures.push(`registry: ${owner} evidence URL must use HTTPS`);
  if (Object.hasOwn(evidence, 'confidence') && !CONFIDENCE_LEVELS.includes(evidence.confidence)) {
    failures.push(`registry: ${owner} evidence confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (!Number.isFinite(Date.parse(evidence.reviewedAt)) || !Number.isFinite(Date.parse(evidence.nextReviewDue))) {
    failures.push(`registry: ${owner} evidence review dates are invalid`);
  } else if (Date.parse(evidence.nextReviewDue) < Date.now()) failures.push(`registry: ${owner} evidence review is overdue`);
  for (const field of ['publicationDate', 'effectiveDate']) {
    if (evidence[field] !== null && !Number.isFinite(Date.parse(evidence[field]))) failures.push(`registry: ${owner} evidence ${field} is invalid`);
  }
}
for (const factor of ['energy', 'water', 'carbon']) validateEvidence(registry[factor]?.evidenceRef, factor);
validateEvidence(registry.energy?.overheadEvidenceRef, 'energy overhead');
// Energy must stay a derived range: a single central figure is exactly what
// the evidence does not support.
const energyRanges = registry.energy?.whPerThousandTokens;
for (const tokenClass of ['input', 'cachedInput', 'cacheWrite', 'output']) {
  const range = energyRanges?.[tokenClass];
  if (!range || !Number.isFinite(range.low) || !Number.isFinite(range.high) || range.low < 0 || range.high < range.low) {
    failures.push(`registry: energy range for ${tokenClass} is missing or invalid`);
  } else if (range.high > 0) {
    validateEvidence(range.evidenceRef, `energy ${tokenClass}`);
  } else if (range.upperBoundEstablished !== false || !range.note) {
    // A class carrying zero is excluded, not measured as zero, and must say so.
    failures.push(`registry: energy range for ${tokenClass} is zero without recording that its upper bound is not established`);
  }
}
const pue = registry.energy?.overhead?.pue;
if (!pue || !Number.isFinite(pue.low) || !Number.isFinite(pue.high) || pue.low < 1 || pue.high < pue.low) {
  failures.push('registry: facility overhead range is missing or invalid');
}
if (!Array.isArray(registry.energy?.excludes) || registry.energy.excludes.length === 0) {
  failures.push('registry: energy must state what its range excludes');
}
if (registry.energy?.uncertaintyFactor !== undefined) failures.push('registry: energy must not carry a central-value uncertainty factor');
for (const factor of ['televisionWatts', 'waterGlassMillilitres']) {
  if (!(registry.analogies?.[factor] > 0)) failures.push(`registry: everyday comparison factor ${factor} is missing or invalid`);
}
// The glass is a stated convention rather than a measurement, so it must say so.
if (!registry.analogies?.waterGlassBasis) failures.push('registry: the glass comparison must state that it is a convention');
validateEvidence(registry.analogies?.evidenceRef, 'everyday comparisons');
for (const model of registry.models) {
  if (!model.source || !model.id || !Array.isArray(model.aliases)) failures.push(`registry: incomplete provenance for ${model.id || 'unknown model'}`);
  const price = model.priceUsdPerMillion;
  if (price && ['input', 'cachedInput', 'cacheWrite', 'output'].some((field) => !Number.isFinite(price[field]) || price[field] < 0)) {
    failures.push(`registry: invalid price categories for ${model.id}`);
  }
  if (price && model.provider === 'anthropic' && (!Number.isFinite(price.cacheWrite1h) || price.cacheWrite1h < 0)) {
    failures.push(`registry: missing one-hour cache price for ${model.id}`);
  }
  if (model.standardPriceMaxInputTokens !== undefined
      && !(Number.isSafeInteger(model.standardPriceMaxInputTokens) && model.standardPriceMaxInputTokens > 0)) {
    failures.push(`registry: invalid long-context threshold for ${model.id}`);
  }
  if (price) validateEvidence(model.priceEvidenceRef, model.id);
  else if (!model.unpricedReason) failures.push(`registry: missing unpriced reason for ${model.id}`);
  if (model.energyMultiplier !== 1) failures.push(`registry: unsupported model-specific energy multiplier for ${model.id}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Security policy checks passed: no runtime dependencies, networking, subprocesses, credential APIs or dynamic evaluation.');
}
