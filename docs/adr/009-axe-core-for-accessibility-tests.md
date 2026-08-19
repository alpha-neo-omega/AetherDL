# ADR-009: `axe-core` as a development dependency for automated accessibility tests

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

[PROJECT_BIBLE.md §16.6](../../PROJECT_BIBLE.md#166-accessibility-tests) requires automated
accessibility checks ("e.g. axe") on popup, settings and history, and
[ROADMAP.md Phase 9](../../ROADMAP.md#phase-9--testing--quality-assurance) makes the accessibility
suite an acceptance criterion. [§17](../../PROJECT_BIBLE.md#17-accessibility) sets WCAG 2.1 AA as
the standard.

Hand-written DOM assertions can cover named checks (accessible names, label binding, unique ids,
focus order) but they encode only the rules the author thought of, and they drift from the
standard as the surfaces grow.

`axe-core` is the rule engine the Bible names by example. It runs against a DOM — including the
jsdom trees the existing UI tests already render through `tests/unit/ui/_render.tsx` — so it needs
no new test architecture and no browser.

## Decision

Add `axe-core` as a **development dependency only**, used by the Phase 9 accessibility suite to
run the WCAG 2.0/2.1 A and AA rule sets over the rendered popup, settings and history surfaces. It
is never shipped: it appears in no extension bundle, no manifest, and no runtime code path.

## Consequences

Positive:

- Accessibility is asserted against the published rule set rather than a bespoke checklist.
- Violations fail the quality gate with rule ids and DOM targets, so regressions are actionable.
- Complements, and does not replace, the existing token-level AA contrast tests and the manual
  keyboard/screen-reader pass in the manual matrix
  ([§16.7](../../PROJECT_BIBLE.md#167-manual-test-matrix)).

Negative / accepted trade-offs:

- One more development dependency to audit under
  [§13.9](../../PROJECT_BIBLE.md#139-dependency--supply-chain-security). `axe-core` ships as a
  single self-contained package with no runtime dependencies, and `npm audit --omit=dev` reports
  **0 vulnerabilities**.
- jsdom has no layout engine, so rules that need geometry (for example target size) cannot run
  there; those remain covered by the manual matrix.

## Owner Approval

Approved by the Project Owner on 2026-08-19, in response to the Phase 9 startup-gate escalation
asking whether the a11y suite should use axe or hand-written checks.
