# AetherDL

> **Fast. Private. Powerful.**
> A modern cross-browser media downloader.

AetherDL is a cross-browser (Chrome, Edge, Brave, Opera, Vivaldi, Firefox), Manifest V3,
privacy-first media downloader. It detects downloadable, **non-DRM** media on the active tab and
downloads it using native browser facilities — entirely on-device, with **zero** telemetry,
tracking, or cloud dependency.

## Source of Truth

This repository is governed by four permanent documents. **Read them before contributing.**

| Document                             | Role                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| [PROJECT_BIBLE.md](PROJECT_BIBLE.md) | Single source of truth — architecture, features, standards, security, privacy. |
| [ARCHITECTURE.md](ARCHITECTURE.md)   | Definitive technical architecture reference.                                   |
| [AGENT_RULES.md](AGENT_RULES.md)     | Operational handbook for AI coding agents.                                     |
| [ROADMAP.md](ROADMAP.md)             | Execution and scheduling authority.                                            |

The architecture is **static**. Do not restructure folders, add frameworks, or change
dependencies without approval (see [PROJECT_BIBLE.md §25](PROJECT_BIBLE.md#25-change-control--amendment-process)).

## Status

**1.0.0 — Stable Release, declared 2026-08-20; the project is now in maintenance** (defect fixes and
patch releases only, no new scope without change control — ROADMAP.md §6). The product is
implemented and gated: per-tab media
detection, downloads through the browser's own download manager with a durable queue, retry and
pause/resume, settings, local history, popup and settings surfaces, and the optional context-menu
and notification integrations. Everything runs on the device: no backend, no accounts, no
analytics, no telemetry, and no network call of the extension's own
([PROJECT_BIBLE.md §14](PROJECT_BIBLE.md#14-privacy)).

Known limitations at 1.0.0, stated in full in [CHANGELOG.md](CHANGELOG.md):

- Non-DRM HLS and DASH manifests are detected and listed, but **cannot be downloaded** — stream
  assembly is not implemented.
- Network-request observation is not implemented; detection reads the page's DOM.
- DRM-protected media is refused by design and always will be
  ([PROJECT_BIBLE.md §6](PROJECT_BIBLE.md#6-unsupported-content)).
- The _Warn about duplicates_ setting is stored but inert: nothing compares detected media against
  download history. The popup does flag media already in the queue.
- No file size is shown for detected media; size would come from network observation.
- The extension icons are placeholders.
- Verified on Chromium and Firefox only. Edge, Brave, Opera and Vivaldi share the Chromium engine
  and the same artifact but were not run; several manual cases (screen reader, notification and
  toolbar UI, private windows, a streaming fixture) are recorded as NOT EXECUTED in
  [docs/MANUAL_TEST_MATRIX.md](docs/MANUAL_TEST_MATRIX.md).

Nothing has been submitted to or published on any extension store from this repository; store
submission is a gated manual step ([PROJECT_BIBLE.md §18.8](PROJECT_BIBLE.md#188-cicd)) and
distribution is via official stores only ([§18.6](PROJECT_BIBLE.md#186-release-strategy)).

## Requirements

- Node.js `>=20` (see [.nvmrc](.nvmrc))
- npm (bundled with Node)

## Getting Started

```bash
npm install          # tooling + the two runtime dependencies (react, react-dom)
npm run typecheck    # strict TypeScript type-check
npm run lint         # ESLint incl. layer-boundary rules
npm run format:check # Prettier formatting check
npm test             # Vitest unit/integration tests
npm run build        # build unpacked extensions for both targets
```

## Build Outputs

`npm run build` produces load-unpacked extensions from a **single source tree**:

- `dist/chrome/` — Chromium (Chrome, Edge, Brave, Opera, Vivaldi)
- `dist/firefox/` — Firefox

Load either directory via the browser's "load unpacked / temporary add-on" developer flow.

## Scripts

| Script                                             | Purpose                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                | Type-check with strict TypeScript.                                                                                          |
| `npm run lint` / `lint:fix`                        | Lint (zero warnings) / autofix.                                                                                             |
| `npm run format` / `format:check`                  | Format / check formatting.                                                                                                  |
| `npm test` / `test:watch` / `test:coverage`        | Unit, integration, accessibility & regression tests.                                                                        |
| `npm run test:perf`                                | Performance budgets, on their own single-fork runner.                                                                       |
| `npm run test:e2e`                                 | Browser tests: real Chromium install, real Firefox install over Marionette.                                                 |
| `npm run build` / `build:chrome` / `build:firefox` | Production builds.                                                                                                          |
| `npm run dev:chrome` / `dev:firefox`               | Development (unminified, watch).                                                                                            |
| `npm run validate:manifest`                        | Validate generated manifests and bundle budgets.                                                                            |
| `npm run security:gate`                            | Security review checklist over source and both builds.                                                                      |
| `npm run lint:extension`                           | Mozilla's add-on linter over the Firefox build.                                                                             |
| `npm run package`                                  | Validate, then write one deterministic store archive per target.                                                            |
| `npm run screenshots`                              | Capture store screenshots from the built extension.                                                                         |
| `npm run gen:icons`                                | Regenerate placeholder icon assets.                                                                                         |
| `npm run ci`                                       | Full gate: typecheck, lint, format, tests, performance, builds, manifest validation, security gate, packaging, browser e2e. |

## Release

`npm run package` writes the store archives and their checksums:

- `dist/release/aetherdl-<version>-chrome.zip` — Chrome Web Store, Edge Add-ons, Opera and other
  Chromium-compatible stores
- `dist/release/aetherdl-<version>-firefox.zip` — Firefox Add-ons (AMO)
- `dist/release/SHA256SUMS.txt`

Archives are deterministic for a given Node version, and each is validated and read back before it
is reported. Listing copy and the asset inventory live in [docs/STORE_LISTING.md](docs/STORE_LISTING.md);
the executed security and privacy audit is [docs/RELEASE_AUDIT.md](docs/RELEASE_AUDIT.md); the manual
browser matrix and its recorded results are [docs/MANUAL_TEST_MATRIX.md](docs/MANUAL_TEST_MATRIX.md).

## License

[MIT](LICENSE).
