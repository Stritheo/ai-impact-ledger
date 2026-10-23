// Formats the assurance report for the hosted run's summary page. Only our
// own gate names, results and the artefact hash are written.
export function assuranceSummary(report, artefact) {
  const build = report.gates.find((gate) => gate.gate === 'reproducible valid VSIX');
  if (!build || !/^[a-f0-9]{64}$/.test(build.sha256 || '')) throw new Error('the VSIX hash is missing from the assurance report');
  return [
    `## Assurance ${report.generatedAt.slice(0, 10)}`, '',
    `\`${artefact}\` SHA-256: \`${build.sha256}\``, '',
    'Compare this with a clean local build of the same commit before release.', '',
    '| Gate | Result |', '|---|---|',
    ...report.gates.map((gate) => `| ${gate.gate} | ${gate.result} |`), '',
    `Decision: ${report.releaseDecision}`
  ].join('\n');
}
