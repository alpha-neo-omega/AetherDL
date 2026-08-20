# ADR-010: Assemble non-DRM HLS/DASH downloads in the extension, and say so about the network

- **Status:** Accepted
- **Date:** 2026-08-20
- **Approval:** Project Owner, 2026-08-20 ("also fogot about project bible and implemnt those
  formats", with M3U8 and MPD named in the requested format set)
- **Amendment:** applied. PROJECT_BIBLE.md incremented to **1.1.0** on 2026-08-20 under §25.2;
  AGENT_RULES.md, ARCHITECTURE.md and ROADMAP.md amended to match.

## Context

[PROJECT_BIBLE.md §10.6](../../PROJECT_BIBLE.md#106-stream-assembly-non-drm) describes stream
assembly as a capability of the product, and §5.5 classifies HLS/DASH delivery. Through 1.0.0 it
was not implemented: manifests were detected, listed, and refused at download validation, and the
Owner's 1.0.0 release decision (C) deferred it explicitly.

The Owner has since directed that the format set in their reference include **M3U8** and **MPD**,
i.e. that streams become downloadable, and instructed that the frozen scope of PROJECT_BIBLE.md
not stand in the way.

Two facts made this more than a feature:

1. A playlist is not a file. Saving `master.m3u8` through the browser's download manager saves a
   few lines of text, not a video. Downloading a stream **requires the extension itself to fetch**
   the playlist and every segment.
2. §14.3 as ratified in Bible 1.0.0 ("No External Network Calls by the Extension") and the shipped
   1.0.0 copy claimed the extension makes **no network call of its own**, and the release security
   gate enforced that by failing on any `fetch` in `src/`. Implementing assembly makes that claim
   false.

## Decision

Implement assembly for **non-encrypted** HLS and DASH, and change the network claim to match
reality rather than keep a claim the code no longer honours.

1. **Parsers are pure and refuse encryption first.** `core/download/stream/hls.ts` and
   `dash.ts` take text and return a description or a refusal. Any `#EXT-X-KEY` /
   `#EXT-X-SESSION-KEY` with a method other than `NONE`, any `ContentProtection`, `cenc:pssh` or
   `pssh`, ends parsing. A key URI is never read, followed, returned or logged. The DASH parser
   carries its own bounded tag scanner because a Chromium MV3 service worker has no `DOMParser`.
2. **One network door.** `platform/http` is the only contract that may reach the network:
   GET only, `credentials: 'omit'`, `cache: 'no-store'`, http(s) only, size ceilings, timeouts,
   abortable. The security gate allows `fetch` in exactly one file and, over the emitted import
   graph, proves no UI surface can reach it.
3. **The browser still writes the file.** Assembly produces bytes, wraps them in a `blob:` URL and
   hands that to the Downloads API, so the transfer of record stays the browser's
   ([§10.8](../../PROJECT_BIBLE.md#108-downloads-api-usage)).
4. **Per-engine assembly context.** A Firefox MV3 event page has the DOM APIs, so it assembles in
   place. A Chromium MV3 service worker cannot create a `blob:` URL, so Chromium adds the
   `offscreen` permission and assembles in an offscreen document, exchanging only small messages
   (a manifest URL out, a local URL back). The choice is a capability check, not a browser check.
5. **Host access at point of use.** `*://*/*` is declared **optional** on both targets and
   requested on the click, for the specific origins in play; the tab's own origin is skipped
   because `activeTab` already covers it. Declining cancels that download only.
6. **The claim changes.** Docs, store listing, release audit and the gate's own check name now say:
   the extension performs the reads a stream download requires, and **sends** nothing — no
   analytics, telemetry, beacon, socket or report, ever.

## Consequences

Positive:

- Streams the user is entitled to download can actually be downloaded, on both engines.
- The privacy claim is narrower but true, and mechanically enforced rather than asserted.
- Encryption refusal is now enforced in three places (detection classification, download
  validation, and the parsers themselves) instead of one.

Negative / accepted costs:

- **Firefox 115–127 cannot download streams.** `optional_host_permissions` arrived in Firefox 128,
  and taking host access at install instead was measured and rejected: a Firefox build declaring
  the pattern under `host_permissions` came back from `permissions.getAll()` already granted.
- A stream is assembled in memory, with a 1 GiB refusal ceiling.
- No remuxing: concatenated MPEG-TS segments produce `.ts`, fMP4 segments produce `.mp4`.
- Live streams are not downloadable; only the highest-bandwidth rendition is assembled.
- **[PROJECT_BIBLE.md §14.3](../../PROJECT_BIBLE.md#143-external-network-calls-by-the-extension) was
  amended** rather than left in conflict: the Owner approved the amendment on 2026-08-20 and the
  Bible is now version **1.1.0**. §14.3 is retitled "External Network Calls by the Extension" and
  states the permitted activity exhaustively, with the no-transmission guarantee kept permanent
  under §25.3. §2.6, §5.1, §7.4, §10.6, §12.1, §13.3, §22.11 and §24 were amended with it, and
  AGENT_RULES.md, ARCHITECTURE.md and ROADMAP.md were brought into line.

## Alternatives considered

- **Keep refusing streams.** Rejected: it is the Owner's explicit direction to implement them.
- **Hand the playlist to the Downloads API.** Rejected: it saves a text file and would be a lie
  about what the product does.
- **Fetch from a content script on the page's origin.** Rejected: it would put network code and
  media bytes inside every page's world, and it breaks for cross-origin CDNs.
- **Ship a remuxer (mp4box/ffmpeg.wasm).** Rejected for this release: a large new dependency, and
  concatenated segments already play.
