# AetherDL — Store Listing Content

> [!IMPORTANT]
> **Nothing in this document has been submitted, uploaded, or published anywhere.** It is
> preparation material only. No store console has been opened, no developer account has been
> used, and no package has been sent to any review queue on the basis of this document.

## 1. Purpose and status

This file is the single place the store-listing copy and the store-asset inventory live, so that a
human can paste them into each store console when publication happens.

| Field                     | Value                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deliverable               | "store listings/assets", required by Phase 10 (PROJECT_BIBLE.md §22.11, line 2731; ROADMAP.md Phase 10 — Release Preparation, line 381)                                                   |
| Phase                     | Phase 11 — Stable Release. Its included scope is "Store submission/publication via official channels only" (ROADMAP.md:398); Phase 10 prepared this copy                                   |
| Publication phase         | Phase 11 — Stable Release, whose included scope is "Store submission/publication via official channels only" (ROADMAP.md:398)                                                             |
| Version to submit         | `1.2.2` — the 1.1.0 feature set (ADR-010) plus three fix sweeps: thirteen defects in 1.2.0, eight in 1.2.1, twelve in 1.2.2                                                              |
| Distribution channel      | Official extension stores only. Any other update channel is a permanent non-goal (PROJECT_BIBLE.md §3.1 item N17, line 286 onward)                                                        |
| Listing language          | English (`en`) only — the sole catalogue in the repository is `public/_locales/en/messages.json`, and `en` is the declared default and fallback locale (PROJECT_BIBLE.md §19.2)            |

Two preconditions apply before this copy is used:

1. **Cleared.** The artifacts under `dist/` are built at version `1.2.2`
   (`dist/chrome/manifest.json`, `dist/firefox/manifest.json`, matching `package.json`), and the
   packaged archives in `dist/release/` carry the same version. Versions are synchronized across
   all target builds from one source (PROJECT_BIBLE.md §7.6; ROADMAP.md §7).
2. **Verify the copy against the built release.** The feature statements below are taken from the
   normative feature specification (PROJECT_BIBLE.md §4) and the supported-media specification
   (§5). A store listing must describe what the submitted build actually does, so each claim needs
   a confirming pass over the stable build — the manual matrix in
   `docs/MANUAL_TEST_MATRIX.md` §3 exercises detection (M2/M3), direct download (M4), non-DRM
   stream download (M5), DRM refusal (M6), queue and retry
   (M7–M10), settings (M11), history
   (M12/M13), context menu (M18), and notifications (M19).

## 2. Store targets

Two build outputs exist, produced from a single source tree: `dist/chrome/` for Chromium and
`dist/firefox/` for Firefox (README.md "Build Outputs"; PROJECT_BIBLE.md §7.6). The build system
collapses the whole Chromium family to one target — `build/manifest/targets.ts:13` states
"Chromium family (Chrome, Edge, Brave, Opera, Vivaldi) collapses to `chrome`" — so every Chromium
store consumes the same artifact.

| Store                                            | Artifact        | Notes                                                                                                                                                                     |
| ------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome Web Store                                 | `dist/chrome/`  | Chrome is the "Primary MV3 reference target" (PROJECT_BIBLE.md §7.1, line 802)                                                                                             |
| Microsoft Edge Add-ons                           | `dist/chrome/`  | Edge is "Chrome-compatible MV3" (PROJECT_BIBLE.md §7.1)                                                                                                                   |
| Firefox AMO (addons.mozilla.org)                 | `dist/firefox/` | Gecko; MV3 with Firefox-specific differences (PROJECT_BIBLE.md §7.1, §7.4). The build declares add-on id `aetherdl@aetherdl.app` and `strict_min_version: "115.0"`         |
| Other Chromium-compatible stores (Opera add-ons) | `dist/chrome/`  | Opera, Brave, and Vivaldi are supported browsers (PROJECT_BIBLE.md §7.1). Brave and Vivaldi install from the Chrome Web Store; Opera's own catalogue is the separate target |

PROJECT_BIBLE.md §7.6 names the same four destinations: "one distributable per store (Chrome Web
Store, Edge Add-ons, Firefox AMO, and Chromium-compatible stores for Opera/others)". The Phase 10
acceptance criterion is that packages validate for all of them (PROJECT_BIBLE.md §22.11;
ROADMAP.md:385).

