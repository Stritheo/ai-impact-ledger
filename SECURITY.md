# Security policy

Please report vulnerabilities privately through GitHub private vulnerability
reporting on this repository. Do not include real prompts,
credentials or usage logs in a report.

## What the release gate requires

Every release must pass `npm run assure`: a clean dependency install, a
dependency audit, the full test suite, a line-coverage floor of 90 per cent,
the source-policy scan, SBOM generation, and a VSIX that builds to the same
hash twice. Critical or high-severity unresolved findings block release.

## Controls in place

- **Repository:** private. Branch protection on `main` requires the `verify`
  check and applies to administrators.
- **Actions:** only GitHub-owned actions may run, and every action must be
  pinned to a commit SHA. Workflow tokens are read-only and credentials are
  not persisted.
- **Source policy:** an automated scan fails the build if `src/` gains a
  network module, a network request, a subprocess, a credential API,
  environment harvesting or dynamic evaluation.
- **Supply chain:** no runtime dependencies. The SBOM is generated on every
  assurance run, and the packaged VSIX is byte-identical across hosts, so a
  distributed artefact can be matched to the build that produced it.
- **Evidence:** the monthly evidence workflow has no write permission and
  cannot change a production factor; it compares sources against stored
  baseline hashes and fails on any change.

## Controls not in place, and why

- **CodeQL:** GitHub requires a paid Advanced Security licence for private
  repositories. The source-policy scan and the test suite are the compensating
  controls; hosted assurance remains mandatory.
- **GitHub secret scanning:** also part of that paid licence and therefore not
  enabled. The assurance run scans tracked files and history for secret
  patterns instead. That is a pattern scan, not a guarantee.
- **Required reviewers on `main`:** not enabled. Branch protection applies to
  administrators, and the repository has a single maintainer, so requiring a
  second approving review would block all work rather than add assurance.
  Independent verification is done per release instead, by a session with no
  part in writing the change.

The extension deliberately has no runtime dependencies, network client,
credential access, shell execution, telemetry or workspace-content access.
