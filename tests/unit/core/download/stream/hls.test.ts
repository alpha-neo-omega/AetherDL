/**
 * HLS playlist parsing (PROJECT_BIBLE.md §10.6, §5.5, §6). The refusal cases matter
 * most: an encrypted playlist must never reach assembly, and key material must never
 * appear in the parser's output.
 */
import { describe, expect, it } from 'vitest';
import { HLS_MAX_SEGMENTS, HLS_MAX_TEXT_BYTES, parseHlsPlaylist } from '@core/download/stream/hls';

const BASE = 'https://cdn.test/hls/master.m3u8';

describe('HLS: master playlists', () => {
  it('lists every variant with its declared properties, resolved absolutely', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"',
      '360/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      '/abs/720/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
      'https://other.test/1080.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    expect([...result.variants]).toEqual([
      {
        url: 'https://cdn.test/hls/360/index.m3u8',
        bandwidth: 800000,
        width: 640,
        height: 360,
        codecs: 'avc1.42c01e,mp4a.40.2',
      },
      { url: 'https://cdn.test/abs/720/index.m3u8', bandwidth: 2400000, width: 1280, height: 720 },
      { url: 'https://other.test/1080.m3u8', bandwidth: 6000000, width: 1920, height: 1080 },
    ]);
  });
});

describe('HLS: separate audio renditions', () => {
  it('records an AUDIO group whose renditions have their own URI', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aac"',
      'video/720.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    // The variant carries video only; the caller refuses rather than saving silence.
    expect(result.separateAudioGroups).toEqual(['aac']);
    expect(result.variants[0]?.audioGroup).toBe('aac');
  });

  it('does not flag an AUDIO rendition that is muxed into the variants', () => {
    const text = [
      '#EXTM3U',
      // No URI: the audio is inside each variant already.
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac"',
      'v.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    expect(result.separateAudioGroups).toEqual([]);
  });

  it('does not flag a group whose default rendition has no URI, however many alternates do', () => {
    // Apple's own advanced example is shaped exactly like this: the default audio is
    // inside the variants, and a SECOND rendition of the same group offers an
    // alternative track. Reading that as "the variant has no audio" made assembly
    // download a video-only rendition and mux in the alternate track — a different
    // stream from the one the page plays. Found against real manifests (§16.9).
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="bipbop_audio",NAME="Audio 1",DEFAULT=YES',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="bipbop_audio",NAME="Audio 2",DEFAULT=NO,URI="alt/aac.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="bipbop_audio"',
      'v.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    expect(result.separateAudioGroups).toEqual([]);
    // The alternate rendition is still reported: it exists, and a caller may want to
    // know about it. What changed is that it no longer implies a split track.
    expect(result.audioRenditions.map((rendition) => rendition.name)).toEqual(['Audio 2']);
  });

  it('flags a group only when every rendition in it has its own URI', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="split",NAME="English",DEFAULT=YES,URI="a/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="split",NAME="German",DEFAULT=NO,URI="a/de.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="English",DEFAULT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="split"',
      'v.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    expect(result.separateAudioGroups).toEqual(['split']);
  });

  it('ignores subtitle and closed-caption renditions entirely', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"',
      'v.m3u8',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('master');
    if (result.kind !== 'master') {
      return;
    }
    expect(result.separateAudioGroups).toEqual([]);
  });
});