## 3. Listing copy

### 3.1 Name

**AetherDL**

Source: `public/_locales/en/messages.json` key `extName`, whose own description reads "The name of
the extension, shown in the toolbar and stores." Both built manifests reference it as
`__MSG_extName__` (`dist/chrome/manifest.json:3`, `dist/firefox/manifest.json:3`), so the store
name and the in-product name cannot drift.

### 3.2 Short summary

The shipped `extDescription` is the one the browser itself displays, and it is what the store reads
out of the package:

> Fast. Private. Powerful. A modern cross-browser media downloader.

**65 characters.** Source: `public/_locales/en/messages.json` key `extDescription`, referenced as
`__MSG_extDescription__` in both manifests. It matches the product tagline recorded in
PROJECT_BIBLE.md Document Control ("Tagline | Fast. Private. Powerful.") and repeated in README.md
lines 3–4.

Where a store offers a longer summary field than the manifest description, use this expanded
version, written to stay inside the Chrome Web Store's 132-character summary limit:

> Find and download the non-DRM video and audio on the page you are viewing. Runs entirely on your
> device. No accounts, no telemetry.

**131 characters**, so it fits the 132-character limit with one character to spare. Every clause is
sourced: non-DRM scope and the active tab (PROJECT_BIBLE.md §2.2, §4.1); on-device operation and
the absence of accounts and telemetry (PROJECT_BIBLE.md §14.1 guarantees 1–7, lines 2093–2101).

> [!NOTE]
> The 132-character figure is the Chrome Web Store's own field limit, not a repository fact.
> Confirm it in the console before pasting, and prefer the 65-character manifest description if a
> store rejects the longer form.

### 3.3 Full description

Paste the following as the long description. It is plain and feature-oriented; every paragraph is
traceable to a governing section.

---

AetherDL finds the media on the page you are already looking at and downloads it to your device.

**What it does**

- Detects media on the active tab: `<video>`, `<audio>` and `<source>` elements, direct media URLs,
  and non-DRM HLS and DASH manifests. Detection is per-tab and updates as new media appears on the
  page. (PROJECT_BIBLE.md §4.1)
- Downloads direct and progressive media through the browser's own download manager.
- Downloads **non-encrypted HLS and DASH streams** by reading the playlist, fetching its segments in
  order and joining them into one file, which your browser then saves (PROJECT_BIBLE.md §10.6).
  State the limits rather than imply them away — see CHANGELOG.md "Known limitations":
  a stream whose **audio is a separate track** is refused rather than saved as silent video (most
  real-world DASH is packaged that way), **live** streams cannot be downloaded, a stream is
  assembled in memory one at a time and declined past 1 GiB,
  the joined file is the segments concatenated with no remuxing (`.ts` for MPEG-TS, `.mp4` for
  fragmented MP4), only the highest-bandwidth rendition is taken, and **Firefox 115–127 cannot
  download streams at all** because the permission key AetherDL uses to ask for host access at the
  moment you click arrived in Firefox 128.
- Shows what it found before you commit: title, type, kind, resolution, duration, quality and
  source host. A field it cannot determine is left off the card rather than guessed
  (PROJECT_BIBLE.md §4.2). **Do not claim a file size**: size reaches a card only through network
  observation, which this build does not implement, so the size row never appears — see CHANGELOG.md
  "Known limitations".
- Downloads through the browser's own download facility, so transfers behave like every other
  download in your browser. (PROJECT_BIBLE.md §4.3, §10.8)
- Queues work instead of flooding your connection. Concurrency is capped by a setting, and the
  queue survives the browser suspending the extension's background page. Items can be paused,
  resumed, cancelled, retried and removed. (PROJECT_BIBLE.md §4.4)
- Retries only failures worth retrying, with exponential backoff. Permanent failures — a 403, a
  404, a protected stream — fail immediately with a stated reason instead of looping.
  (PROJECT_BIBLE.md §4.5)
