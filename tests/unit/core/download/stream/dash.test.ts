/**
 * DASH manifest parsing (PROJECT_BIBLE.md §10.6, §5.5, §6). The parser must work
 * without `DOMParser` (absent in a Chromium MV3 service worker), must refuse any
 * protected manifest before interpreting it, and must never surface key material.
 */
import { describe, expect, it } from 'vitest';
import {
  DASH_MAX_SEGMENTS,
  DASH_MAX_TEXT_BYTES,
  parseDashManifest,
} from '@core/download/stream/dash';

const BASE = 'https://cdn.test/dash/manifest.mpd';

function mpd(body: string, attributes = 'type="static" mediaPresentationDuration="PT30S"'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attributes}>${body}</MPD>`;
}

describe('DASH: SegmentTemplate with a fixed duration', () => {
  it('derives the segment count from the period duration', () => {
    const result = parseDashManifest(
      mpd(`
        <Period duration="PT30S">
          <AdaptationSet mimeType="video/mp4">
            <SegmentTemplate initialization="init-$RepresentationID$.m4s"
                             media="seg-$RepresentationID$-$Number%05d$.m4s"
                             timescale="1000" duration="10000" startNumber="1"/>
            <Representation id="v0" bandwidth="1200000" width="1280" height="720" codecs="avc1.640028"/>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result.kind).toBe('static');
    if (result.kind !== 'static') {
      return;
    }
    const [representation] = result.representations;
    expect(representation).toMatchObject({
      id: 'v0',
      bandwidth: 1200000,
      width: 1280,
      height: 720,
      codecs: 'avc1.640028',
      mimeType: 'video/mp4',
      initSegment: { url: 'https://cdn.test/dash/init-v0.m4s' },
    });
    // 30 s at 10 s per segment.
    expect(representation?.segments).toEqual([
      { url: 'https://cdn.test/dash/seg-v0-00001.m4s' },
      { url: 'https://cdn.test/dash/seg-v0-00002.m4s' },
      { url: 'https://cdn.test/dash/seg-v0-00003.m4s' },
    ]);
  });

  it('picks the highest-bandwidth representation as the default', () => {
    const result = parseDashManifest(
      mpd(`
        <Period duration="PT10S">
          <AdaptationSet mimeType="video/mp4">
            <SegmentTemplate media="$RepresentationID$-$Number$.m4s" duration="10" timescale="1"/>
            <Representation id="low" bandwidth="300000" width="640" height="360"/>
            <Representation id="high" bandwidth="4500000" width="1920" height="1080"/>
            <Representation id="mid" bandwidth="1500000" width="1280" height="720"/>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result.kind).toBe('static');
    if (result.kind !== 'static') {
      return;
    }
    expect(result.representations).toHaveLength(3);
    expect(result.representations[result.defaultIndex]?.id).toBe('high');
  });
});

describe('DASH: SegmentTimeline', () => {
  it('expands @r repeats and advances $Time$', () => {
    const result = parseDashManifest(
      mpd(`
        <Period>
          <AdaptationSet mimeType="video/mp4">
            <Representation id="v" bandwidth="1000">
              <SegmentTemplate media="s-$Time$.m4s" timescale="90000">
                <SegmentTimeline>
                  <S t="0" d="180000" r="2"/>
                  <S d="90000"/>
                </SegmentTimeline>
              </SegmentTemplate>
            </Representation>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result.kind).toBe('static');
    if (result.kind !== 'static') {
      return;
    }
    expect(result.representations[0]?.segments.map((segment) => segment.url)).toEqual([
      'https://cdn.test/dash/s-0.m4s',
      'https://cdn.test/dash/s-180000.m4s',
      'https://cdn.test/dash/s-360000.m4s',
      'https://cdn.test/dash/s-540000.m4s',
    ]);
  });
});

