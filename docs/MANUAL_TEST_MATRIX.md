# AetherDL — Manual Test Matrix

The documented manual pass required once per release by
[PROJECT_BIBLE.md §16.7](../PROJECT_BIBLE.md#167-manual-test-matrix) and delivered by
[ROADMAP.md Phase 9](../ROADMAP.md#phase-9--testing--quality-assurance).

Automated suites cover everything a headless browser can reach: unit, integration, accessibility,
regression, performance, and browser e2e ([§16.1–§16.6](../PROJECT_BIBLE.md#16-testing)). This
matrix covers what they cannot — a real toolbar click, a real screen reader, real notification
surfaces, and the four Chromium distributions that no CI runner installs.

## 1. Build under test

```bash
npm run ci          # gates, budgets, security gate, e2e — must be green first
npm run build       # dist/chrome and dist/firefox
```

Record the version from `dist/<target>/manifest.json` and the commit under test in §5.

## 2. Loading the extension

| Browser | How to load |
|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi | `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `dist/chrome` |
| Firefox (temporary install) | `npx web-ext run --source-dir dist/firefox` — launches Firefox with the extension installed |
| Firefox (manual) | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox/manifest.json` |

Fixture pages for the media cases live in `tests/e2e/_fixtures/site/` (a page with non-DRM sample
media, and a page with none). Serve that directory over `http://127.0.0.1` with any static file
server — content scripts and downloads behave differently on `file://` — and never test against a
real protected service ([§6](../PROJECT_BIBLE.md#6-unsupported-content)).

## 3. Cases

Each case is pass/fail per browser. A failure is a defect against the Bible and blocks the release
([§12.9](../PROJECT_BIBLE.md#129-performance-regression-policy),
[§18.9](../PROJECT_BIBLE.md#189-release-strategy)).

| # | Case | Steps | Expected |
|---|---|---|---|
| M1 | Install | Load the unpacked build | No errors in the extension console; toolbar icon present |
| M2 | Detect | Open the fixture media page, click the toolbar icon | Popup lists the page's video and audio; badge shows the count |
| M3 | Detect (no media) | Open the plain fixture page, click the toolbar icon | Popup shows the empty state; badge blank |
| M4 | Download (direct) | In the popup, download the sample MP4 | Native download starts and completes; file lands in the browser's download folder |
| M5 | Download (non-DRM stream) | Open a page with a non-DRM HLS manifest, download it | The stream is assembled from its segments and saved as one playable file, or refused with a clear reason — never a silent failure |
| M5b | Refuse an encrypted stream | Open a page with an AES-128 HLS playlist, download it | Refused before any segment is fetched, with a stated reason; no key request appears anywhere |
| M5c | Decline host access | Download a CDN-hosted stream, decline the permission prompt | That download is cancelled with a clear message; every other feature keeps working |
| M5d | Join a split-track stream | Download an HLS master whose audio is a separate rendition (fragmented MP4 **and** MPEG-TS), or a DASH manifest with separate audio/video AdaptationSets | Both tracks are fetched and joined into one playable file. A silent video is never saved, and a rendition whose codecs cannot be joined is refused with the stream types named |
| M5f | Choose a stream quality | On a stream in the popup, use *Quality*, pick a rendition below the top one, download it | The list shows the heights and bitrates the manifest declares, marks the preferred one, and the saved file is the rendition that was clicked — not the largest |
| M5e | Read the failure reason | Look at any failed job in the queue | The job shows why it failed, not just "Failed"; an encrypted stream reads as protected media |
| M25 | Review and revoke site access | Settings → Permissions → Site access | Every granted origin is listed; revoking one removes it and leaves the others |
| M6 | DRM refusal | Open a page with EME-protected media | The item is listed as unsupported with a refusal reason; no download starts |
| M7 | Queue | Start several downloads at once | At most *Maximum concurrent downloads* run; the rest queue |
| M8 | Pause / resume | Pause a running download, then resume it | State reflects both; the file completes intact |
| M9 | Cancel | Cancel a running download | Job leaves the active set; no partial file is presented as complete |
| M10 | Retry | Force a failure (stop the fixture server mid-transfer), then retry | Automatic retry with backoff; manual retry succeeds once the server is back |
| M11 | Settings | Change every setting; reopen the page | Values persist and apply live in an open popup |
| M12 | History | Complete a download; browse, search, export, delete, clear | Records appear; export writes a local file; clear empties the list |
| M13 | History off | Turn *Keep history* off; complete a download | Nothing new is recorded |
| M14 | Theme | Switch theme light/dark/system; change the OS theme | Popup and settings follow immediately |
| M15 | Reduced motion | Enable the OS reduced-motion setting | Animations are suppressed on both surfaces |
| M16 | Keyboard only | Operate the popup and settings with Tab/Shift-Tab/Enter/Space only | Every control reachable, visible focus ring, no trap |
| M17 | Screen reader | Read the popup and settings with the platform screen reader | Controls announce name, role and state; status changes are announced |
| M18 | Context menu | Grant the optional permission; right-click a media page | Entries list the detected media; choosing one downloads it |
| M19 | Notifications | Grant the optional permission; complete and fail a download | Completion and failure notifications appear; clicking one opens the popup |
| M20 | Permission revoke | Revoke both optional permissions | Menus and notifications stop; nothing throws; the UI states why |
| M21 | Keyboard command | Press the *Open popup* shortcut (`Ctrl+Shift+Y` / `Cmd+Shift+Y`) | The popup opens |
| M22 | Background restart | Idle until the service worker suspends (Chromium), then act | Queue and settings survive; the extension answers |
| M23 | Private window | Run the extension in a private/incognito window (where enabled) | No history is written from a private window |
| M24 | Network activity confined to the download | Watch DevTools → Network for the extension pages during a full session | Nothing is sent anywhere. The only requests are the media transfer the user asked for and, for a stream, the playlist and segments that download needs |

## 4. Accessibility pass (§17)

Run M16 and M17 on at least one Chromium browser and on Firefox, with:

- **Windows:** NVDA or Narrator · **macOS:** VoiceOver · **Linux:** Orca
- Browser zoom at 200%, and the OS high-contrast theme enabled.

## 5. Results

Copy the block below per release. Every row records what the browser actually did;
`NOT EXECUTED` is used wherever a case needs a human or a browser this environment does not have,
and is never recorded as a pass.

```
Version:        1.0.0 (re-executed on the stable release build)
Commit:         Phase 11 stable release (uncommitted working tree; not a git repository)
Date:           2026-08-19 (re-run after the download-settings wiring fix, at 0.9.1, and again at
                1.0.0)
Tester:         automated execution — tests/e2e/matrix-chromium.spec.ts,
                tests/e2e/matrix-firefox.spec.ts, tests/e2e/chromium.spec.ts,
                tests/e2e/firefox.spec.ts
Engines:        Chromium 1228, real unpacked install
                Firefox 1532, real temporary install driven over Marionette
                Edge / Brave / Opera / Vivaldi: NOT EXECUTED — not installed in this
                environment; all four ship the same Chromium engine and consume the
                identical dist/chrome artifact
```

| Case | Chromium | Firefox | Observed |
|---|---|---|---|
| M1 install | PASS | PASS | MV3; install permissions `storage, downloads, activeTab, scripting` (+ `offscreen` on Chromium); **no** `host_permissions` on either target; `optional_host_permissions` = `*://*/*` on both; Firefox optional = `notifications` only, and a freshly installed Firefox reports `permissions.getAll().origins === []` |
| M2 detect | PASS | PASS | Shipped `content.js` read `sample.mp4` + `sample.mp3` from a real DOM; badge showed the supported count |
| M3 no media | PASS | PASS | Empty state, 0 media cards |
| M4 download (direct) | PASS | PASS | Native transfer completed, bytes > 0; queue `completed`; filename `sample.mp4` (single extension); history recorded |
| M5 download (non-DRM stream) | PASS (automated) | NOT EXECUTED | Chromium, real browser, loopback HLS fixture: master → media playlist → 3 segments assembled and saved through `chrome.downloads` as one 12 288-byte file (exactly the segments), queue `completed`, name `.ts` not `.m3u8` (`tests/e2e/stream-chromium.spec.ts`). **Not tried against a live streaming site.** Firefox assembles in its event page instead of an offscreen document; that path is unit-tested only |
| M5b encrypted stream refused | PASS (automated) | NOT EXECUTED | Chromium: an AES-128 playlist failed with `stream-hls-encrypted`, native download count unchanged 0 → 0, no key requested. Parser-level refusals (AES-128, SAMPLE-AES, unknown methods, session keys, DASH `ContentProtection`/`cenc:pssh`/`pssh`) are unit-tested, including the assertion that no key host or filename appears in a refusal |
| M5d split-track joined | PASS (automated) | NOT EXECUTED | Chromium, real browser, two committed fixtures: a fragmented-MP4 split-track stream and an **MPEG-TS** one (real h264 + aac). Each was saved as one `.mp4` whose byte count equals what the shipped muxer produces, computed independently in the test (`tests/e2e/stream-chromium.spec.ts`). A rendition whose bytes are not a transport stream is still refused, with `stream-ts-not-a-stream`, and downloads nothing. DASH joining is unit-tested; real packagers' fMP4 and DASH output is exercised by `npm run test:live` (docs/LIVE_STREAM_CHECK.md) |
| M5f stream quality chosen | PASS (automated) | NOT EXECUTED | Chromium, real browser: `stream/qualities` listed a three-rung ladder over the real message bus and marked the preferred rung; a pinned rendition and a `720` preference each produced exactly that rung's byte count, where every rung serves a different segment size (`tests/e2e/stream-chromium.spec.ts`). The popup chooser itself — the dialog, its focus handling and Escape — is covered by `tests/unit/ui/popup/app.test.tsx` and the accessibility suite |
| M5e failure reason shown | PASS (automated) | PASS (automated) | Rendered from the job's own error in the queue panel; asserted for a DRM refusal and for a live-stream refusal (`tests/unit/ui/popup/app.test.tsx`). Not walked by hand in either browser |
| M25 site access review/revoke | PASS (automated) | PASS (automated) | Granted origins listed and revoked individually, with a failed revoke reported rather than assumed (`tests/unit/ui/settings/app.test.tsx`, `tests/unit/runtime/settings/client.test.ts`). The browser-side grant itself needs a human prompt, so the end-to-end path is not automated |
| M5c host access declined | NOT EXECUTED | NOT EXECUTED | A native permission prompt cannot be accepted or dismissed by automation. The request path (origins asked for, tab origin skipped, decline handled with its own message) is covered by `tests/unit/runtime/popup/client.test.ts` and `tests/unit/ui/popup/app.test.tsx` |
| M6 DRM refusal | PASS | PASS | Item `unsupported` with reason; job `failed/download-unsupported-status`; native downloads 0 → 0 |
| M7 queue concurrency | PASS | PASS | With *Maximum concurrent downloads* = 2: Chromium `active=2, queued=2, total=4`; Firefox `active=2, total=4` |
| M8 pause / resume | PASS | PASS | `active → paused → active` on both engines |
| M9 cancel | PASS | PASS | `canceled`; job left the active set |
| M10 retry | PARTIAL | NOT EXECUTED | Chromium: the failure surfaced as `failed/download-native-failed` (retryable) and a manual retry started a fresh transfer (native downloads 7 → 8 in the 1.0.0 run). The live case ran with *Maximum retries* = 0, so it proves the configured limit is honoured (0 attempts), **not** automatic retry with backoff — that half is covered by `tests/regression/download-settings.test.ts` (maxRetries = 2 → exactly three native starts) and by `tests/unit/core/download/manager.test.ts`, not in a browser |
| M11 settings | PASS | PASS | Persisted and re-read after reload on both engines; appearance applies live. Of the four download settings: concurrency verified live on both engines (M7), the retry limit live on Chromium (M10), and the filename template plus subfolder live on Firefox against the file the browser actually wrote — `AetherDL/Clips/127.0.0.1_44205-sample.mp4`, one extension, correct folder. No single engine exercised all four, and template/subfolder are not observable in Chromium here because Playwright rewrites a download's path to its own artifacts directory. `tests/regression/download-settings.test.ts` covers all four together at the runtime boundary |
| M12 history | PASS | PARTIAL | Chromium: 2 records listed, exported 638 bytes of JSON, one deleted, then cleared. Firefox: recording verified; browse/export/delete/clear exercised on Chromium only |
| M13 history off | PASS | NOT EXECUTED | Chromium: nothing recorded with *Keep history* off |
| M14 theme | PASS | PASS | Chromium follows the OS scheme (`rgb(18,19,24)` vs `rgb(251,248,255)`); Firefox follows the setting (`#121318` vs `#FBF8FF`) |
| M15 reduced motion | PASS | PASS | 0 transitions/animations ≥ 10 ms; Firefox also sets `data-reduced-motion=true` |
| M16 keyboard only | PARTIAL | PARTIAL | Chromium: a live Tab walk over the popup — 9 distinct stops, visible focus ring, focus never lost. Firefox: a structural audit of the settings page — 20 controls, 0 removed from the tab order, 0 unnamed, 0 disabled. Neither engine drove the whole surface with the keyboard only, and the §4 conditions (200 % zoom, OS high-contrast, a screen reader) were not applied — see M17 |
| M17 screen reader | NOT EXECUTED | NOT EXECUTED | Needs a human with NVDA / VoiceOver / Orca |
| M18 context menu | PARTIAL | N/A | Chromium: the optional permission was requested from a real gesture and granted; the menu surface itself is browser UI. Firefox: capability absent by design — no control offered, none reported |
| M19 notifications | NOT EXECUTED | NOT EXECUTED | Notification display is browser UI |
| M20 permission revoke | PASS | N/A | Chromium: no optional permission remained granted after revoke |
| M21 keyboard command | NOT EXECUTED | NOT EXECUTED | Browser-level shortcut, unreachable from page automation |
| M22 background restart | NOT EXECUTED | NOT EXECUTED | No deterministic way to suspend an MV3 worker from automation |
| M23 private window | NOT EXECUTED | NOT EXECUTED | Extensions are disabled in private windows unless the user opts in |
| M24 network activity confined to the download | PASS | PASS | Chromium: no request to any host but the one the user's download went to; the stream case observed the manifest, the media playlist and its 3 segments and nothing else. Gecko: no remote resource loaded (no remote script, font, stylesheet or image). Renamed from "zero egress": the extension now performs the reads a stream download requires, and still sends nothing |

No case is failing. The remaining gaps are:

- `NOT EXECUTED` rows — human- or environment-bound (M5c, M17, M19, M21, M22, M23 on both engines;
  M5, M5b, M10 and M13 on Firefox), plus the Edge, Brave, Opera and Vivaldi columns, which are not
  installed here. M5 and M5b now pass automatically on Chromium, against a loopback fixture; a
  live-site pass remains unexecuted, and no DASH browser case exists at all.
- `PARTIAL` rows — M10 (automatic retry with backoff covered by unit and regression tests rather
  than in a browser), M11 (no single engine exercised all four download settings), M12 (Firefox
  recording verified; browse/export/delete/clear exercised on Chromium), M16 (each engine covered a
  different half, and the §4 conditions were not applied), and M18, whose Chromium half is only
  half-observable and whose Firefox half is `N/A` because the capability is absent there by design:
  **the context-menu surface itself is verified in no browser**, only its permission request and its
  absence on Firefox.

**A release ships only when every case passes on every supported browser, or the Project Owner
records an explicit, dated exception here.**

### Owner exception — 2026-08-20

> Updated for `1.1.0`: M5 (non-DRM stream download) and the new M5b (encrypted stream refused) now
> **pass automatically on Chromium** against a loopback HLS fixture, so they are no longer part of
> the unexecuted set on that engine. Everything else in this exception stands unchanged, and three
> stream-related gaps are added to it: no live-site pass, no DASH browser case, and no Firefox
> stream case (Firefox 115–127 cannot download streams at all — see CHANGELOG.md).

The Project Owner accepts the gaps listed above for the 1.0.0 stable release:

- The `NOT EXECUTED` cases — M5c (declining host access), M17 (screen reader), M19 (notifications),
  M21 (keyboard command), M22 (background restart), M23 (private window) on both engines, and M5,
  M5b, M10 and M13 on Firefox — **remain unexecuted**. They were not run, and nothing in this file or
  elsewhere represents them as passing.
- The `PARTIAL` rows stand as written, including M18, whose context-menu surface is verified in no
  browser.
- **Edge, Brave, Opera and Vivaldi remain untested.** They are not installed in this environment.
  They share the Chromium engine and consume the identical `dist/chrome` artifact, which was
  installed and driven in Chromium; that is the extent of the evidence, and it is not a claim that
  those four browsers were tested.

This exception waives the ship rule above for 1.0.0 only. It does not convert any case into a pass,
and it does not apply to a later release.