- Flags media that is already in the download queue, so a second click cannot queue it twice. **Do
  not claim matching against download history**: the *Warn about duplicates* setting is stored but
  nothing reads it, and no history lookup exists in this build (PROJECT_BIBLE.md §4.6 makes the
  history comparison a MAY) — see CHANGELOG.md "Known limitations".
- Counts detected items on the toolbar badge for the tab you are on, and shows no badge when there
  is nothing to download. (PROJECT_BIBLE.md §4.7)
- Keeps a local history you control: search it, filter it, sort it, export it as JSON, delete
  single records, or clear all of it. Retention is your choice — forever, 90 days, 30 days, this
  session, or history switched off entirely. (PROJECT_BIBLE.md §4.11, §4.9)
- Settings for theme (system, light, dark), reduced motion, language, concurrent download limit,
  retry limit, filename template, download subfolder, duplicate warnings, detection sensitivity,
  notifications, context-menu entries and history retention. (PROJECT_BIBLE.md §4.9)
- Opens with a keyboard shortcut — `Ctrl+Shift+Y`, or `Command+Shift+Y` on macOS — which you can
  rebind in your browser's own shortcut settings. (`dist/chrome/manifest.json` `commands`;
  `public/_locales/en/messages.json` key `about_shortcutHint`)
- Works by keyboard alone and targets WCAG 2.1 AA. (PROJECT_BIBLE.md §2.6, §17)

**Supported formats**

Downloadable in this build — video: MP4, WebM, M4V, MOV, AVI, MKV, TS, M2TS, MTS, MPG/MPEG, WMV,
FLV, 3GP. Audio: MP3, AAC, M4A, FLAC, WAV, OGG. Streams: non-encrypted HLS (`.m3u8`) and DASH
(`.mpd`). Delivery: direct HTTP and HTTPS URLs, HTML5 media elements, progressive files, and
segmented streams assembled into one file. (PROJECT_BIBLE.md §5.1–§5.5, §10.6)

Not downloadable, by design: anything encrypted or DRM-protected, `blob:` media and MediaSource
streams (they have no addressable bytes to fetch), live streams (they have no end), and streams
that keep audio in a separate track — AetherDL refuses those rather than saving a video with no
sound, because joining the two tracks is out of scope.

**What it will not do**

AetherDL does not download DRM-protected media, and it never will. Netflix, Disney+, Prime Video,
Spotify and Apple Music are out of scope, as is any encrypted HLS or DASH stream, anything using
Encrypted Media Extensions, and anything behind an access control AetherDL would have to defeat.
Protected media is detected and refused with a plain explanation, not attempted and failed.
(PROJECT_BIBLE.md §6.1, §6.3)

**Privacy**

AetherDL has no server, no account and no telemetry. It collects nothing and **sends** nothing.

Be precise about the one thing it does request: to download a stream, AetherDL reads the playlist
and its segments itself — plain `GET` requests to the site's own media host, with no cookies and no
credentials attached, only for a download you asked for, and only on hosts you granted when you
clicked. Nothing else on your machine talks to the network on AetherDL's behalf, and a progressive
download is performed by the browser itself.

Your settings live in local extension storage; your queue and history live in a local database on
your device. Nothing about you, the pages you visit, or what you download leaves your machine,
because there is nowhere for it to go. (PROJECT_BIBLE.md §14.1, §14.2; see also
docs/adr/010-non-drm-stream-assembly.md, which records why the older "no network request of its own"
wording no longer applies.)

**Permissions**

AetherDL asks for local storage, downloads, access to the tab you are actively using, and
content-script injection at install — and **no site access at all**. On Chromium it also asks for
`offscreen`, which grants access to nothing: it lets AetherDL open its own hidden page to assemble a
stream, because a Chromium service worker cannot do that itself.

Site access is asked for **when you click download on a stream**, for that stream's hosts only. Every
granted site is listed in AetherDL's own Settings page, where each can be revoked. Declining cancels that download and nothing else. Notifications and
context-menu entries are optional and are requested only if you turn those features on.
(PROJECT_BIBLE.md §13.3, §13.7)

**Browsers**

Chrome, Edge, Brave, Opera, Vivaldi and Firefox, from one Manifest V3 codebase.
(PROJECT_BIBLE.md §7.1)