describe('DASH: SegmentList and byte ranges', () => {
  it('takes the stated URLs and their media ranges', () => {
    const result = parseDashManifest(
      mpd(`
        <Period>
          <AdaptationSet mimeType="video/mp4">
            <Representation id="v" bandwidth="1000">
              <SegmentList duration="4">
                <Initialization sourceURL="init.mp4" range="0-799"/>
                <SegmentURL media="chunk.mp4" mediaRange="800-1799"/>
                <SegmentURL media="chunk.mp4" mediaRange="1800-2799"/>
              </SegmentList>
            </Representation>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result.kind).toBe('static');
    if (result.kind !== 'static') {
      return;
    }
    expect(result.representations[0]?.initSegment).toEqual({
      url: 'https://cdn.test/dash/init.mp4',
      range: { offset: 0, length: 800 },
    });
    expect(result.representations[0]?.segments).toEqual([
      { url: 'https://cdn.test/dash/chunk.mp4', range: { offset: 800, length: 1000 } },
      { url: 'https://cdn.test/dash/chunk.mp4', range: { offset: 1800, length: 1000 } },
    ]);
  });
});

describe('DASH: BaseURL resolution', () => {
  it('resolves segment URLs against a nested BaseURL', () => {
    const result = parseDashManifest(
      mpd(`
        <BaseURL>https://media.test/v1/</BaseURL>
        <Period duration="PT4S">
          <AdaptationSet mimeType="video/mp4">
            <SegmentTemplate media="720/$Number$.m4s" duration="4" timescale="1"/>
            <Representation id="v" bandwidth="1000"/>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result.kind).toBe('static');
    if (result.kind !== 'static') {
      return;
    }
    expect(result.representations[0]?.segments[0]?.url).toBe('https://media.test/v1/720/1.m4s');
  });
});

describe('DASH: protection is refused, and key material never surfaces', () => {
  const protectedBodies = [
    [
      'Widevine ContentProtection',
      `<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
          value="cenc"><cenc:pssh>AAAAW3Bzc2gAAAAA-SECRET-PAYLOAD</cenc:pssh></ContentProtection>`,
    ],
    [
      'a cenc mp4protection scheme',
      `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
          cenc:default_KID="1234abcd-0000-0000-0000-00000000dead"/>`,
    ],
    ['a bare pssh box', `<pssh>AAAAW3Bzc2gAAAAA-SECRET-PAYLOAD</pssh>`],
  ] as const;

  it.each(protectedBodies)('refuses %s', (_label, protection) => {
    const result = parseDashManifest(
      mpd(`
        <Period duration="PT10S">
          <AdaptationSet mimeType="video/mp4">
            ${protection}
            <SegmentTemplate media="$Number$.m4s" duration="10" timescale="1"/>
            <Representation id="v" bandwidth="1000"/>
          </AdaptationSet>
        </Period>`),
      BASE,
    );

    expect(result).toMatchObject({ kind: 'refused', code: 'dash-encrypted' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('SECRET-PAYLOAD');
    expect(serialised).not.toContain('default_KID');
    expect(serialised).not.toContain('dead');
  });
});

describe('DASH: refusals and bounds', () => {
  it('reports a dynamic (live) manifest rather than assembling it', () => {
    const result = parseDashManifest(
      mpd(
        `<Period><AdaptationSet mimeType="video/mp4">
           <SegmentTemplate media="$Number$.m4s" duration="4" timescale="1"/>
           <Representation id="v" bandwidth="1"/>
         </AdaptationSet></Period>`,
        'type="dynamic"',
      ),
      BASE,
    );

    expect(result.kind).toBe('dynamic');
  });

  it('refuses input that is not a manifest', () => {
    expect(parseDashManifest('#EXTM3U\n#EXT-X-ENDLIST', BASE)).toMatchObject({
      kind: 'refused',
      code: 'dash-not-a-manifest',
    });
  });

  it('refuses an unusable manifest URL', () => {
    expect(parseDashManifest(mpd('<Period/>'), 'not a url')).toMatchObject({
      kind: 'refused',
      code: 'dash-manifest-url-invalid',
    });
  });

  it('refuses text past the size ceiling', () => {
    const huge = `<MPD >${' '.repeat(DASH_MAX_TEXT_BYTES + 1)}</MPD>`;
    expect(parseDashManifest(huge, BASE)).toMatchObject({
      kind: 'refused',
      code: 'dash-too-large',
    });
  });

  it('refuses a manifest whose representations cannot be read', () => {
    // No SegmentTemplate, no SegmentList: nothing to fetch.
    expect(
      parseDashManifest(
        mpd(
          '<Period duration="PT10S"><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"/></AdaptationSet></Period>',
        ),
        BASE,
      ),
    ).toMatchObject({ kind: 'refused', code: 'dash-unreadable' });
  });

  it('drops a representation that would exceed the segment ceiling', () => {
    const seconds = (DASH_MAX_SEGMENTS + 10) * 2;
    const result = parseDashManifest(
      mpd(
        `<Period duration="PT${String(seconds)}S"><AdaptationSet mimeType="video/mp4">
           <SegmentTemplate media="$Number$.m4s" duration="2" timescale="1"/>
           <Representation id="v" bandwidth="1"/>
         </AdaptationSet></Period>`,
      ),
      BASE,
    );

    expect(result).toMatchObject({ kind: 'refused', code: 'dash-unreadable' });
  });
});
