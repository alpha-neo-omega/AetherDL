# ADR-008: `web-ext` as a development dependency for Firefox extension e2e

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

[PROJECT_BIBLE.md §16.3](../../PROJECT_BIBLE.md#163-browser-tests) requires browser tests driving
actual extension builds across Chromium **and** Firefox, and
[ROADMAP.md Phase 9](../../ROADMAP.md#phase-9--testing--quality-assurance) makes those suites an
acceptance criterion.

Playwright — the browser-test tool ratified in
[ADR-002](../../PROJECT_BIBLE.md#adr-002-typescript--vite--vitest--playwright-minimal-dependencies) —
can load an unpacked extension into Chromium (`launchPersistentContext` with `--load-extension`),
but it has no API to install a WebExtension into Firefox. Without additional tooling the Firefox
half of §16.3 cannot be automated at all, leaving the target verified only by the manual matrix
([§16.7](../../PROJECT_BIBLE.md#167-manual-test-matrix)).

`web-ext` is Mozilla's official extension tool. It packages an unpacked build into a signed-format
archive and runs Firefox with the extension installed, which is the mechanism the Firefox browser
tests need.

Alternatives considered:

- **Selenium + geckodriver** — two dependencies instead of one, and a second browser-automation
  stack alongside Playwright.
- **Engine-level tests only** (serve the built pages, stub the WebExtension namespace) — no new
  dependency, but it never exercises a real Firefox extension install, so §16.3 stays unmet.
- **Manual-only Firefox verification** — leaves the acceptance criterion dependent on a human pass
  every release.

## Decision

Add `web-ext` as a **development dependency only**, used by the Phase 9 Firefox browser tests to
package and install `dist/firefox` into a Firefox profile. It is never shipped: it appears in no
extension bundle, no manifest, and no runtime code path.

## Consequences

Positive:

- Firefox browser tests exercise the real, installed extension rather than a stub.
- The tool is Mozilla's own, is what AMO submission uses, and keeps the packaging path
  ([Phase 10](../../ROADMAP.md#phase-10--release-preparation)) consistent with what is tested.

Negative / accepted trade-offs:

- One more development dependency and its transitive tree (`addons-linter` and below), enlarging
  the audit surface required by
  [§13.9](../../PROJECT_BIBLE.md#139-dependency--supply-chain-security). `npm audit --omit=dev`
  reports **0 vulnerabilities**; the dev tree carries a high-severity advisory in
  `image-size` (via `addons-linter`), which is reachable only when linting attacker-supplied icon
  files and never at runtime.
- The stack remains otherwise frozen: no production dependency, no replacement of Playwright, no
  second automation framework for Chromium.

## Owner Approval

Approved by the Project Owner on 2026-08-19, in response to the Phase 9 startup-gate escalation
reporting that Playwright cannot install a WebExtension into Firefox.
