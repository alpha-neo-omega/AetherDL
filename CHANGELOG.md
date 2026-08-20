# Changelog

All notable changes to AetherDL are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(see [PROJECT_BIBLE.md §18.7](PROJECT_BIBLE.md#187-versioning) and
[ROADMAP.md §7](ROADMAP.md#7-versioning-strategy)).

## [Unreleased]

## [1.1.0] — Non-DRM stream downloads and a wider container set

A feature release, directed by the Project Owner on 2026-08-20 over the frozen 1.0.0 scope. It adds
progressive containers and — the substantial part — makes non-encrypted HLS and DASH streams
downloadable. See [ADR-010](docs/adr/010-non-drm-stream-assembly.md) for the decision and its costs.

### Added

- **Progressive containers**: `ts`, `m2ts`, `mts`, `mpg`, `mpeg`, `wmv`, `flv`, `3gp` join the
  existing `mp4`, `webm`, `m4v`, `mov`, `avi`, `mkv`. The MIME allowlist gained the matching types
  (`video/mp2t`, `video/mpeg`, `video/x-ms-wmv`, `video/x-flv`, `video/3gpp`, `video/x-ms-asf`,
  `video/3gpp2`, `audio/mp3`, `video/avi`, `video/msvideo`) (`src/shared/utils/media.ts`,
  `src/shared/constants/index.ts`).
- **HLS downloading**: a pure M3U8 parser that follows a master playlist to its highest-bandwidth
  variant, reads `#EXTINF` segments, `#EXT-X-MAP` initialisation segments, `#EXT-X-BYTERANGE`
  (including the continuation form with the offset omitted), and reports a live playlist as live
  (`src/core/download/stream/hls.ts`).
- **DASH downloading**: a pure MPD parser with its own bounded tag scanner — a Chromium MV3 service
  worker has no `DOMParser` — covering `SegmentTemplate` with `$Number$`/`$Time$`/`%0Nd` padding,
  `SegmentTimeline` with `@r` repeats, `SegmentList`/`SegmentURL` with media ranges, nested
  `BaseURL`, `Initialization`, and `mediaPresentationDuration`-derived segment counts
  (`src/core/download/stream/dash.ts`).
- **Assembly**: fetches the manifest and every segment in playlist order, reports per-segment
  progress on the job, enforces a 1 GiB total and 64 MiB per-segment ceiling, stops on abort, and
  reports which origins it actually read (`src/core/download/stream/assemble.ts`).
- **`platform/http`**: the single, read-only network adapter — GET only, `credentials: 'omit'`,
  `cache: 'no-store'`, http(s) only, `Range` support, per-request timeout, size ceilings, distinct
  error codes, retryable classification (`src/platform/http/`).
- **Delivery to the browser**: assembled bytes become a `blob:` URL that the Downloads API saves,
  so the transfer of record is still the browser's (`src/platform/objecturl/`,
  `src/core/download/stream/deliver.ts`).
- **Chromium offscreen assembly**: `offscreen` permission, an offscreen document that assembles and
  holds the blob, a readiness handshake before work is sent, and document lifetime tied to the
  bytes it holds (`src/runtime/offscreen/`, `src/platform/stream/offscreen.ts`).
- **Point-of-use host access**: `*://*/*` declared optional on both targets and requested on the
  download click for the specific origins in play, skipping the tab's own origin because
  `activeTab` already covers it (`src/runtime/popup/client.ts`, `build/manifest/targets.ts`).
- 133 new automated tests, including an end-to-end HLS download in a real Chromium against a
  loopback fixture, and an end-to-end refusal of an encrypted playlist
  (`tests/e2e/stream-chromium.spec.ts`).

### Changed

- **The network claim.** Through 1.0.0 the extension made no network request of its own. It now
  performs exactly the GET requests a stream download requires, to the media host, without
  credentials or cookies. Nothing is ever sent: no analytics, telemetry, beacon, socket or report.
  README, store listing, release audit and the security gate's own check name were all changed to
  say this, rather than leaving a claim the code no longer honours.
- **The security gate** now permits `fetch` in exactly one file (`src/platform/http/service.ts`)
  and, over the emitted import graph, fails the build if `fetch` appears in a bundle no assembly
  surface loads or in anything a UI surface can reach. Every other egress API stays forbidden
  everywhere (`build/scripts/security-gate.ts`, `tests/unit/build/security-gate.test.ts`).
- **Download validation** allows HLS/DASH only when the caller can actually assemble them; a build
  or context without assembly refuses them exactly as before. `blob:` and MediaSource delivery stay
  refused unconditionally (`src/core/download/validate.ts`).
- A stream job's saved filename takes the container assembly actually produced (`.ts` or `.mp4`)
  instead of the playlist's `.m3u8`/`.mpd`, and its byte total is the assembled size
  (`src/core/download/manager/manager.ts`).
- The popup's error copy distinguishes a declined host permission from a missing `downloads`
  permission, and an error's own message key now wins over its category when the catalogue has it
  (`src/ui/popup/errors.ts`, `src/ui/popup/strings.ts`, `public/_locales/en/messages.json`).
- Version `1.0.0` → `1.1.0`; artifacts repackaged as `aetherdl-1.1.0-chrome.zip` and
  `aetherdl-1.1.0-firefox.zip` with fresh checksums.

### Fixed

- The popup collapsed to a sliver instead of rendering at its 380px width. `max-inline-size: 100vw`
  was applied to a panel that a browser popup measures from its own content, where the reported
  viewport can be a few pixels wide before layout; the cap now yields to a 320px floor rather than
  to nothing. Verified in a real Chromium at 1280px, 400px and 120px viewports
  (`src/ui/design-system/styles.css`, `tests/e2e/chromium.spec.ts`).

### Security

- **Encryption is refused three times over**: at classification (DRM/EME media is `unsupported`), at
  download validation, and inside the parsers themselves — any `#EXT-X-KEY`/`#EXT-X-SESSION-KEY`
  with a method other than `NONE`, any `ContentProtection`, `cenc:pssh` or `pssh` ends parsing
  before a single segment is fetched. A key URI is never read, followed, returned or logged, and
  tests assert that no key host or filename appears anywhere in a refusal
  (PROJECT_BIBLE.md §6, ADR-005).
- No host permission is granted at install on either target. The Firefox route of declaring the
  pattern under `host_permissions` was **measured and rejected**: `permissions.getAll()` reported
  the origin already granted, so both targets use `optional_host_permissions`.
- Unchanged: strict MV3 CSP (`script-src 'self'; object-src 'none'`), no remote code, no dynamic
  evaluation, no analytics, no telemetry, no backend, no accounts, and no setting that could enable
  any of them.

### Known limitations

- **Firefox 115–127 cannot download streams.** `optional_host_permissions` arrived in Firefox 128,
  and taking host access at install instead was rejected on least-privilege grounds. Progressive
  downloads are unaffected on those versions.
- Live streams cannot be downloaded; they are reported as live rather than attempted.
- A stream is assembled in memory and refused past 1 GiB.
- No remuxing: MPEG-TS segments concatenate to `.ts`, fMP4 segments to `.mp4`. Players handle these;
  some editors prefer a remuxed file.
- Only the highest-bandwidth rendition is assembled — no quality picker for streams yet.
- Detection still reads the DOM, so a site that loads its playlist purely through a script may not
  be detected; network-request observation remains unimplemented.
- Stream assembly has **not** been exercised against a live streaming site; its browser coverage is
  the loopback HLS fixture. No DASH end-to-end browser case exists (the DASH parser and assembly are
  covered by unit tests).
- Carried forward from 1.0.0: the _Warn about duplicates_ setting is stored but inert; no file size
  is shown before a download starts; the icons are placeholders; the manual cases recorded as NOT
  EXECUTED in `docs/MANUAL_TEST_MATRIX.md` remain unexecuted.
- Governance, for the record rather than as a limitation: **PROJECT_BIBLE.md was amended to 1.1.0**
  on Owner approval (2026-08-20, ADR-010). §14.3 is retitled "External Network Calls by the
  Extension" and now states the permitted activity exhaustively; §2.6, §5.1, §7.4, §10.6, §12.1,
  §13.3, §22.11 and §24 were amended with it, and AGENT_RULES.md, ARCHITECTURE.md and ROADMAP.md
  were brought into line. §14.1 and §25.3 are untouched — no analytics, telemetry, tracking, data
  collection, cloud, backend, accounts or identifiers, and the DRM boundary, all remain permanent.

### Not done

- Nothing was submitted to or published on any extension store, and no GitHub release was created.

## [1.0.0] — Phase 11: Stable Release

First stable release. **No product code changed**: every file under `src/` is byte-identical to the
audited `0.9.1` candidate, so everything the `0.9.1` entry records below applies verbatim, and the
shipped behaviour is the candidate's behaviour. What did change to reach 1.0.0 is the version, the
release artifacts, the release documentation, and — outside the shipped bundle — three test and
tooling items, all listed under Changed.

### Changed

- Version `0.9.1` → `1.0.0`, taken from the single source (`package.json`) that both target
  manifests are generated from, so `dist/chrome/manifest.json` and `dist/firefox/manifest.json`
  both read `1.0.0` (PROJECT_BIBLE.md §18.7, §7.6).
- Release artifacts rebuilt and repackaged at `1.0.0`: `aetherdl-1.0.0-chrome.zip` and
  `aetherdl-1.0.0-firefox.zip`, with fresh SHA-256 checksums. The `0.9.1` archives were removed by
  the packager, so no candidate artifact can be mistaken for the stable release.
- Store screenshots recaptured from the `1.0.0` build (`npm run screenshots`).
- Verification and tooling, none of it shipped: a browser case that checks the configured filename
  template and download subfolder against the file a real Firefox actually wrote
  (`tests/e2e/matrix-firefox.spec.ts`); the Firefox e2e profile now keeps downloaded fixtures inside
  its throwaway profile instead of the operator's Downloads folder; the security gate now enforces
  the whole remote-code pattern family on first-party bundles and reports the one vendor-chunk
  exclusion instead of skipping two patterns silently; a unit-test fixture version constant was made
  version-agnostic; `package-lock.json` records the release version.

### Known limitations

Carried forward from `0.9.1`, unchanged and still accurate:

- Non-DRM HLS and DASH streams are detected and listed, but cannot be downloaded — stream assembly
  (PROJECT_BIBLE.md §10.6) is unimplemented (`src/core/download/stream/index.ts` is a contract only,
  and `src/core/download/validate.ts` refuses `hls`/`dash`). PROJECT_BIBLE.md §5.2 lists non-DRM
  `.m3u8`/`.mpd` as supported media, so this is an unfinished capability, not a protection boundary,
  and it is distinct from the DRM refusal.
- Network-request observation is not implemented: `NetworkObserver`
  (`src/platform/network/index.ts`) is a contract with no implementation, `networkResources` is
  never populated, and the registered `network-media` detector is therefore inert. Detection works
  from DOM observations only; HLS/DASH manifests are still detected from observed URLs and DOM
  signals.
- The _Warn about duplicates_ setting is persisted, validated and shown, but nothing reads it: no
  code compares detected media against download history, so the toggle changes nothing. The popup's
  "already in the download queue" flag is live-queue state, not history
  (`src/ui/components/media-card.tsx`). PROJECT_BIBLE.md §4.6 makes the history comparison a MAY, so
  no requirement is breached — but the shipped help text promises it, which is why it is recorded
  here. The Owner decided on 2026-08-20 that 1.0.0 ships with the control unchanged and inert; it is
  not implemented, hidden or modified in this release.
- No file size is shown for a detected item, and the "estimated size" label is unreachable: both
  depend on network observation, which is unimplemented (see the previous bullet on
  `NetworkObserver`).
- The extension icons are the placeholders `npm run gen:icons` produces; a store listing needs the
  real icon set (docs/STORE_LISTING.md §7).
- The manual matrix still records the cases no automation here could perform — the screen-reader
  pass, notification and toolbar UI, private-window behaviour, a streaming fixture, and the Edge,
  Brave, Opera and Vivaldi browsers (docs/MANUAL_TEST_MATRIX.md §5).

### Notes

- Nothing in this release was submitted to or published on any store from this environment. Store
  submission requires accounts and credentials that only the Project Owner holds, and
  PROJECT_BIBLE.md §18.8 makes it "a gated manual step"; distribution is via official stores only
  (§18.6, non-goal N17).
- No release tag was created: this working tree is not a git repository, so tagging could not be
  performed here.
- Two of the project's own success criteria remain a matter of record rather than of code: Phase 5's
  acceptance included non-DRM stream assembly, which the first known limitation above shows is
  unfinished.
- **Declared stable by the Project Owner on 2026-08-20** (ROADMAP.md Phase 11 Definition of Done),
  subject to the limitations above and to the dated exception in `docs/MANUAL_TEST_MATRIX.md` §5.
  Non-DRM HLS/DASH downloading is **deferred**; the _Warn about duplicates_ control ships **inert**
  and is not implemented in this release; the human-only test cases **remain unexecuted**; Edge,
  Brave, Opera and Vivaldi **remain untested**. The project enters the Maintenance state
  (ROADMAP.md §6): defect fixes and patch releases only, no new scope without change control. The
  full record is `docs/RELEASE_AUDIT.md` §7.

## [0.9.1] — Phase 10: Release Preparation

### Added

- Detection engine (`core/detection`): priority-ordered detector manager with a per-detector
  timeout and candidate cap, over a deterministic pipeline — validate, build (normalize +
  metadata), score, deduplicate, sort (`src/core/detection/pipeline/pipeline.ts`).
- Eight detectors registered by the engine composition root: `html5-video`, `html5-audio`,
  `direct-url`, `network-media`, `hls-manifest`, `dash-manifest`, `blob-media`, `media-source`
  (`src/core/detection/factory.ts:61`). Detection runs from the content script's DOM observations.
  `network-media` is the exception: it is registered but cannot fire in this build, because it reads
  `context.networkResources`, which nothing populates — `src/platform/network` is contract-only and
  is never supplied (see Known limitations).
- Cross-detector correlation: candidates sharing a stable identity key are merged onto the
  higher-priority detector's record, and corroboration by independent detectors raises confidence
  (`src/core/detection/dedupe/correlate.ts`).
- Explainable confidence scoring and quality classification from known metadata only; an unknown
  dimension stays `unknown` instead of being guessed (`src/core/detection/scoring/scoring.ts`,
  `src/core/detection/quality/quality.ts`).
- Bounded per-tab detection cache (LRU over 50 tabs, five-minute maximum age), in memory only and
  never persisted (`src/core/detection/cache/cache.ts`, `src/core/detection/factory.ts`).
- Isolated-world content script that observes DOM readiness, mutations and media-element events,
  debounces its scans, and reports plain-data observations to the background. It runs no detectors
  itself, and every observer and listener is detached on page hide (`src/runtime/content/`).
- Refusal of protected content: EME/encrypted signals are classified as unsupported, and DRM,
  `blob:` and MediaSource delivery are rejected by the download gate. No key handling and no
  decryption code exists anywhere (`src/core/download/validate.ts`,
  `src/core/detection/detectors/media-source.ts`).
- Per-tab toolbar badge carrying the supported-media count, written only when it changes and
  cleared on navigation and tab close (`src/runtime/background/badge.ts`).
- Download manager owning the whole transfer lifecycle through a validated state machine
  (queued → preparing → active → completed / failed / paused / canceling → canceled), with every
  native transfer going through the platform downloads adapter (`src/core/download/state.ts`,
  `src/core/download/manager/manager.ts`).
- Retry with exponential backoff and jitter, bounded by the configured maximum, applied to
  retryable failures only: validation, DRM and permission errors are never retried
  (`src/core/download/retry/retry.ts`).
- Per-job and overall progress with transfer rate and ETA derived from real samples; an unknown
  total yields no ratio and no ETA rather than an invented one
  (`src/core/download/progress/progress.ts`).
- Cancel, pause and resume for a single job and for the queue as a whole
  (`src/core/download/manager/manager.ts`).
- Deterministic filename generation from the `{title}`, `{host}`, `{ext}`, `{quality}`, `{date}` and
  `{index}` tokens, with illegal-character stripping, a UTF-8 byte cap, an optional download
  subfolder, and disk collisions delegated to the browser's `uniquify` conflict action
  (`src/core/download/filename/filename.ts`).
- Durable download queue persisted in IndexedDB and rehydrated on a cold start, so jobs survive
  background suspension. Transient state — the native download handle, byte counters, progress
  ratios, retry timers — is deliberately not persisted, and a failed write leaves the queue working
  in memory (`src/core/storage/queue-repository.ts`, `src/core/download/queue/queue.ts`).
- Bounded concurrency limiter whose limit moves while slots are held, so changing **Maximum
  concurrent downloads** mid-session never lets more transfers run than the user allows
  (`src/core/download/concurrency/concurrency.ts`).
- Settings catalogue — theme, reduced motion, language, maximum concurrent downloads, maximum
  retries, filename template, download subfolder, duplicate warnings, detection sensitivity,
  notifications, context menu, keep history, history retention — stored under a single
  `storage.local` key, validated on every write with a typed reason, and repaired against the
  defaults when a stored value is unreadable (`src/core/settings/index.ts:18`,
  `src/core/settings/validate.ts`).
- Settings page, opened in a tab, with Appearance, Downloads, Detection, Notifications, History,
  Permissions and About sections; an applied change is broadcast so every open surface follows it
  live (`src/ui/settings/app.tsx`, `src/runtime/background/settings.ts`).
- Optional permissions (`notifications`, plus `contextMenus` on Chromium) requested from the user's
  own click in the page's context and revocable from the same screen; nothing is requested
  pre-emptively (`src/runtime/settings/client.ts`).
- Local download history in its own IndexedDB database: newest-first listing, search, filter by
  outcome, sort, single-record delete, full clear, retention pruning (forever / 30 days / 90 days /
  this session), and a JSON export written to the device. Nothing is recorded at all while **Keep
  history** is off (`src/core/history/history.ts`, `src/ui/history/view.tsx`).
- Material Design 3 design system: one token set for colour, type, spacing, shape, elevation and
  motion, light and dark schemes, live `system` resolution, and tokens published as custom
  properties so a theme change restyles without re-rendering (`src/ui/design-system/`).
- Popup with app bar, search, kind filter, sort, media cards that show only the metadata detection
  actually supplied, select-all and bulk download, and a queue panel offering cancel, retry, pause,
  resume, remove and clear (`src/ui/popup/app.tsx`, `src/ui/popup/queue-panel.tsx`).
- Complete popup state catalogue: loading, empty, no matches, error, and background unavailable
  (`src/ui/popup/app.tsx`, `src/ui/components/status-view.tsx`).
- Local query engine for search, filter and sort over detected media, deterministic down to an id
  tiebreak so results do not reshuffle between runs (`src/core/query/query.ts`).
- Context-menu entries and download-complete / download-failed / batch-summary notifications, each
  doubly gated on the user's setting and on the granted optional permission, and never requesting
  that permission themselves (`src/runtime/background/contextmenu/index.ts`,
  `src/runtime/background/notifications/index.ts`).
- Keyboard shortcut Ctrl+Shift+Y (Command+Shift+Y on macOS) opening the popup through the reserved
  `_execute_action` command (`build/manifest/generate.ts`).
- Accessibility work to the WCAG 2.1 AA standard, with automated coverage: axe-core runs the WCAG
  2.0/2.1 A and AA rule sets over the rendered popup, settings and history trees, every
  foreground/background token pair is asserted against AA contrast, status is conveyed by icon and
  text rather than colour alone, and the reduced-motion preference is honoured
  (`tests/accessibility/surfaces.test.tsx`, `src/ui/design-system/tokens.ts`). Two axe rules that
  need layout geometry — `color-contrast` and `target-size` — cannot run under jsdom and are
  disabled there; the screen-reader pass is still outstanding, so AA conformance is not yet
  claimed as verified (docs/MANUAL_TEST_MATRIX.md §5, cases M16-M17).
- Localization: all user-facing copy resolves from a message catalogue instead of being hard-coded
  in components, `public/_locales/en/messages.json` ships as the `en` catalogue, each surface keeps
  a built-in English fallback for when the namespace is unavailable, and no translation service is
  contacted at runtime (`src/platform/browser/i18n.ts`, `src/ui/popup/strings.ts`).
- Per-target builds from a single source tree producing `dist/chrome` and `dist/firefox`, where
  only the generated manifest differs: background, content, popup and settings bundles plus their
  HTML shells (`build/scripts/build-extension.ts`, `build/vite/config.ts`).
- Packaging validation of MV3 correctness, the strict CSP, the permission set, referenced files and
  the gzipped bundle budgets — 150 KB background, 40 KB content, 200 KB popup
  (`build/scripts/validate.ts`, `src/shared/constants/index.ts:41`).
- Automated security gate over `src/` and every built target, reporting nine checklist items:
  permissions unchanged and justified, no host permissions, CSP intact, no remote code, no network
  egress, URL validation in place, message validation in place, no DRM-circumvention code path, and
  no background-only code in a UI surface (`build/scripts/security-gate.ts:37`).
- Test matrix across unit, integration, accessibility, regression, performance and browser-e2e
  suites (`tests/`), with the performance suite on its own single-fork runner so the §12.1
  budgets — 300 ms detection, 200 ms download start, 150 ms popup time-to-interactive, bounded
  caches, bounded background memory, a resource census returning to baseline after repeated
  open/close cycles — are measured over the real composition rather than against runner contention
  (`vitest.perf.config.ts`, `tests/performance/`).
- Browser e2e on both engines: Chromium loads the unpacked build, and `dist/firefox` is put through
  Mozilla's own add-on linter and then installed in a real Firefox. The automatable manual-matrix
  cases run as their own specs; the rest are recorded as not executed rather than as passes
  (`tests/e2e/`, `docs/MANUAL_TEST_MATRIX.md`).

- Release packaging: `npm run package` validates each built target (manifest correctness, CSP,
  permissions and the §12.1 bundle budgets) and only then writes one deterministic ZIP per store
  target into `dist/release`, verifies the archive it just wrote, and records SHA-256 checksums
  (`build/scripts/package.ts`, PROJECT_BIBLE.md §8.15).
- Firefox data-collection disclosure in the generated Firefox manifest, declaring that the add-on
  collects nothing (`browser_specific_settings.gecko.data_collection_permissions`:
  `{ "required": ["none"] }`) — required by addons.mozilla.org, Firefox-only, descriptive of
  existing behaviour, and granting nothing (`build/manifest/targets.ts`,
  `build/manifest/generate.ts`).
- Store-listing preparation: listing copy, permission justifications, privacy disclosures and an
  asset inventory (docs/STORE_LISTING.md), four screenshots captured from the real build by
  `npm run screenshots` (`build/scripts/screenshots.ts`), and the executed security and privacy
  audit record (docs/RELEASE_AUDIT.md). Nothing has been submitted to any store.
- Release verification suite: the packaged artifacts are extracted and then validated, linted by
  Mozilla's add-on linter, and installed in a real Chromium and a real Firefox
  (`tests/e2e/release-chromium.spec.ts`).

### Changed

- The Phase 1 skeletons for detection, downloads, settings, history and the UI are gone: each of
  those contracts now has a working implementation behind it. Two contracts remain declarations
  only — `NetworkObserver` (`src/platform/network/index.ts`) and `StreamAssembler`
  (`src/core/download/stream/index.ts`); see Known limitations.
- No content script is declared in the manifest. The observer is injected programmatically from the
  gesture that grants `activeTab`, so the extension holds no standing access to any page
  (`build/manifest/generate.ts`, `src/runtime/background/runtime.ts`).
- The performance suite runs from its own Vitest configuration, one file at a time in one fork, so
  wall-clock budgets measure AetherDL rather than the test runner's scheduling
  (`vitest.perf.config.ts`).

### Fixed

- Page detection never ran: nothing injected the content script, so no page ever reported
  observations and the popup stayed empty on every site. A refresh now injects the observer into
  the tab whose gesture granted `activeTab` (`src/runtime/background/runtime.ts:163`,
  `tests/regression/defects.test.ts:35`).
- Opening the popup twice on the same page left two content scripts observing it — two mutation
  observers, two debounce timers, two reports per change. The isolated world is marked on first
  run, so a second injection does nothing and a real navigation is observed normally
  (`src/runtime/content/index.ts`, `tests/regression/content-injection.test.ts`).
- Download history recorded nothing: the queue and history object stores shared one IndexedDB
  database, so whichever opened second found its store missing and forced an upgrade the first
  connection blocked. Each store now has its own database (`src/core/storage/history-repository.ts`,
  `src/core/storage/queue-repository.ts`, `tests/regression/defects.test.ts:60`).
- Downloads ignored **Maximum concurrent downloads**, **Maximum retries**, **Filename template** and
  **Download subfolder**: the four values were saved, broadcast and displayed while the running system
  stayed on its built-in defaults, and files never landed in the configured folder. The download
  system is now built from the stored settings and reconfigured live when they change
  (`src/runtime/background/downloads.ts:310`, `src/core/download/factory.ts`,
  `tests/regression/download-settings.test.ts`).
- A file could be saved with a doubled extension (`sample.mp4.mp4`) whenever the media's title was
  already its filename and the default `{title}.{ext}` template applied — the common case for a
  direct media URL. A trailing copy of the resolved extension is now dropped from the `{title}`
  token only (`src/core/download/filename/filename.ts`,
  `tests/regression/filename-extension.test.ts`).
- On Firefox the Settings page offered a **Grant: Context menu** button that could never succeed, and
  the context-menu preference did nothing, because the build declared `menus` in
  `optional_permissions`, which Firefox does not accept there. Firefox now declares no menus
  permission at all — nothing is taken at install either — and each surface asks the platform what
  the running target can offer (`build/manifest/targets.ts:51`,
  `tests/regression/firefox-menus.test.tsx`).
- A rejected settings value reached the Settings page as a generic internal failure, so the user was
  told to retry instead of being told the value was invalid: the message bus normalizes an error to
  `internal` on the wire, and the surface's error mapper now recognizes the stable validation codes
  (`src/ui/settings/errors.ts`, `tests/regression/defects.test.ts:109`).
- The popup showed settings wording, because both catalogues defined `error.*` keys and generating
  the locale file let the settings text overwrite the popup's. The settings keys are namespaced
  under `settings.error.*` and the two catalogues now share no key
  (`src/ui/settings/strings.ts`, `tests/regression/defects.test.ts:130`).

### Security

- Zero egress: the extension makes no network call of its own, has no backend, no accounts, no
  analytics and no telemetry, and there is no setting that could enable any of them. The security
  gate asserts this against `src/` and every target present in `dist/` on each run (a target that
  has not been built is reported as skipped rather than silently passed)
  (`build/scripts/security-gate.ts:37`, PROJECT_BIBLE.md §14.1, §14.3).
- Strict MV3 content security policy for extension pages, `script-src 'self'; object-src 'none'`,
  with no remote code and no dynamic evaluation; both the packaging validator and the security gate
  fail the build if it is weakened (`build/manifest/generate.ts:90`, `build/scripts/validate.ts`).
- Least-privilege permissions: `storage`, `downloads`, `activeTab` and `scripting` at install, with
  no host permissions declared at all. Elevated capabilities are optional permissions requested at
  point of use (`notifications`, plus `contextMenus` on Chromium)
  (`build/manifest/targets.ts:32`, `build/manifest/targets.ts:51`).
- Firefox data-collection disclosure for addons.mozilla.org:
  `browser_specific_settings.gecko.data_collection_permissions: { required: ['none'] }`, Mozilla's
  declaration that the add-on collects no data. It describes the behaviour that already exists,
  grants nothing, requests no permission and changes no code path; the key is Firefox-only, so
  Chromium manifests carry no `browser_specific_settings` at all
  (`build/manifest/targets.ts:79`, `build/manifest/generate.ts:147`).
- Untrusted input is bounded at every trust boundary: content-script reports are validated and
  capped before reaching the detection engine, stored records are validated before they re-enter
  the domain, and only http(s) progressive/direct/HTML5 resources are downloadable
  (`src/runtime/background/context.ts`, `src/core/storage/history-repository.ts`,
  `src/core/download/validate.ts`).

### Known limitations

- Non-DRM HLS and DASH streams are detected and reported, but they cannot be downloaded: the
  download gate refuses `hls` and `dash` delivery because stream assembly
  (PROJECT_BIBLE.md §10.6) is not implemented — `StreamAssembler`
  (`src/core/download/stream/index.ts`) is still a contract with no implementation, and
  `src/core/download/validate.ts` lists both in `FORBIDDEN_DELIVERY`. PROJECT_BIBLE.md §5.2 marks
  non-DRM `.m3u8` and `.mpd` as supported media, so this is an unfinished capability rather than a
  protection boundary, and it is distinct from the DRM refusal above.
- Network-request observation is not implemented: `NetworkObserver`
  (`src/platform/network/index.ts`) is a contract with no implementation and is never supplied to
  the platform facade, and `buildDetectionContext` never sets `networkResources`. Detection works
  from the content script's DOM observations only, and the registered `network-media` detector is
  therefore inert. HLS and DASH manifests are still detected, because those detectors also read the
  page's observed URLs and DOM signals (`src/core/detection/detectors/manifest.ts`).
- The extension icons are placeholders generated by `npm run gen:icons` (the 128x128 file is 360
  bytes); a store listing needs the real icon set (docs/STORE_LISTING.md §7).
- The manual test matrix records the cases that could not be executed here, including the
  screen-reader pass and the Edge, Brave, Opera and Vivaldi browsers
  (docs/MANUAL_TEST_MATRIX.md §5).

### Notes

- This is a release candidate in the `0.9.x` band, which ROADMAP.md's version table assigns to
  Phases 8–10 (performance verified, stabilization, release candidates); `1.0.0` is reserved for
  the stable public release in Phase 11 (ROADMAP.md:482–483).
- `web-ext` (ADR-008) and `axe-core` (ADR-009) are development dependencies only: they appear in no
  bundle, no manifest and no runtime code path.
- The manual test matrix (docs/MANUAL_TEST_MATRIX.md) records the cases no automation can perform —
  a real toolbar click, a real screen reader, real notification surfaces, and the Chromium
  distributions no CI runner installs.

## [0.1.0] — Phase 1: Repository Setup

### Added

- Frozen repository folder structure per PROJECT_BIBLE.md §8.3.
- Strict TypeScript configuration (`tsconfig.base.json`, `tsconfig.json`).
- ESLint configuration with layer-boundary enforcement (PROJECT_BIBLE.md §8.4, §15.9).
- Prettier, EditorConfig, and formatting configuration.
- Vitest (unit/integration) and Playwright (e2e) test configuration.
- Vite-based build pipeline with per-target manifest generation for Chromium and Firefox
  from a single source tree.
- Path aliases (`@shared`, `@platform`, `@core`, `@ui`, `@runtime`).
- Module skeletons and contract interfaces/type definitions (no implementations).
- Shared type contracts, `Result`/error taxonomy, constants, tokens, utilities, dev logger.
- Manifest validation script (manifest correctness, CSP, permissions, size budgets).
- Continuous Integration workflow.

### Notes

- No product functionality is implemented in this phase (no detection, download, or UI logic).
