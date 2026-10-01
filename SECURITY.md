# Security policy

## Supported versions

Security fixes land on the latest minor release of the current major version
of `jsails` and every `@jsails/*` package. The framework and its packages share
a major version and are released together.

| Version | Supported |
| ------- | --------- |
| 1.x (latest minor) | Yes |
| Older 1.x minors | Upgrade to the latest minor |
| < 1.0 | No |

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
<https://github.com/ronald2wing/JSails/security/advisories/new>.
Do not open a public issue, pull request, or discussion for a suspected
vulnerability.

Include what you can of:

- the affected package(s) and version(s);
- the configuration needed to reproduce it (redact secrets);
- a minimal reproduction or proof of concept;
- the impact you believe it has.

## What to expect

- Acknowledgement within 3 business days.
- An initial assessment (accepted, needs more information, or declined, with
  the reason) within 10 business days.
- For an accepted report, a fix and a published GitHub security advisory
  (with a CVE where one applies), coordinated with you on timing. The default
  disclosure window is 90 days from the report, shorter when a fix ships
  sooner. You are credited in the advisory unless you ask not to be.

## Scope

In scope: the code in this repository as published to npm (`jsails` and the
`@jsails/*` packages), including the starter templates `jsails create`
generates, and the documented security invariants in
[`core/AGENTS.md`](core/AGENTS.md) (default-deny authorization, same-origin and
CSRF checks for cookie-authenticated mutations, signed server-component state,
allowlisted rich-text rendering).

Out of scope: vulnerabilities in third-party dependencies that are already
public (report those upstream; Dependabot and the CI `npm audit` step track
them here), issues that require a misconfiguration the documentation warns
against, and findings against the documentation website's hosting.

## How releases are protected

Releases are published only by `npm run release` (`scripts/release.mjs`) from
a version tag in GitHub Actions: the working tree must be clean, the full gate
must pass, every package is published with `--ignore-scripts`, and each tarball
carries an npm provenance attestation that links it to the source commit and
workflow run. Verify an installed tree with `npm audit signatures`.