describe('HLS: media playlists', () => {
  it('reads a finished VOD playlist in order', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:9.009,',
      'seg-1.ts',
      '#EXTINF:9.009,title text',
      'seg-2.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    const result = parseHlsPlaylist(text, 'https://cdn.test/hls/720/index.m3u8');

    expect(result.kind).toBe('media');
    if (result.kind !== 'media') {
      return;
    }
    expect(result.live).toBe(false);
    expect(result.targetDurationSec).toBe(10);
    expect(result.segments).toEqual([
      { url: 'https://cdn.test/hls/720/seg-1.ts', durationSec: 9.009 },
      { url: 'https://cdn.test/hls/720/seg-2.ts', durationSec: 9.009 },
    ]);
  });

  it('carries an EXT-X-MAP initialisation segment', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4,',
      'seg-1.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('media');
    if (result.kind !== 'media') {
      return;
    }
    expect(result.initSegment).toEqual({ url: 'https://cdn.test/hls/init.mp4', durationSec: 0 });
  });

  it('continues a byte range from the previous segment when the offset is omitted', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:1000@0',
      'all.ts',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:2000',
      'all.ts',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:500',
      'all.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('media');
    if (result.kind !== 'media') {
      return;
    }
    // 0..999, then 1000..2999, then 3000..3499 — the spec's continuation rule.
    expect(result.segments.map((segment) => segment.range)).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 2000 },
      { offset: 3000, length: 500 },
    ]);
  });

  it('marks a playlist without ENDLIST as live', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'seg-9.ts'].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('media');
    if (result.kind !== 'media') {
      return;
    }
    // Reported, not refused: the caller decides that a moving target is not assemblable.
    expect(result.live).toBe(true);
  });

  it('tolerates CRLF, blank lines and unknown tags', () => {
    const text =
      '#EXTM3U\r\n#EXT-X-INDEPENDENT-SEGMENTS\r\n\r\n#EXT-X-SOMETHING-NEW:1\r\n#EXTINF:2,\r\nseg.ts\r\n#EXT-X-ENDLIST\r\n';

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('media');
    if (result.kind !== 'media') {
      return;
    }
    expect(result.segments).toHaveLength(1);
  });
});

describe('HLS: encryption is refused, and key material never surfaces', () => {
  const keyUri = 'https://keys.test/secret.key';

  it.each([
    ['AES-128', `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x0`],
    [
      'SAMPLE-AES',
      `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${keyUri}",KEYFORMAT="com.apple.streamingkeydelivery"`,
    ],
    ['an unknown method', `#EXT-X-KEY:METHOD=FUTURE-CIPHER,URI="${keyUri}"`],
    [
      'a session key',
      `#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="${keyUri}",KEYFORMAT="urn:uuid:edef8ba9"`,
    ],
  ])('refuses %s', (_label, keyLine) => {
    const text = ['#EXTM3U', keyLine, '#EXTINF:4,', 'seg-1.ts', '#EXT-X-ENDLIST'].join('\n');

    const result = parseHlsPlaylist(text, BASE);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') {
      return;
    }
    expect(result.code).toBe('hls-encrypted');
    // The whole result, serialised, must contain no key URI, host or file name.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('keys.test');
    expect(serialised).not.toContain('secret.key');
    expect(serialised).not.toContain('URI');
  });

  it('accepts an explicit METHOD=NONE', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:4,',
      'seg-1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    expect(parseHlsPlaylist(text, BASE).kind).toBe('media');
  });
});

describe('HLS: refusals and bounds', () => {
  it('accepts a playlist that opens with a blank line', () => {
    const result = parseHlsPlaylist('\n\n#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', BASE);

    expect(result.kind).toBe('media');
  });

  it('refuses input that is not a playlist', () => {
    expect(parseHlsPlaylist('<html>nope</html>', BASE)).toMatchObject({
      kind: 'refused',
      code: 'hls-not-a-playlist',
    });
  });

  it('refuses an unusable manifest URL', () => {
    expect(parseHlsPlaylist('#EXTM3U', 'not a url')).toMatchObject({
      kind: 'refused',
      code: 'hls-manifest-url-invalid',
    });
  });

  it('refuses a playlist with no segments at all', () => {
    expect(parseHlsPlaylist('#EXTM3U\n#EXT-X-ENDLIST', BASE)).toMatchObject({
      kind: 'refused',
      code: 'hls-empty',
    });
  });

  it('refuses text past the size ceiling', () => {
    const huge = `#EXTM3U\n${'#'.repeat(HLS_MAX_TEXT_BYTES + 1)}`;
    expect(parseHlsPlaylist(huge, BASE)).toMatchObject({ kind: 'refused', code: 'hls-too-large' });
  });

  it('refuses more segments than the ceiling allows', () => {
    const lines = ['#EXTM3U'];
    for (let index = 0; index <= HLS_MAX_SEGMENTS; index += 1) {
      lines.push('#EXTINF:1,', `seg-${String(index)}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');

    expect(parseHlsPlaylist(lines.join('\n'), BASE)).toMatchObject({
      kind: 'refused',
      code: 'hls-too-many',
    });
  });
});
