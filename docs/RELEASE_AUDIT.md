# AetherDL 1.0.0 — Stable Release Audit

> **Nothing has been submitted or published from this environment.** This records the security and
> privacy audits required for release (PROJECT_BIBLE.md §22.11: "final
> [security](PROJECT_BIBLE.md#1310-security-review-gate) +
> [privacy audit](PROJECT_BIBLE.md#143-no-external-network-calls-by-the-extension)"), re-executed
> against the stable `1.0.0` build. Store submission requires Owner-held credentials and is a gated
> manual step (§18.8); distribution is via official stores only (§18.6, non-goal N17).

## 1. Build under audit

| Field | Value |
|---|---|
| Version | `1.0.0` — the stable public release (ROADMAP.md:483, :677). Content-identical to the audited `0.9.1` candidate; only the version differs |
| Source | one tree, two targets (`build/manifest/generate.ts`), no per-browser source fork (§7.2) |
| Date audited | 2026-08-19 |
| Audit method | executed commands, recorded below — not review by inspection alone |
| Re-executed at 1.0.0 | yes, after the version bump and repackage: `npm run ci` (exit 0), `npm run security:gate`, `npm run lint:extension`, `npm run test:coverage`, `sha256sum`, `python3 -m zipfile`/`unzip -t` on the 1.0.0 archives. Nothing in this file is carried over from the 0.9.1 run |

### Artifacts

| Target | Artifact | Bytes | Entries | SHA-256 | Stores served |
|---|---|---|---|---|---|
| chrome | `dist/release/aetherdl-1.0.0-chrome.zip` | 112 098 | 16 | `d91cd2a92f62675120d86b8f94e66f98b8a2992ebd881b14ea8aa04f0c13923c` | Chrome Web Store, Microsoft Edge Add-ons, Opera add-ons, other Chromium-compatible stores |
| firefox | `dist/release/aetherdl-1.0.0-firefox.zip` | 112 170 | 16 | `ec6e61d08fde6715f653d4beb19cc0940e816ffd0c4711e406022aabb9c26675` | Firefox Add-ons (AMO) |

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
| no host permissions | PASS | PASS | no `host_permissions` key; no `://` or `<all_urls>` entry anywhere |
| CSP intact | PASS | PASS | `script-src 'self'; object-src 'none'` on both |
| no remote code | PASS | PASS | source and both bundles scanned for `eval`, `new Function`, `importScripts`, script-element creation, `innerHTML` |
| no network egress | PASS | PASS | scanned for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, and embedded remote URLs |
| URL validation in place | PASS | PASS | `normalizeUrl` still exported from `src/shared/utils/url.ts` |
| message validation in place | PASS | PASS | `isDetectionReport` still exported from `src/runtime/background/context.ts` |
| no DRM-circumvention code path | PASS | PASS | scanned for key-system, `setMediaKeys` and decryption APIs; only the refusal path names encryption |
| no background-only code in a UI surface | PASS | PASS | popup/settings payloads scanned for detector identifiers |

### Permission sets, as shipped

| | chrome | firefox |
|---|---|---|
| At install | `storage`, `downloads`, `activeTab`, `scripting` | `storage`, `downloads`, `activeTab`, `scripting` |
| Optional (user-granted, revocable) | `notifications`, `contextMenus` | `notifications` |
| Host permissions | none | none |

Firefox declares no menus permission at all: Mozilla does not accept `menus` as an optional
permission, and taking it at install would claim access the user never chose, so the context-menu
feature reports itself unavailable there and degrades gracefully (§7.2, §7.4, §13.3). Verified by
`tests/regression/firefox-menus.test.tsx` and by the installed-extension Firefox e2e.

### DRM boundary (§6)

Encrypted media is classified unsupported and refused before any transfer starts. Observed in both
engines during this audit — the matrix runner's own lines, abridged to the fields that carry the
result:

```
[matrix] chromium | M6 DRM refusal | ... job=failed/download-unsupported-status; nativeDownloads 0→0
[matrix] firefox  | M6 DRM refusal | ... job=failed/download-unsupported-status; nativeDownloads 0→0
```

The full lines, including each case's expected-result text, are printed by
`npm run test:e2e`.

## 3. Privacy audit (§14.3 — no external network calls by the extension)

### Static evidence

The security gate's egress scan covers every `.ts`/`.tsx` file under `src/` and every emitted
bundle in both builds. No `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource`
appears anywhere in the extension's own code. Five distinct absolute URLs exist in the shipped
bundles as **strings only**, never contacted: four W3C namespace identifiers
(`http://www.w3.org/2000/svg`, `.../1999/xlink`, `.../1998/Math/MathML`,
`.../XML/1998/namespace`), which the DOM requires when creating namespaced elements, and
`https://react.dev/errors/`, which React prints inside a thrown message. The security gate
allow-lists exactly those two prefixes and fails on any other absolute URL.

### Runtime evidence, on the packaged artifact

`tests/e2e/release-chromium.spec.ts` extracts `aetherdl-1.0.0-chrome.zip`, installs it in a real
Chromium, opens the popup and the settings page, runs a real download and reads history, while
recording every request the browser context makes. Result: **zero requests to any host.** The media
transfer the user asked for is performed by the browser's own downloads API — which is why it
appears in `chrome.downloads.search()` and not as a request from any extension page (§10.8).

The Gecko suite (`tests/e2e/firefox.spec.ts`) makes the same observation for the shipped Firefox
bundles: no remote resource is loaded — no remote script, font, stylesheet or image.

One limit of that observation: the recorder is attached after the extension is installed and its
service worker has started, so a request issued during background start-up would not appear in it.
That window is covered instead by the static scan above, which finds no network API in the source
at all, and by the CSP, which permits no remote script.

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
| Extracted Firefox artifact installed in real Firefox | installs, popup renders, optional permissions are `["notifications"]` only |

### Remaining lint warnings, and why they stand

| Warning | Reason |
|---|---|
| `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` | `data_collection_permissions` landed in Firefox 140; the build keeps `strict_min_version 115.0` so Firefox ESR stays supported (§7.1). Older Firefox ignores the key. Owner decision, 2026-08-19. |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | the same key on Firefox for Android, supported from 142. |
| `UNSAFE_VAR_ASSIGNMENT` ×2 | inside React's own vendor chunk (`chunks/styles.js`); AetherDL's source assigns `innerHTML` nowhere, which the security gate enforces. |

### Bundle budgets (§12.1), measured on this build

```
background   23.3kB gz / 150.0kB budget (3 files,  74.4kB raw)
content       2.9kB gz /  40.0kB budget (1 file,    7.5kB raw)
popup        76.3kB gz / 200.0kB budget (5 files, 245.4kB raw)
settings     76.1kB gz / 200.0kB budget (4 files, 248.9kB raw)
```

## 5. Test evidence for this release

`npm run ci` exits 0 on the stable build: typecheck, ESLint (zero warnings), Prettier, 835 unit +
integration + accessibility + regression tests, 68 performance tests, both builds, both manifest
validations, the security gate, packaging, and 44 browser e2e tests (Chromium and Firefox, including
the eight checks in `tests/e2e/release-chromium.spec.ts` summarised in §4). Coverage, measured by
`npm run test:coverage` (which `ci` does not run): 98.74 % statements, 96.27 % branches.

Live settings-to-disk evidence on the stable build: with `{host}-{title}.{ext}` and the subfolder
`AetherDL/Clips` configured, the real Firefox wrote
`AetherDL/Clips/127.0.0.1_<port>-sample.mp4` — the configured folder, the configured template, the
illegal `:` sanitised, and a single extension (§10.7).

## 6. Not verified here

Honest limits of this audit:

- **No store console was opened, and nothing was submitted.** "Validates for Chrome Web Store /
  Edge Add-ons / AMO" is evidenced by Mozilla's own linter, by the project's packaging validation,
  and by installing the extracted artifacts in real browsers. A store's own submission-time review
  cannot be run offline; submission needs accounts and credentials only the Project Owner holds, and
  PROJECT_BIBLE.md §18.8 makes it "a gated manual step". No `publish`/`submit` script, credential
  file or environment variable exists in this repository.
- **Icons are placeholders.** `build/scripts/gen-icons.ts` generates solid-colour placeholders; the
  128×128 file is 360 bytes. A listing needs the real icon set (see `docs/STORE_LISTING.md` §7).
- **Two capabilities the Bible specifies are not implemented,** and this release must not be
  described as having them: non-DRM HLS/DASH streams are detected but cannot be downloaded (stream
  assembly, §10.6, is unimplemented and `src/core/download/validate.ts` refuses `hls`/`dash`), and
  network-request observation does not exist (`src/platform/network` is contract-only). Both are
  recorded under "Known limitations" in `CHANGELOG.md` and in `docs/STORE_LISTING.md`. They are
  Phase 4/5 scope, not Phase 10, and they are the Owner's call before any 1.0 claim.
- **Human-only test cases** remain as recorded in `docs/MANUAL_TEST_MATRIX.md` §5: screen reader,
  notification and toolbar UI, private-window behaviour, a non-DRM streaming fixture, and the Edge,
  Brave, Opera and Vivaldi browsers, which are not installed in this environment.
- **No release tag exists.** The working tree is not a git repository
  (`git status` → `fatal: not a git repository`), so tagging could not be performed here.
## 7. Owner release declaration — 2026-08-20

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
