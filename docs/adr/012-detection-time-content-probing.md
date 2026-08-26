# ADR-012: Identifying Media by Its Bytes, Before the User Asks for It

- **Status:** Accepted. Owner approval 2026-08-26 (Owner chose this option explicitly over the
  alternative that made no request until the download click).
- **Date:** 2026-08-26
- **Amends:** [ADR-010](010-non-drm-stream-assembly.md) — §14.3's "the reads a download requires".
- **Bible version:** 1.3.0

## Context

A user reported that AetherDL detects nothing on a video-hosting site. Measuring the site rather
than guessing produced the whole chain:

1. Its page is a client-rendered SPA. Its API returns the media URL in an obfuscated payload.
2. That URL ends in **`.txt`** and is served as **`text/plain`**. Its body is `#EXTM3U` — an HLS
   master playlist.
3. The variant playlist is also `.txt`. Its 331 segments are named **`.css`** and served as
   **`text/css`**. Their first byte is `0x47`: MPEG-TS.
4. Playback is hls.js into MediaSource, so the DOM holds only `<video src="blob:…">`.
5. There is no `#EXT-X-KEY`. It is not encrypted, and is squarely in scope.

The naming is not an accident; it is a measure against exactly this class of tool. And it defeated
AetherDL at three independent gates, each of which asked a name what only bytes can answer:

- the DOM has nothing downloadable in it, so detection saw a `blob:` and classified it unsupported;
- `.txt` / `text/plain` is not a recognised manifest, so even a surfaced URL was dropped by
  `validateCandidate`;
- the assembler chose its container from the URL extension, so `.css` MPEG-TS segments would have
  been written into a file called `.mp4`.

An audit of the detection path found the deeper cause: **nothing has ever populated
`context.networkResources`.** The `network-media` detector and the manifest detector's network
branch have been unreachable code since they were written, waiting for an observer that was never
built (`platform/network` is a contract with the comment "Implementation lands in Phase 3/4").

## Decision

1. **The content script reports what the page fetched**, read from the page's own Resource Timing
   timeline. No request is made to obtain this, nothing is intercepted, and nothing about the page
   is mutated. `initiatorType` is carried because it is the one signal a disguise cannot fake: a
   playlist fetched by script is `fetch`/`xmlhttprequest`, whatever it is named.
2. **The background identifies those resources by reading their first bytes** — through the single
   network door, a credential-free `GET`, at most 1 KiB, at most 8 URLs per detection pass, cached
   so no URL is read twice, and skipping anything the browser loaded as a page asset. This is a
   network read that no download asked for, which §14.3 did not permit; that is what this ADR
   amends.
3. **Bytes beat names everywhere.** `#EXTM3U` means HLS, `<MPD` means DASH, `0x47` at 188-byte
   strides means MPEG-TS, `ftyp`/`styp`/`moof` means MP4, whatever the URL or `Content-Type` says.
   The conclusion travels with the item into assembly, so the download path does not re-decide from
   the name and refuse what detection established.
4. **A truthful MIME, not a special case.** The probe reports the MIME the bytes imply, which is
   what makes the existing detectors work unchanged rather than growing a parallel path.
5. **No new permission.** These hosts answer any origin (`Access-Control-Allow-Origin: *`) because
   the page's own player must read them, so a probe succeeds without host access. Where a host does
   not, the probe fails and detection is exactly as good as it was before. **Adding a host
   permission to "make probing work everywhere" is forbidden** ([§13.3](../../PROJECT_BIBLE.md#133-permission-strategy)).
6. **A plain `GET` that stops reading, not a `Range` request.** `Range` is not CORS-safelisted:
   cross-origin it forces a preflight many hosts do not answer, and a host that ignores it answers
   `200` with the whole body. Measured against the real host before choosing.
7. **Two passes, so latency is unaffected.** The DOM result is committed and broadcast first; the
   probe runs after and re-runs detection only if it found something. The 300 ms detection budget
   ([§12.1](../../PROJECT_BIBLE.md#121-performance-budgets)) never waits on a third-party host.
8. **A stream is its manifest, not its segments.** Once a playlist is identified, the pieces it
   lists are suppressed — otherwise one video fills the popup with 331 fragments of itself.

## What does not change

- **Nothing is transmitted.** No analytics, telemetry, beacon, socket, account or user data, and no
  setting can enable any. That is [§14.1](../../PROJECT_BIBLE.md#141-privacy-guarantees-all-must-hold),
  permanent under [§25.3](../../PROJECT_BIBLE.md#253-non-amendable-items), and untouched.
- **The DRM boundary.** Encryption is still refused from the manifest's own text before a single
  segment is fetched, no key is read, and no decryption exists (§6, ADR-005). A byte sniff decides
  what a container is; it may never be used to decide anything about protected content.
- **One network door**, GET only, no credentials, `http(s)` only, bounded, and mechanically proven
  unreachable from every UI surface by the release gate (§13.10).
- **Non-goal N20** — AetherDL does not become a crawler. The probe reads only URLs the page itself
  already loaded; it never constructs a URL, follows a link, or retries a variant.

## Consequences

- Streams that a player fetches with script — most modern video, including every site that
  disguises its media — become detectable at all.
- The honest cost: the extension now issues a small number of requests the user did not directly
  ask for, to hosts the page had already contacted. A host learns that a resource it just served
  was read again. That is a real, if narrow, privacy cost, and it is why this needed an amendment
  rather than a commit.
- A second, deliberate consequence: what a page fetched is now visible to the background for the
  duration of a detection pass. It is held in memory, per tab, never persisted (§9.9), and dropped
  on navigation.
- Container decisions everywhere now follow the bytes, which fixes a latent defect independent of
  this feature: a mislabelled segment used to produce a correctly-downloaded file with the wrong
  name and the wrong internal handling.

## Alternatives considered

- **Probe only at download time** (the option not taken). It preserves §14.3 word for word, and the
  Owner rejected it: the item has to appear in the popup before anyone can click it, so a stream
  that is only identifiable by its bytes would never be offered at all.
- **`webRequest` observation.** Sees every request without reading any body, and would cover hosts
  with restrictive CORS. It needs a broad host permission at install, which §13.3 forbids outright.
  Not closed forever, but it is a bigger amendment than this one and buys less.
- **Trust `Content-Type`.** Free, and useless here: the disguise includes the `Content-Type`.
- **Match a list of known bad hosts.** Unmaintainable, and wrong in principle — the fix belongs in
  how the code decides what a resource is, not in a list of who lied last.
