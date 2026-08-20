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

**1.2.2 — third defect sweep, 2026-08-20.** Built on 1.1.0, which was built on the 1.0.0
stable release: per-tab media
detection, downloads through the browser's own download manager with a durable queue, retry and
pause/resume, settings, local history, popup and settings surfaces, and the optional context-menu
and notification integrations.

1.1.0 added, at the Project Owner's direction:

- **More containers.** MP4, WEBM, M4V, MKV, MOV, AVI, plus TS, M2TS, MTS, MPG/MPEG, WMV, FLV and
  3GP; audio as before.
- **Non-DRM HLS and DASH downloading.** A playlist (`.m3u8`) or manifest (`.mpd`) is parsed, its
  segments are fetched in order and joined into one file, which the browser's own download manager
  then saves. Encrypted streams are refused, always — see below.

### What this changes about the network

Through 1.0.0 the extension made **no network request of its own**. That is no longer true, and the
claim has been changed everywhere rather than quietly left standing: assembling a stream means
reading a playlist and its segments, so the extension now performs exactly those **GET requests**,
to the media host, with **no credentials and no cookies** (`credentials: 'omit'`), only for a
download the user asked for.

What has NOT changed: nothing is ever **sent**. No analytics, no telemetry, no beacon, no socket,
no crash report, no account, no backend. There is one code path in the whole codebase that can
reach the network (`src/platform/http/service.ts`), the release security gate fails the build if
`fetch` appears anywhere else or becomes reachable from a UI surface, and the popup, settings and
content-script payloads are proven — over the emitted import graph — unable to reach it
([docs/RELEASE_AUDIT.md](docs/RELEASE_AUDIT.md)).

Host access is asked for **at the moment you click download**, for the specific origins that
stream lives on, and never at install ([PROJECT_BIBLE.md §13.7](PROJECT_BIBLE.md#137-permissions)).
Declining it cancels that download and nothing else.

### DRM and encrypted streams: refused, permanently

An encrypted playlist or manifest — `#EXT-X-KEY` with any method but `NONE`, any
`ContentProtection`, any `pssh` — is refused before a single segment is fetched, and no key URI is
ever read, followed, logged or returned. There is no decryption code in this project and there
will not be ([PROJECT_BIBLE.md §6](PROJECT_BIBLE.md#6-unsupported-content),
[PROJECT_BIBLE.md §24 ADR-005](PROJECT_BIBLE.md#24-architecture-decision-records-adrs)).

### What the defect sweeps fixed

**1.2.2** took the five areas no earlier pass had touched, one at a time: the message
bus and event infrastructure, the settings service, the badge/notification/context-menu
runtimes, the content script's DOM scanning, and the build tooling. Twelve defects. Two
made features silently not work:

- **Media written with relative URLs was dropped** — `<source src="clip.mp4">` and media
  links reached the background as paths it could only refuse. `<video src>` survived only
  because browsers also report an absolute `currentSrc`, which is why no test caught it.
- **Granting the context-menu permission did nothing until a restart**, because the
  namespace only appears on grant and the code decided at start-up.

Also: one throwing event subscriber used to stall the download queue; `constructor` and
`toString` were accepted as settings; a bulk download run announced its tail job by job;
and a source map left by a development build was packaged into the release archive.

**1.2.1** hunted the detection engine and the storage layer, the two areas with the most
logic and the least recent scrutiny. Eight defects, all fixed; the one worth knowing about:
a dead IndexedDB connection was cached forever, so if the browser closed the connection —
storage cleared, database deleted — the extension **silently stopped saving the queue and
recording history for the rest of the session**. It now reconnects. Also: history no longer
grows without bound (5 000 records, oldest out), per-tab detection state is bounded to 50
tabs, and a queue save writes only the job that changed instead of every job.

**1.2.0** fixed thirteen defects found by hunting through the 1.1.0 code. Three produced
silently wrong results, which is the worst class of failure this project can ship. The ones
that matter to a user:

- A stream whose **audio is a separate track** was saved as video with **no sound**. It is
  now refused with a stated reason (see the limitations below).
- A server that ignored a byte-range request produced a **corrupt file**. Refused now.
- A failed download said only "Failed". It now says **why**, and an encrypted stream reads
  as protected media instead of "check your network".
- A stream started from the **context menu** failed with an opaque network error, because
  nothing had asked for host access. Every path asks now.
- **Site access is listed in Settings**, with a Revoke for each granted origin.

Known limitations at 1.2.2, stated in full in [CHANGELOG.md](CHANGELOG.md):

- **Streams that keep audio in a separate track cannot be downloaded.** Most real-world
  DASH, and much HLS, is packaged that way. AetherDL refuses rather than saving a silent
  video; joining the tracks (muxing) is out of scope.
- **Live** streams cannot be downloaded (a live playlist has no end); they are reported as such.
- A stream is assembled **in memory**, one at a time, refused past 1 GiB, and is **not
  resumable** — pausing or cancelling discards what was fetched. The joined file is the
  segments concatenated, with no remuxing: MPEG-TS segments produce a `.ts` file and fMP4
  segments a `.mp4` file. Players handle these; some editors prefer a remuxed file.
- **Firefox 115–127 cannot download streams at all.** Firefox added
  `optional_host_permissions` in 128, and asking for host access at point of use is the only way
  this project will take it. Progressive downloads are unaffected.
- Only the highest-bandwidth rendition is assembled; there is no quality picker for streams yet.
- Network-request observation is not implemented; detection reads the page's DOM. A site that
  loads its playlist purely through a script (hls.js and friends) may not be detected.
- DRM-protected media is refused by design and always will be.
- The _Warn about duplicates_ setting is stored but inert: nothing compares detected media against
  download history. The popup does flag media already in the queue.
- No file size is shown for detected media before a download starts.
- Verified on Chromium and Firefox only. Edge, Brave, Opera and Vivaldi share the Chromium engine
  and the same artifact but were not run; several manual cases (screen reader, notification and
  toolbar UI, private windows) are recorded as NOT EXECUTED in
  [docs/MANUAL_TEST_MATRIX.md](docs/MANUAL_TEST_MATRIX.md). Stream assembly is covered by
  automated tests at every layer, including an end-to-end HLS download in a real Chromium against
  a loopback fixture; it has **not** been tried against a live streaming site.

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
| `npm run gen:icons`                                | Re-render the icon set from its source geometry.                                                                            |
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
