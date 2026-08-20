# AetherDL 1.2.1 — Release Audit

> **Nothing has been submitted or published from this environment.** This records the security and
> privacy audits required for release (PROJECT_BIBLE.md §22.11: "final
> [security](PROJECT_BIBLE.md#1310-security-review-gate) +
> [privacy audit](PROJECT_BIBLE.md#143-external-network-calls-by-the-extension)"), re-executed
> against the `1.2.1` build: the 1.1.0 stream feature set, the thirteen-defect sweep of
> 1.2.0, and the eight-defect detection-and-storage sweep of 1.2.1. Store submission requires
> Owner-held credentials and is a gated manual step (§18.8); distribution is via official stores
> only (§18.6, non-goal N17).
>
> **What changed in this audit, and why it matters:** through `1.0.0` this document recorded that the
> extension made no network call of its own. That is no longer true. Assembling a stream means
> reading a playlist and its segments, so `1.1.0` performs exactly those GET requests, to the media
> host, without credentials or cookies. The claim is rewritten below rather than left standing.
> Nothing is ever **sent**: no analytics, telemetry, beacon, socket or report
> ([ADR-010](adr/010-non-drm-stream-assembly.md)).

## 1. Build under audit

| Field | Value |
|---|---|
| Version | `1.2.2` — the 1.1.0 stream feature set (ADR-010) plus the three defect sweeps recorded in `CHANGELOG.md`. The 1.2.2 sweep covers the five areas no earlier pass had touched: the message bus and event infrastructure, the settings service, the badge/notification/context-menu runtimes, the content script's DOM scanning, and the build tooling |
| Source | one tree, two targets (`build/manifest/generate.ts`), no per-browser source fork (§7.2) |
| Date audited | 2026-08-20 |
| Audit method | executed commands, recorded below — not review by inspection alone |
| Executed at 1.2.2 | yes, after the version bump and repackage: `npm run ci` — typecheck, lint, format check, 1070 unit/integration tests, 69 performance assertions, both builds, manifest validation, the security gate, packaging, and 50 browser e2e cases — **exit 0**. Nothing in this file is carried over from an earlier run |

### Artifacts

| Target | Artifact | Bytes | Entries | SHA-256 | Stores served |
|---|---|---|---|---|---|
| chrome | `dist/release/aetherdl-1.2.1-chrome.zip` | 125 316 | 20 | `721dd00ff89999e511db0e7c7115a0dc32f8a0c8372c1d1cf6690d41e7d3aabc` | Chrome Web Store, Microsoft Edge Add-ons, Opera add-ons, other Chromium-compatible stores |
| firefox | `dist/release/aetherdl-1.2.1-firefox.zip` | 125 383 | 20 | `71df1084d341cdabdb665051dafc2ea0a670a5ff7cf78d7e1e97bf6dce75b509` | Firefox Add-ons (AMO) |

Both archives carry four entries more than `1.0.0` did: the assembly document
(`offscreen.html`, `offscreen.js`) and the two chunks the stream code lives in.

Checksums are written by the packaging script to `dist/release/SHA256SUMS.txt`. Archives are
deterministic for a given Node (and therefore zlib) version: entries are sorted and stamped with a
fixed timestamp, so re-packaging the same build reproduces the same bytes (§8.15 determinism,
asserted in `tests/unit/build/package.test.ts`). The packager refuses to package a `dist/` whose
manifest version differs from the release version, clears stale archives before writing, and reads
each archive back — cross-checking every local file header against the central directory and every
entry against its CRC — before reporting it.

## 2. Security review gate (§13.10)

`npm run security:gate` — **PASS on both targets**, all nine checks:

| Check | chrome | firefox | How |
|---|---|---|---|
| permissions unchanged and justified | PASS | PASS | manifest compared against the approved baseline in `build/manifest/targets.ts` |
| no host permission granted at install | PASS | PASS | no `host_permissions` key on either target; the stream pattern appears only under `optional_host_permissions`, and no `://` or `<all_urls>` entry appears in `permissions` or `optional_permissions` |
| CSP intact | PASS | PASS | `script-src 'self'; object-src 'none'` on both |
| no remote code | PASS | PASS | source and both bundles scanned for `eval`, `new Function`, `importScripts`, script-element creation, `innerHTML` |
| network access confined to stream assembly | PASS | PASS | `XMLHttpRequest`, `WebSocket`, `sendBeacon` and `EventSource` are forbidden everywhere and absent everywhere. `fetch` is permitted in exactly one source file (`src/platform/http/service.ts`) and, in the built output, only in code an assembly surface loads — decided by walking the emitted import graph, so `popup.js`, `settings.js` and `content.js` are proven unable to reach it. Embedded remote URLs still fail the check |
| URL validation in place | PASS | PASS | `normalizeUrl` still exported from `src/shared/utils/url.ts`; `createHttpClient` still exported and still refusing every scheme but `http(s)` before a request is made |
| message validation in place | PASS | PASS | `isDetectionReport` still exported from `src/runtime/background/context.ts` |
| no DRM-circumvention code path | PASS | PASS | scanned for key-system, `setMediaKeys` and decryption APIs; only the refusal path names encryption |
| no background-only code in a UI surface | PASS | PASS | popup/settings payloads scanned for detector identifiers |

### Permission sets, as shipped

| | chrome | firefox |
|---|---|---|
| At install | `storage`, `downloads`, `activeTab`, `scripting`, `offscreen` | `storage`, `downloads`, `activeTab`, `scripting` |
| Optional (user-granted, revocable) | `notifications`, `contextMenus` | `notifications` |
| Optional host permissions | `*://*/*` | `*://*/*` |
| Host permissions granted at install | none | none |

`offscreen` is Chromium-only and grants no access to anything: it lets the service worker open an
extension-owned document that can build the `blob:` URL the Downloads API saves. A Firefox event page
already has those DOM APIs, so Firefox declares nothing extra (§7.4).

The host pattern is broad because a stream's segments are spread across hosts the manifest only names
when it is read, so no narrower pattern can be declared in advance. It is **optional**: it is
requested on the download click, for the specific origins in play, and the tab's own origin is
skipped entirely because `activeTab` already covers it. Declining cancels that download and nothing
else. Verified by asking the browser what is actually granted: a freshly installed Firefox reports
`permissions.getAll().origins === []` (`tests/e2e/firefox.spec.ts`).

The Firefox alternative — declaring the pattern under `host_permissions`, which Mozilla documents as
optional-by-default in MV3 — was **tried and rejected on measurement**: the installed add-on reported
the origin already granted. Both targets therefore use `optional_host_permissions`, at the stated
cost that Firefox 115–127, which lacks that key, cannot download streams at all.

Firefox declares no menus permission at all: Mozilla does not accept `menus` as an optional
permission, and taking it at install would claim access the user never chose, so the context-menu
feature reports itself unavailable there and degrades gracefully (§7.2, §7.4, §13.3). Verified by
`tests/regression/firefox-menus.test.tsx` and by the installed-extension Firefox e2e.

### DRM boundary (§6)

`1.2.0` closed a defect in how a refusal was *described*: an encrypted stream reached the user with
network copy ("check your network"), and on Chromium the reason was lost entirely crossing the
offscreen boundary, where a runtime message carries only `{message, code}`. Protected content is now
its own error category (`drm`), never retried, with its own wording, and the client rebuilds the
typed error from the code — asserted in a real browser
(`tests/e2e/stream-chromium.spec.ts`).

Encrypted media is classified unsupported and refused before any transfer starts. Observed in both
engines during this audit — the matrix runner's own lines, abridged to the fields that carry the
result:

```
[matrix] chromium | M6 DRM refusal | ... job=failed/download-unsupported-status; nativeDownloads 0→0
[matrix] firefox  | M6 DRM refusal | ... job=failed/download-unsupported-status; nativeDownloads 0→0
```

The full lines, including each case's expected-result text, are printed by
`npm run test:e2e`.

`1.1.0` adds a second refusal boundary, because the extension now reads playlists itself. Encryption
is refused in three independent places:

1. **Classification** — DRM/EME media is `unsupported` and never enqueued (unchanged from 1.0.0).
2. **Download validation** — an unsupported item cannot become a job, with or without assembly.
3. **The parsers** — any `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` whose method is not `NONE`, any
   `ContentProtection`, `cenc:pssh` or `pssh`, ends parsing **before a single segment is fetched**.

A key URI is never read, followed, returned or logged. Tests assert the negative directly: the whole
refusal, serialised, contains no key host, no key filename and no `URI` attribute
(`tests/unit/core/download/stream/hls.test.ts`, `dash.test.ts`). A real Chromium was pointed at an
encrypted loopback playlist and refused it with `stream-hls-encrypted`, with the browser's download
count unchanged before and after (`tests/e2e/stream-chromium.spec.ts`). There is no decryption code
in this project and none may be added (§6, ADR-005).

## 3. Privacy audit (§14.3 — external network calls by the extension)

### The claim, stated exactly

The extension performs **one kind of network request of its own**: `GET`, to read a stream manifest
and its segments, only for a download the user asked for, only on origins the user granted, with
`credentials: 'omit'` and `cache: 'no-store'` so no cookie, token or identifier is attached. It
**sends** nothing, anywhere, ever: no analytics, telemetry, beacon, socket, crash report,
remote configuration or account traffic exists in the codebase, and no setting could enable any.

Everything else the extension does — reading a page's DOM, saving a progressive file — involves no
request from the extension at all; a progressive download is performed by the browser's own downloads
API (§10.8).

### Static evidence

The security gate scans every `.ts`/`.tsx` file under `src/` and every emitted bundle in both builds.

| What | Verdict |
|---|---|
| `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource` | absent from source and from both builds; forbidden everywhere, no exception |
| `fetch` in source | appears in exactly one file, `src/platform/http/service.ts`; the gate fails on it anywhere else |
| `fetch` in the built output | present only in the chunk the assembly surfaces load. The gate walks the emitted import graph from `background.js` and `offscreen.js`, and separately from `popup.js`, `settings.js` and `content.js`; a UI surface that could reach `fetch` fails the build (asserted, with a deliberately mis-split fixture, in `tests/unit/build/security-gate.test.ts`) |
| Absolute URLs in the bundles | five, all strings only, never contacted: four W3C namespace identifiers the DOM requires when creating namespaced elements, and `https://react.dev/errors/`, which React prints inside a thrown message. Any other absolute URL fails the check |
| Scheme handling | the HTTP client refuses anything but `http(s)` before it issues a request, so a `blob:`, `data:`, `file:` or `chrome-extension:` URL cannot be fetched even if one reached it (`tests/unit/platform/http.test.ts`) |

### Runtime evidence, on the packaged artifact

`tests/e2e/release-chromium.spec.ts` extracts `aetherdl-1.1.0-chrome.zip`, installs it in a real
Chromium, opens the popup and the settings page, runs a real progressive download and reads history,
while recording every request the browser context makes. Result: **no request to any host other than
the one the user's download went to.**

`tests/e2e/stream-chromium.spec.ts` then does the thing this release adds, in the same real browser:
a loopback HLS playlist is detected, assembled, and saved. The observed traffic is the manifest, the
media playlist and the three segments — nothing else — and the saved file is exactly the three
segments joined (12 288 bytes), delivered to the Downloads API as a `blob:` URL rather than fetched
again.

The Gecko suite (`tests/e2e/firefox.spec.ts`) makes the same observation for the shipped Firefox
bundles: no remote resource is loaded — no remote script, font, stylesheet or image.

One limit of that observation, unchanged from 1.0.0: the recorder is attached after the extension is
installed and its worker has started, so a request issued during background start-up would not appear
in it. That window is covered by the static evidence above and by the CSP, which permits no remote
script.

### What is stored, and where

All local, per §14.2:

| Data | Store | Leaves the device |
|---|---|---|
| Settings catalogue | `storage.local` | No |
| Download queue | IndexedDB `aetherdl-queue` | No |
| Download history (opt-out) | IndexedDB `aetherdl-history` | No |
| Detection results | in memory, bounded LRU, never persisted | No |

No analytics, no telemetry, no tracking, no accounts, no identifiers, no remote configuration and
no third-party service exist in the codebase (§14.1 guarantees 1–7).

### Firefox data-collection disclosure

The Firefox manifest declares:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "aetherdl@aetherdl.app",
    "strict_min_version": "115.0",
    "data_collection_permissions": { "required": ["none"] }
  }
}
```

`required: ["none"]` is Mozilla's declaration that the add-on collects no data, which is what the
audit above establishes. It grants nothing, requests no permission and changes no code path. The
literal value is absent from the governance documents and was ratified by the Project Owner on
2026-08-19 rather than assumed. Chromium manifests carry no `browser_specific_settings` key at all.

## 4. Store-package validation

| Check | Result |
|---|---|
| `npm run validate:manifest` (manifest correctness, CSP, permissions, §12.1 budgets) | chrome OK, firefox OK |
| Same validation re-run on the **extracted** artifacts | both pass |
| `web-ext lint` (Mozilla's addons-linter, the validation AMO runs) on `dist/firefox` | **0 errors**, 4 warnings |
| `web-ext lint` on the **extracted** Firefox artifact | **0 errors**; `MISSING_DATA_COLLECTION_PERMISSIONS` no longer reported |
| Independent ZIP reader (Python `zipfile`, `unzip` as fallback) on both artifacts | accepted; `testzip()` reports no corrupt entry, `manifest.json` present |
| Extracted Chromium artifact installed in real Chromium | installs, service worker starts, popup renders, answers on the message contract |
| Extracted Firefox artifact installed in real Firefox | installs, popup renders, optional permissions are `["notifications"]` only, and `permissions.getAll().origins` is empty — no host access granted at install |

### Remaining lint warnings, and why they stand

| Warning | Reason |
|---|---|
| `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` | `data_collection_permissions` landed in Firefox 140; the build keeps `strict_min_version 115.0` so Firefox ESR stays supported (§7.1). Older Firefox ignores the key. Owner decision, 2026-08-19. |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | the same key on Firefox for Android, supported from 142. |
| `UNSAFE_VAR_ASSIGNMENT` ×2 | inside React's own vendor chunk (`chunks/styles.js`); AetherDL's source assigns `innerHTML` nowhere, which the security gate enforces. |

### Bundle budgets (§12.1), measured on this build

```
background   32.4kB gz / 150.0kB budget (5 files,  99.2kB raw)
content       3.0kB gz /  40.0kB budget (1 file,    7.6kB raw)
popup        78.5kB gz / 200.0kB budget (6 files, 251.3kB raw)
settings     79.3kB gz / 200.0kB budget (5 files, 258.3kB raw)
offscreen    10.8kB gz /  40.0kB budget (3 files,  29.6kB raw)
```

The background surface carries the stream code (parsers, assembly, HTTP client) and grew from
23.3 kB to 31.2 kB gzipped — still a fifth of its budget. §12.1 does not name the assembly document,
which is new in this release; it holds no UI and no React, so it is held to the content script's
40 kB rather than a UI budget (ADR-010). No budget was relaxed.

## 5. Test evidence for this release

`npm run ci` exits 0 on this build: typecheck, ESLint (zero warnings), Prettier, 1031 unit +
integration + accessibility + regression tests, 69 performance tests, both builds, both manifest
validations, the security gate, packaging, and 50 browser e2e tests (Chromium and Firefox, including
the eight checks in `tests/e2e/release-chromium.spec.ts` summarised in §4). Coverage, measured by
`npm run test:coverage` (which `ci` does not run): 97.23 % statements, 94.24 % branches.

The `1.2.2` sweep added 39 tests, including one that earns its place by construction: the Chromium
e2e now asserts that every URL the content script reports is absolute, and that assertion was run
against the pre-fix scanner to confirm it fails there.

The `1.2.1` sweep added 18 tests over the detection engine and the storage layer, including a
connection that dies underneath the adapter (proving it reconnects rather than failing silently for
the rest of the session), a read transaction that aborts on its own (proving it settles), and the
new bounds on history, per-tab state and the detection cache.

The `1.2.0` sweep added 49 tests, one per fixed defect and its edges, including two browser cases: a
real Chromium refusal of a stream whose audio is a separate rendition, and the DRM category and
wording surviving the offscreen boundary.

One note on measuring performance here: the first `ci` run of this build reported the popup's
per-update commit at 20.1 ms against a 16 ms frame budget while the operator's desktop sat at load
7.3. Re-measured twice on an idle machine it was **3.2 ms and 3.3 ms**, and popup TTI 31.4 ms and
30.7 ms against 150 ms. No budget was relaxed; the failing figure was contention, and it is recorded
here rather than quietly dropped.

The 129 tests added for this release cover: the HLS parser including every encryption form and the
assertion that no key material appears in a refusal (16); the DASH parser including
`ContentProtection`, `cenc:pssh` and bare `pssh` refusals (14); assembly, its ceilings, its abort
behaviour and its origin reporting (17); local delivery (5); the object-URL adapter (4); the
Chromium offscreen client, including a document that never starts listening (11); the offscreen
assembly host (7); stream jobs inside the download manager — assembly, filename container, byte
total, progress while preparing, release on completion, cancel mid-assembly, refusal handling,
and refusal without assembly (11); delivery resolution per engine (5); the security gate's own
egress and host-permission policy (8); the popup's point-of-use permission request (3 + 6); the
HTTP client (18, from earlier in this release); and 4 browser e2e cases including a real HLS
download and a real encrypted-playlist refusal.

Live settings-to-disk evidence on the stable build: with `{host}-{title}.{ext}` and the subfolder
`AetherDL/Clips` configured, the real Firefox wrote
`AetherDL/Clips/127.0.0.1_<port>-sample.mp4` — the configured folder, the configured template, the
illegal `:` sanitised, and a single extension (§10.7).

## 6. Not verified here

Honest limits of this audit:

- **Two sweeps, not a clean bill of health.** `1.2.0` hunted the UI and the download/stream paths;
  `1.2.1` hunted the detection engine and the storage layer. Areas that have NOT had a dedicated
  hunt: the message bus and its envelope handling, the settings service's validation and migration
  paths, the badge/notification/context-menu runtimes, the build and packaging tooling, and the
  content script's own DOM scanning. Nothing here claims the codebase is defect-free; it claims what
  was looked at and what was found.

- **No store console was opened, and nothing was submitted.** "Validates for Chrome Web Store /
  Edge Add-ons / AMO" is evidenced by Mozilla's own linter, by the project's packaging validation,
  and by installing the extracted artifacts in real browsers. A store's own submission-time review
  cannot be run offline; submission needs accounts and credentials only the Project Owner holds, and
  PROJECT_BIBLE.md §18.8 makes it "a gated manual step". No `publish`/`submit` script, credential
  file or environment variable exists in this repository.
- **Icons are placeholders.** `build/scripts/gen-icons.ts` generates solid-colour placeholders; the
  128×128 file is 360 bytes. A listing needs the real icon set (see `docs/STORE_LISTING.md` §7).
- **Streams whose audio is a separate track are refused, not downloaded.** Most real-world DASH and
  much HLS is packaged that way, so a large share of streams in the wild are out of reach in this
  build. The alternative — saving a video with no sound — was the 1.1.0 behaviour and is worse;
  muxing is out of scope (`CHANGELOG.md` 1.2.0).
- **Stream assembly has not been tried against a live streaming site.** Its browser evidence is the
  loopback HLS fixture in `tests/e2e/stream-chromium.spec.ts`. Real sites vary in ways a fixture
  cannot reproduce: signed segment URLs that expire, redirect chains, per-request tokens, CORS
  configurations, and playlists delivered only through a player script (which DOM-based detection
  will not see at all). No DASH end-to-end browser case exists either; the DASH parser and assembly
  are covered by unit tests only.
- **Firefox 115–127 cannot download streams,** and this was not worked around by taking host access
  at install. Progressive downloads are unaffected. Not measured on those specific versions: the
  Firefox e2e runs the installed browser's version only.
- **Network-request observation still does not exist** (`src/platform/network` is contract-only), so
  detection reads the DOM and no file size is shown before a download starts.
- **PROJECT_BIBLE.md §14.3 was amended, not left in conflict.** The Owner approved the amendment on
  2026-08-20; the Bible is now version 1.1.0 and §14.3 states the permitted network activity
  exhaustively, with the no-transmission guarantee permanent under §25.3. AGENT_RULES.md,
  ARCHITECTURE.md and ROADMAP.md were brought into line. ADR-010 records the decision.
- **Human-only test cases** remain as recorded in `docs/MANUAL_TEST_MATRIX.md` §5: screen reader,
  notification and toolbar UI, private-window behaviour, and the Edge, Brave, Opera and Vivaldi
  browsers, which are not installed in this environment. The streaming case is no longer entirely
  human-only — an automated HLS download now runs in Chromium — but a live-site check remains
  unexecuted.
- **No `1.1.0` tag, commit or GitHub release was created by this work.** The repository exists and
  carries the annotated `v1.0.0` tag from the earlier Owner action; nothing was committed, tagged,
  pushed or published for `1.1.0`. Those are Owner actions.
## 7. Owner release declaration — 1.0.0, 2026-08-20

> Superseded in part by the Owner's 2026-08-20 direction to implement the wider format set,
> including M3U8 and MPD, over the frozen 1.0.0 scope. The HLS/DASH row below no longer describes
> the code: `1.1.0` implements non-DRM stream downloading (ADR-010). Every other row still stands.
> The declaration is kept verbatim as the record of what was decided at 1.0.0.

The Project Owner declares **AetherDL 1.0.0 the stable release**, subject to the limitations in §6
and to the dated exception recorded in `docs/MANUAL_TEST_MATRIX.md` §5. Recorded decisions:

| Decision | Record |
|---|---|
| Stable release | 1.0.0 is declared stable; release implementation is complete |
| Non-DRM HLS/DASH downloading | **Deferred.** Not implemented, not a 1.0.0 capability; the §6 limitation stands |
| *Warn about duplicates* control | Not implemented, not hidden, not modified. The control ships as-is and remains **inert**; the limitation stands |
| Human-only test cases | **Remain unexecuted.** Recorded, not waived into passes |
| Edge / Brave / Opera / Vivaldi | Exception accepted; those browsers **remain untested** |
| Git tag | **None created.** The tree is not a git repository, so no tag and no provenance were fabricated |
| Store submission / publication | **Not performed.** No credentials were requested, invented or stored; nothing was uploaded or signed |
| Lifecycle | The project enters the **Maintenance** state (ROADMAP.md §6): defect fixes and patch releases only, no new scope without change control |

This declaration records the decision only. It adds no capability, changes no source, and leaves
every limitation above exactly as measured.
