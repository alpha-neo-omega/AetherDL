# Real-World Stream Conformance — Executed Results

> **What this is.** Every other test in this repository feeds the stream code either bytes written
> by hand or media this project generated itself. That leaves one honest gap, and the 1.3.0 release
> notes stated it: no real packager's output had been through the parsers or the muxer. This file
> records what happened when it was.
>
> **How to reproduce:** `npm run test:live` (needs the network; `ffmpeg`/`ffprobe` for the decode
> cases). It is deliberately **not** part of `npm run ci`
> ([PROJECT_BIBLE.md §16.9](../PROJECT_BIBLE.md#169-real-world-stream-conformance)): a gate must be
> a statement about the code, and these cases can fail because a CDN moved an asset.
>
> **Nothing is published, uploaded or transmitted.** Every request is a `GET` for a manifest, or for
> a short prefix of a stream, from content published for testing — Apple's HLS examples, Mux's test
> streams, the DASH-IF-hosted Big Buck Bunny, and the DASH-IF live simulator. No credentials, no
> cookies, through the same `HttpClient` the extension ships.

| Field | Value |
| --- | --- |
| Executed | 2026-08-20 |
| Product version | `1.4.0` |
| Result | **9 cases, all passed** |
| Command | `npm run test:live` |
| Tools present | `ffmpeg` and `ffprobe` — so the decode cases ran rather than skipping |

## What was checked, and what it proved

| Case | Packager | Shape | Outcome |
| --- | --- | --- | --- |
| `apple-fmp4-separate-audio` | Apple (advanced fMP4 example) | HLS, fragmented MP4, audio in its own rendition, **byte-range segments inside one 585 MB file** | Planned as a two-track join; muxed output carried h264 + **AC-3** and decoded with no errors |
| `dash-akamai-bbb` | Akamai / Blender (DASH-IF hosted) | DASH, `SegmentTemplate` with `$Number$`, separate video and audio AdaptationSets | Planned as a two-track join; muxed output decoded with no errors |
| `apple-ts-muxed` | Apple (bipbop 4x3) | HLS, MPEG-TS, audio already inside each variant | Planned as a single track — correctly **not** treated as split |
| `mux-ts-muxed` | Mux (test-streams) | The same shape from a second packager | Planned as a single track |
| `apple-ts-separate-audio` | Apple (bipbop 16x9 advanced example) | MPEG-TS whose `AUDIO` group has a **URI-less default rendition** plus a URI-bearing alternate | Planned as a single track (see the defect below) |
| `dash-if-live-sim` | DASH-IF live simulator | A live MPD | Refused as live, with `stream-dash-dynamic`, rather than run forever |
| quality ladder | Akamai / Blender | A real ladder that tops out at **2160p / ~15 Mbps** | A `1080` preference selected the 1920x1080 representation |

## Two defects this found, both fixed

1. **An `AUDIO` group can mean the opposite of what we read it as.** Apple's advanced example
   declares a group whose **default** rendition has no `URI` — the audio is inside each variant —
   next to an alternate rendition that has one. The parser treated any URI-bearing rendition as
   proof of a split track, so assembly would have downloaded a video-only rendition and muxed in
   the *alternate* audio: a different stream from the one the page plays. A group now counts as
   separate only when **every** rendition in it has its own URI. Regression test:
   `tests/unit/core/download/stream/hls.test.ts`, verified to fail against the previous code.
2. **A brittle assertion in the harness itself.** The first run reported Apple's muxed output as
   having no audio. The muxer was correct; `ffprobe`'s CSV output gains a trailing field for a
   stream carrying side data, which AC-3 does, and the harness was string-matching those rows. It
   now parses `ffprobe`'s JSON. Recorded because a test that lies about the code is worse than no
   test.

## What the run also confirmed

- **Byte-range fMP4 works.** Apple's segments are ranges of one large file, and one segment carries
  **three** `moof`/`mdat` fragments. Both are handled; the output decoded frame for frame (720 video
  frames, 374 AC-3 frames from the prefix fetched).
- **AC-3 audio survives a join.** The muxer touches sample data not at all, so a codec it has never
  heard of passes through intact — which is the point of copying fragments verbatim.
- **"Highest bandwidth" was a bad default.** The DASH ladder really does offer 4K at ~15 Mbps, and
  Apple's master ranks an AC-3 variant highest. This is the measurement behind the quality picker
  ([ADR-011](adr/011-stream-rendition-selection-and-remuxing.md)).

## What is still NOT covered here

- **No real-world MPEG-TS split-track stream.** Public examples are scarce; the ones checked keep
  audio inside the variant. The MPEG-TS demux path is covered instead by media `ffmpeg` generates
  (judged by `ffprobe`) and by a committed fixture downloaded end to end in a real Chromium.
- **No packed-audio (`.aac`) rendition from a real packager.** Supported and unit-tested; not yet
  exercised against a live one.
- **No DASH case in a real browser.** The browser e2e covers HLS, including the split-track and
  MPEG-TS joins; DASH is covered by unit tests and by this suite.
- **Prefixes, not whole streams.** Each case reads a manifest and about three segments per track.
  A defect that only appears an hour into a stream would not be caught here.
- **Firefox.** The live suite runs in Node against the shipped modules; the Firefox assembly path
  is covered by unit tests and the installed-add-on e2e.
