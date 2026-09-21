# Contributing

Thank you for looking. This is a small, deliberately constrained project.

## Before you open a pull request

1. `npm run verify` must pass. It runs the tests, the source check and the
   security policy audit.
2. Add a test that fails without your change. Extension-host behaviour is
   driven through the stub in `test/`, not a live VS Code instance.
3. Do not add a runtime dependency. The audit fails the build if you do, and a
   zero-dependency supply chain is a feature of this extension.
4. Do not add network calls, telemetry or subprocesses. Same reason.

## Changing a figure

Every price, energy, water or carbon factor must resolve to an entry in
`src/data/impact-registry.v1.json` carrying a publisher, a publication date, a
geography, a unit, a boundary and a derivation. `npm run evidence:check`
enforces it. A change with no primary source will not be merged, however
reasonable the number looks.

## Reporting a security issue

Use GitHub private vulnerability reporting, described in `SECURITY.md`. Please
do not include real prompts, credentials or usage logs.