Open source under the MIT licence (`LICENSE`).

---

### 3.4 Category suggestion

| Store            | Suggested category   | Alternative           |
| ---------------- | -------------------- | --------------------- |
| Chrome Web Store | Functionality & UI   | Workflow & Planning   |
| Edge Add-ons     | Productivity         | Photos & Media        |
| Firefox AMO      | Download Management   | Privacy & Security    |
| Opera add-ons    | Downloads / Utilities | —                     |

> [!NOTE]
> Category names are store-side taxonomies, not repository facts, and stores rename them. The
> Owner must pick from whatever list each console actually presents. The choice is a positioning
> decision, not a technical one: nothing in the package depends on it.

### 3.5 Language

`en` only. There is exactly one message catalogue in the repository —
`public/_locales/en/messages.json` — and both manifests declare `"default_locale": "en"`
(`dist/chrome/manifest.json:6`, `dist/firefox/manifest.json:6`). English is the declared default
with fallback for missing translations (PROJECT_BIBLE.md §19.2). Do not list additional locales.

## 4. Permission justifications

These are the permissions actually present in the built manifests. Both targets declare
`"storage"`, `"downloads"`, `"activeTab"`, `"scripting"`; Chromium adds `"offscreen"`, which grants
access to nothing (see below). Both declare `"optional_host_permissions": ["*://*/*"]` and **no**
`host_permissions`. Read `dist/chrome/manifest.json` and `dist/firefox/manifest.json` to confirm.

### 4.1 Install-time permissions

| Permission   | Reason to give the reviewer                                                                                                                                | Governing section     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `storage`    | Saves your settings, your download queue and your download history on this device. Nothing stored here is transmitted anywhere.                            | §13.3, §8.14, §14.2   |
| `downloads`  | Performs the download itself through the browser's native download facility. This is the extension's core function; it cannot download files without it.   | §13.3, §4.3, §10.8    |
| `activeTab`  | Looks for media only in the tab you are actively using, and only when you act. This is what replaces broad access to every website.                        | §13.3, §13.1, §13.7   |
| `scripting`  | Injects the small detection script into that one tab on demand, rather than declaring a permanent content script for every page you visit.                 | §13.3, §7.5           |
| `offscreen` (Chromium only) | Grants access to nothing. It lets AetherDL open its own hidden extension page to join a stream's segments into one file, because a Chromium service worker cannot build the local file handle the download needs. Firefox needs no equivalent. | §7.4, §10.6, ADR-010 |

### 4.2 Optional permissions

Optional permissions are requested at point of use, on a user gesture, and are revocable
(`build/manifest/targets.ts:39-52`; PROJECT_BIBLE.md §4.15, §13.3). The two targets differ, and
the difference is deliberate.

| Permission      | Declared in                                                             | Reason to give the reviewer                                                                            | Governing section |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| `notifications` | Both (`dist/chrome/manifest.json`, `dist/firefox/manifest.json`)        | Tells you when a download finishes or fails. Requested only when you switch notifications on.          | §13.3, §4.10      |
| `contextMenus`  | Chromium only (`dist/chrome/manifest.json` `optional_permissions`)      | Adds "Download with AetherDL" to the right-click menu. Requested only when you switch that feature on. | §13.3, §4.13      |

`build/manifest/targets.ts:44-49` records why Firefox declares only `notifications`: Firefox does
not accept `menus` in `optional_permissions` and Mozilla's add-on linter rejects it, and requesting
it at install instead "would take a permission the user never chose". The context-menu feature
therefore reports itself unavailable on Firefox and degrades gracefully (PROJECT_BIBLE.md §7.2,
§7.4). Do not describe context-menu integration as a Firefox feature in the AMO listing.

### 4.3 Host permissions: none at install, asked for when you click

