# Architecture Decision Records (ADRs)

The **ratified** ADRs for AetherDL (ADR-001 … ADR-006) live in the source of truth,
[PROJECT_BIBLE.md §24](../../PROJECT_BIBLE.md#24-architecture-decision-records-adrs), and are
summarized in [ARCHITECTURE.md §24](../../ARCHITECTURE.md#24-architectural-decision-records).

This directory holds **future** ADRs authored under the change-control process
([PROJECT_BIBLE.md §25](../../PROJECT_BIBLE.md#25-change-control--amendment-process)). New ADRs:

1. Copy [`000-template.md`](000-template.md) to `NNN-short-title.md` (next number).
2. Fill in the sections; set status to `Proposed`.
3. Obtain Project Owner approval; mark `Accepted` and record approval.
4. If the decision changes architecture, amend PROJECT_BIBLE.md and increment its version.

## Accepted ADRs in this directory

| ADR | Title | Date |
| --- | --- | --- |
| [ADR-008](008-web-ext-for-firefox-e2e.md) | `web-ext` for Firefox e2e | 2026-08-19 |
| [ADR-009](009-axe-core-for-accessibility-tests.md) | `axe-core` for accessibility tests | 2026-08-19 |
| [ADR-010](010-non-drm-stream-assembly.md) | Non-DRM HLS/DASH assembly, and the network claim | 2026-08-20 |

> ADRs here never supersede PROJECT_BIBLE.md. An accepted ADR is applied by amending the Bible.
> ADR-010 has been applied that way: the Bible is at version 1.1.0, with §14.3 amended.
