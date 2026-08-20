# ADR-011: Stream Rendition Selection, and Container Work on Stream Tracks

- **Status:** Accepted. Owner approval 2026-08-20 (Owner directive to expand the stream feature set).
- **Date:** 2026-08-20
- **Supersedes:** nothing. **Amends:** [ADR-010](010-non-drm-stream-assembly.md) — the two
  implementation limits it recorded as permanent-for-now (no remuxing, highest bandwidth only).
- **Bible version:** 1.2.0

## Context

ADR-010 shipped assembly with two limits stated plainly, both of which the code then ran into:

1. **"Remuxing: none."** A stream whose audio is a separate track could not be joined, so it was
   refused. Product 1.3.0 already went past this for fragmented MP4 — it joins two fMP4 tracks
   into one file — and the Bible was not amended at the time. That gap is closed here, together
   with the remaining half: MPEG-TS renditions, which are not tracks at all but 188-byte packets
   carrying interleaved elementary streams, and HLS "packed audio" renditions, which are bare
   ADTS files with no container around them.
2. **"Rendition: highest bandwidth only."** Measured against real manifests this is a poor
   default rather than a neutral one. The DASH-IF-hosted Big Buck Bunny manifest offers 2160p at
   ~15 Mbps; Apple's advanced example ranks an AC-3 variant highest. "Highest bandwidth" quietly
   downloaded a 4K copy of a clip a user wanted at 720p, and quietly chose an audio codec.

Two facts discovered by pointing the shipped parsers at real manifests also bear on this
([§16.9](../../PROJECT_BIBLE.md#169-real-world-stream-conformance)):

- An HLS `AUDIO` group can contain a rendition with **no** `URI` (the audio is inside each variant)
  alongside alternates that have one. Reading any URI-bearing rendition as "the variant has no
  audio" made assembly download a video-only rendition and mux in an alternate track — a different
  stream from the one the page plays.
- Real fragmented MP4 arrives as byte ranges of one large file, and one segment can carry several
  `moof`/`mdat` fragments. Both work, and are now covered by evidence rather than by assumption.

## Decision

1. **Rendition selection becomes the user's** — a settings preference
   (`highest` | `2160` | `1440` | `1080` | `720` | `480` | `lowest`, default `highest`) applied at
   assembly time, plus a per-download chooser that lists what a stream actually offers. A height is
   a **ceiling**: the best copy at or below it. A ceiling that excludes everything takes the
   smallest rendition rather than refusing the download.
2. **The chooser reads the manifest and nothing else.** One GET, gated by the same point-of-use
   host permission the download itself needs ([§13.7](../../PROJECT_BIBLE.md#137-least-privilege-model)),
   so the user is asked once. No segment is fetched and nothing is queued.
3. **Container work is permitted on stream tracks, and defined narrowly.** Assembly may
   demultiplex MPEG-TS and packed audio, and may write fragmented MP4, in order to join the tracks
   of one stream into one file. Compressed sample data is copied **verbatim**: no decoding, no
   re-encoding, no transcoding, and — necessarily — no decryption. Everything in
   [§25.3](../../PROJECT_BIBLE.md#253-non-amendable-items) stands unchanged: encryption is still
   refused before a single segment is fetched, no key is read, and no decryption code exists.
4. **What is still refused is stated, not silently attempted.** A rendition whose codecs this build
   cannot read (AC-3, E-AC-3, HEVC, MP3 audio) is refused with the stream types named. A stream
   whose bytes are not what the playlist implies is refused as such.
5. **No new dependency.** The demuxer, the fragmented-MP4 writer and the muxer are written here,
   under the frozen tech stack ([§13.9](../../PROJECT_BIBLE.md#139-dependency-policy)).

## Consequences

- Most real-world split-track streams download as one file: fragmented MP4 (since 1.3.0) and now
  MPEG-TS and packed audio. A silent video is never saved in place of a joined one.
- A user can take a 720p copy of a 4K stream, from settings or per download.
- The trade: this project now owns three format implementations. They are validated against real
  media — `ffmpeg` produces it, `ffprobe` judges the result, and a committed fixture is downloaded
  end to end in a real browser — and against real packagers' manifests through the live
  conformance suite. Container work is unforgiving, and that evidence is the mitigation.
- Peak memory for a remuxed track is roughly twice the track's size while it is being taken apart,
  inside the existing 1 GiB assembly ceiling.
- Where two tracks come from separate renditions, each starts at its own first sample, so their
  relative start can differ by up to one frame; within a single transport stream the shared clock
  is preserved exactly. Stated rather than hidden ([§2.8](../../PROJECT_BIBLE.md#28-honesty-in-ui)).

## Alternatives considered

- **Leave MPEG-TS split-track refused.** Honest, and what 1.3.0 did, but it puts a large share of
  legacy HLS out of reach for a downloader whose purpose is downloading.
- **Add a library (mux.js, hls.js).** Rejected: a new runtime dependency is an Owner-approval
  matter under the frozen stack, it would enter the extension's shipped bundle, and the security
  gate's guarantees are stated over code in this repository.
- **Transcode with WebCodecs.** Rejected outright: re-encoding changes the media the user asked
  for, costs orders of magnitude more time and battery, and would put decode/encode surface inside
  a privacy-first extension for no benefit to the stated purpose.
- **Ask the user for a quality every time.** Rejected: a preference with a per-download override
  respects the common case (just download it) without hiding the choice.