**Neither built manifest contains a `host_permissions` key, and neither lists any origin or
URL-match pattern in `permissions`.** No site access is granted when the extension is installed.
PROJECT_BIBLE.md §13.3 requires that ("**MUST NOT** request `<all_urls>` or broad host permissions
at install") and §13.7 sets the policy ("`activeTab` + user gesture. No standing host permissions.").

Both manifests **do** declare `optional_host_permissions: ["*://*/*"]`. That is a request AetherDL
may make later, never a grant it holds. What to tell a reviewer:

- It is used for **one thing**: downloading a non-encrypted HLS or DASH stream, which requires
  reading the playlist and its segments from the media host (§10.6).
- It is requested **on the download click**, and only for the origins that stream actually lives on
  — not the declared pattern. The pattern is broad only because a playlist names its segment hosts
  when it is read, so no narrower pattern can be declared in advance.
- The origin of the tab you are on is **not** requested at all: `activeTab` already covers it.
- Declining cancels that one download. Nothing else changes, and no other feature depends on it.
- It is revocable at any time from the browser's own extension controls.
- A freshly installed build holds nothing: the Firefox e2e asserts
  `permissions.getAll().origins === []`.

Firefox note for AMO: `optional_host_permissions` requires Firefox 128, so on Firefox 115–127 the
request cannot be made and stream downloads are unavailable there. Declaring the pattern under
`host_permissions` instead was tried and rejected — the installed add-on reported the origin already
granted, which is exactly the install-time access this project refuses to take.

### 4.4 Other manifest capabilities that stores may query

| Manifest key                                    | What to say                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands` (`_execute_action`, `Ctrl+Shift+Y`)  | A keyboard shortcut that opens the extension's own popup. No permission is involved.                                                            |
| `content_security_policy.extension_pages`       | `script-src 'self'; object-src 'none'` in both manifests. No remote code, no `eval`, no remote scripts or styles (PROJECT_BIBLE.md §13.2, §13.4) |
| `background`                                    | Non-persistent: a service worker on Chromium, an event page on Firefox (PROJECT_BIBLE.md §7.4, §7.5)                                            |
| `options_ui` (`settings.html`, `open_in_tab`)    | The settings and history surface, served from inside the package                                                                                |

## 5. Privacy disclosures

### 5.1 Plain-language privacy statement

Use this text wherever a store asks for a privacy summary. It is the product's own wording,
extended from `public/_locales/en/messages.json` key `about_privacy` ("AetherDL has no account, no
telemetry and sends nothing anywhere. It reads a playlist and its segments only to download what you
asked for, on hosts you granted.") and PROJECT_BIBLE.md §14.

---

AetherDL collects no data about you and sends no data anywhere.

There is no server behind it, no account to create, no analytics, no telemetry, no tracking, no
identifiers of any kind — no user ID, device ID, install ID or fingerprint (PROJECT_BIBLE.md
§14.1, §14.2). Detection, metadata extraction and history all happen on your own device
(§14.1 item 7).

What exists locally, and only locally (PROJECT_BIBLE.md §14.2):

| Data              | Where it lives                | Leaves your device | What you can do with it                  |
| ----------------- | ----------------------------- | ------------------ | ---------------------------------------- |
| Settings          | Local extension storage       | No                 | Edit or reset any of them                |
| Download queue    | Local database (IndexedDB)    | No                 | Cancel or clear                          |
| Download history  | Local database (IndexedDB)    | No                 | Search, delete, clear, or export as JSON. Capped at 5 000 records, oldest dropped first |
| Detection results | Memory only, per tab          | No                 | Discarded when you navigate or close     |

Network activity is limited to the downloads you ask for. A progressive file is fetched by the
browser itself. A stream is different: AetherDL reads the playlist and its segments itself, with
plain `GET` requests to the media host, no cookies and no credentials, on hosts you granted at the
moment you clicked — and nothing is ever uploaded or reported. AetherDL observes no network traffic:
what it lists comes from reading the page's DOM (network-request observation is unimplemented,
see CHANGELOG.md "Known limitations"). Uninstalling removes the
extension's local data, per your browser's normal behaviour (§14.4).

---

### 5.2 Chrome Web Store data-usage answers

The Chrome Web Store privacy tab asks which categories of user data the extension collects. The
answer is the same for every category, because §14.1 guarantee 4 is "No data collection" and §3.1
non-goal N7 makes data collection a permanent non-goal:

| Data category                                                          | Collected |
| ---------------------------------------------------------------------- | --------- |
| Personally identifiable information                                    | **No**    |
| Health information                                                     | **No**    |
| Financial and payment information                                      | **No**    |
| Authentication information                                             | **No**    |
| Personal communications                                                | **No**    |
| Location                                                               | **No**    |
| Web history                                                            | **No**    |
| User activity (clicks, mouse position, scroll, keystroke logging)       | **No**    |
| Website content (text, images, sounds, files, hyperlinks)               | **No**    |

Certification statements, all of which hold by architecture (PROJECT_BIBLE.md §14, §3.1 items
N4–N9):

- The extension does not sell or transfer user data to third parties, outside the approved use
  cases — **no data is transferred at all.**
- The extension does not use or transfer user data for purposes unrelated to its single purpose.
- The extension does not use or transfer user data to determine creditworthiness or for lending
  purposes.

Single purpose statement, if the console asks for one:

> AetherDL detects downloadable, non-DRM media on the tab the user is viewing and downloads it to
> the user's device using the browser's native download facility.

That wording is the Bible's own mission statement condensed (PROJECT_BIBLE.md §2.2).

> [!NOTE]
> The category list above reflects the Chrome Web Store's disclosure form as understood at the
> time of writing; it is not a repository artefact. Answer whichever categories the console
> actually presents — the answer is "no" for all of them.

### 5.3 Firefox data-collection disclosure

Already shipped in the package. `dist/firefox/manifest.json` declares, under
`browser_specific_settings.gecko`:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

The value comes from `FIREFOX_DATA_COLLECTION_PERMISSIONS` in `build/manifest/targets.ts:79-81`.
Its documented meaning (`build/manifest/targets.ts:61-77`): `required: ['none']` is "Mozilla's
declaration that the add-on collects NO data", it is "the only value consistent with what AetherDL
is", and it "DESCRIBES that existing behaviour; it grants nothing, requests no permission, and
changes no code path". The same comment records that the Project Owner ratified this value on
2026-08-19 for Phase 10, and that because Mozilla introduced the key in Firefox 140 (142 on
Android) while the build keeps `strict_min_version: "115.0"` for ESR support, the AMO linter is
expected to emit a warning that older versions ignore the key. Expect two such warnings — one for
desktop, one for Android — and note that `web-ext lint` classifies them as warnings, not notices,
and reports zero errors (docs/RELEASE_AUDIT.md §4). They are not defects.

When the AMO submission form asks about data collection, the answer must match the manifest: none.

## 6. Content boundaries

Reviewers screen media downloaders for circumvention tooling. State the boundary early and
plainly; it is a hard, permanent refusal, not a limitation awaiting a future release.

Text for a reviewer-notes or "additional information" field:

---

AetherDL downloads media that the user can already access unencrypted in their browser. It does
not circumvent DRM, and no amendment to this project will add that. This is written into the
project's governing specification as a permanent non-goal (PROJECT_BIBLE.md §3.1 items N1, N2, N3,
N15, N16, marked "hard, permanent refusals" that "no amendment process will approve").

Specifically, AetherDL:

- **Refuses DRM-protected content outright.** Netflix, Disney+, Prime Video, Spotify and Apple
  Music are listed as categorically unsupported (PROJECT_BIBLE.md §6.1).
- **Never engages Encrypted Media Extensions.** It requests no keys and performs no decryption
  (§6.1, §3.1 item N3).
- **Refuses encrypted streams.** An HLS playlist with an `#EXT-X-KEY` naming a real key system, or
  a DASH manifest with `ContentProtection`, is classified as unsupported. §5.5 states the hard
  limit: "No key acquisition, no decryption — ever."
- **Refuses access-controlled content.** Password-protected streams are unsupported; AetherDL does
  not defeat authentication barriers (§6.1).
- **Does not attempt workarounds.** §6.3: AetherDL "**MUST NOT** attempt any workaround, key
  request, or decryption for unsupported items." Protected items are surfaced as unsupported, with
  the download action disabled and the reason stated — the user-facing string is "This media is
  protected and cannot be downloaded." (`public/_locales/en/messages.json` key `error_drm`).
- **Never escalates into the page.** Content scripts run only in the isolated world and never
  inject into the page's main world, which is the technique DRM circumvention would require
  (PROJECT_BIBLE.md §13.6, §3.1 item N15).
- **Respects protection mechanisms.** §5.6: "AetherDL will not defeat anti-download measures that
  amount to protection circumvention. If a site's mechanism is protection, AetherDL respects it."

Refusal is a shipped, tested feature. The release's manual test matrix includes case M6, "DRM
refusal": with EME-protected media on the page, "the item is listed as unsupported with a refusal
reason; no download starts" (`docs/MANUAL_TEST_MATRIX.md` §3).

---

Do not use the words "any video", "any site", "bypass", "unlock", "unrestricted" or "DRM" as a
capability anywhere in the listing copy, the screenshots, or the promotional images. The listing
must not be readable as a circumvention tool, because the product is not one (PROJECT_BIBLE.md
§6.2, "Product identity").

## 7. Assets inventory

### 7.1 What exists

| Asset            | Path                                                                | Status                              |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Icon 16×16 PNG   | `public/icons/icon-16.png`, copied to `dist/chrome/`, `dist/firefox/` | Exists — the rendered mark |
| Icon 32×32 PNG   | `public/icons/icon-32.png`, copied to both builds                     | Exists — the rendered mark |
| Icon 48×48 PNG   | `public/icons/icon-48.png`, copied to both builds                     | Exists — the rendered mark |
| Icon 128×128 PNG | `public/icons/icon-128.png`, copied to both builds                    | Exists — the rendered mark |
| Screenshot 1 — popup, 1280×800 | `dist/release/assets/screenshot-1-popup-1280x800.png` | Exists — captured from the real build |
| Screenshot 2 — settings, 1280×800 | `dist/release/assets/screenshot-2-settings-1280x800.png` | Exists — captured from the real build |
| Screenshot 3 — settings/history, 1280×800 | `dist/release/assets/screenshot-3-settings-history-1280x800.png` | Exists — captured from the real build |
| Screenshot 4 — popup at actual size | `dist/release/assets/screenshot-4-popup-actual-size.png` | Exists — for composition |

Both screenshots of the popup show the media host as `127.0.0.1:8787` and the sample audio as
`0:00`: the images are photographs of the local non-DRM fixture site on a pinned port, and the
fixture's sample files carry no real duration. The port is fixed so repeated runs produce identical
images. If the Owner prefers a listing image without a loopback host, that is a composition step,
not a code change.

The four screenshots are produced by `npm run screenshots`
(`build/scripts/screenshots.ts`), which loads the built `dist/chrome` into a real Chromium, seeds
the popup with non-DRM sample media from the local fixture site over the ratified `detection/run`
message, and photographs the surfaces. They contain real UI, no mock-ups, and no third-party or
protected content. Screenshot 1 shows the popup panel on an otherwise empty 1280×800 canvas, which
is what a browser popup genuinely looks like; screenshot 4 is the same panel at its natural size,
for composing onto a store-sized canvas if the Owner prefers a filled frame.

All four icon sizes are declared in both manifests, under `icons` and under `action.default_icon`
(`dist/chrome/manifest.json`, `dist/firefox/manifest.json`), and the set of sizes matches
`ICON_SIZES = [16, 32, 48, 128]` in `build/scripts/gen-icons.ts:16`.

The icons are the real mark, not placeholders: a rounded indigo tile carrying a white download
glyph — a downward arrow over a tray — rendered at each size rather than scaled from one bitmap
(`build/scripts/gen-icons.ts`). The geometry is described in source and sampled 4×4 per pixel, so
the output is reviewable in the repository and reproducible byte-for-byte (§8.15). What the mark IS
is asserted by `tests/unit/build/icons.test.ts`, which decodes the PNGs and checks the tile, the
glyph and the field — so it cannot quietly regress to the solid square it replaced.

> [!NOTE]
> This is an in-house mark, drawn to survive 16px, not a commissioned identity. If the Owner wants
> a designed logotype, promotional tiles or a distinct brand treatment, that is still an Owner
> action — but nothing here blocks a store submission any more.

### 7.2 What does not exist yet

Nothing in the repository below this line exists in any form. Every row requires Owner action.
Screenshots are no longer on this list: §7.1 records the four that were captured from the real
build. Whether they are the final selection, and whether more screens are wanted, is the Owner's
call.

| Asset                       | Expected size            | Store                       | Status                     |
| --------------------------- | ------------------------ | --------------------------- | -------------------------- |
| Store logo                  | 300×300 PNG              | Microsoft Edge Add-ons      | **Owner action required** |
| Small promotional tile      | 440×280 PNG              | Chrome Web Store (optional) | **Owner action required** |
| Marquee promotional tile    | 1400×560 PNG             | Chrome Web Store (optional) | **Owner action required** |
| Promotional video           | Hosted video URL         | Chrome Web Store (optional) | **Owner action required** |

> [!NOTE]
> **The pixel dimensions in this table are store requirements, not repository facts, and stores
> change them.** They are recorded here so the Owner knows roughly what to produce; confirm each
> one against the live store console or its current documentation before finalising artwork.

Screenshot content guidance, so the images stay consistent with everything above:

- Capture the popup and the settings/history surface from a real build. The two screens are
  `popup.html` and `settings.html` (both manifests).
- Use the local fixture pages, not a real service. `docs/MANUAL_TEST_MATRIX.md` §2 provides
  fixture pages under `tests/e2e/_fixtures/site/` and instructs "never test against a real
  protected service".
- Never screenshot a protected service's page, a paid catalogue, or any DRM-protected title. §6.1
  and §6.2 make that content out of scope; a screenshot implying otherwise would misrepresent the
  product to a reviewer.
- Do not fake progress or results. PROJECT_BIBLE.md §2.8 requires honest state: "no fake progress,
  no lying spinners". The same applies to marketing images.

## 8. Owner input required

Every item below is outside the repository. None can be derived from the code, and each blocks a
required field in at least one store console.

**Identity and contact**

- [ ] Publisher / developer account identity for each store (Chrome Web Store, Edge Add-ons, AMO,
      Opera). The repository names only "AetherDL Project" as copyright holder (`LICENSE`) and
      "Project Owner (AetherDL)" as owner (PROJECT_BIBLE.md Document Control). No legal entity,
      person, or publisher display name is recorded anywhere.
- [ ] Author / developer display name to show on each listing.
- [ ] Contact email for store correspondence.

**URLs**

- [ ] Homepage URL. No homepage or repository URL appears anywhere in the repository
      (`package.json` declares none).
- [ ] Support URL or support email. Required by the Chrome Web Store and Edge; there is no support
      channel recorded in the repository.
- [ ] Privacy-policy URL. Required whenever a store's privacy tab is filled in. The content can be
      §5.1 of this document verbatim, but it must be published at a stable URL the Owner controls.
      Note that `aetherdl@aetherdl.app` (`build/manifest/targets.ts:56`) is a Firefox add-on
      **identifier**, not a mailbox, and must not be offered as a contact address.

**Approvals and decisions**

- [ ] Approve the short summary and full description in §3, after checking them against the
      release build (see §1, precondition 2).
- [ ] Approve the category choice per store (§3.4).
- [ ] Confirm `1.2.2` is the version to submit. The artifacts on disk and the packaged archives all
      read `1.2.2` (§1, precondition 1).
- [ ] Read §4.3 before answering any store question about site access: the listing must say that no
      host permission is granted at install and that access is requested per-origin when the user
      downloads a stream — and, for AMO, that Firefox 115–127 cannot download streams at all.
- [ ] Confirm the licence statement to display (the repository ships MIT, `LICENSE`).

**Assets**

- [ ] Decide whether the in-house mark (§7.1) is the identity to ship, or commission one (optional).
- [ ] Confirm the screenshot selection. Four images were captured from the real build into
      `dist/release/assets/` by `npm run screenshots` (§7.1); which of them the listing uses, and
      whether more screens are wanted, is unconfirmed.
- [ ] Decide whether to produce the optional Chrome Web Store promotional tiles and video (§7.2).

**Reminder**

- [ ] Nothing here is submitted. Submission is Phase 11 work and happens only after the Phase 10
      release candidate is approved by the Owner, the security gate and privacy audit are clean,
      and packages validate for every target store (PROJECT_BIBLE.md §22.11; ROADMAP.md:385-386,
      ROADMAP.md:398).
