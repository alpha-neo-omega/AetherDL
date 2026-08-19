import { describe, expect, it } from 'vitest';
import { MAX_DOM_SIGNALS, MAX_OBSERVED_URLS } from '@shared/constants';
import { scanDocument, type DocumentLike, type MediaElementLike } from '@runtime/content/scan';

type Attrs = Record<string, string>;

function element(
  tagName: string,
  attrs: Attrs = {},
  extra: Partial<MediaElementLike> & { parentTag?: string } = {},
): MediaElementLike {
  const { parentTag, ...media } = extra;
  return {
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
    ...(parentTag !== undefined && { parentElement: { tagName: parentTag } }),
    ...media,
  };
}

function doc(elements: readonly MediaElementLike[]): DocumentLike {
  return { querySelectorAll: () => elements };
}

describe('content scanner', () => {
  it('captures a video element with currentSrc and dimensions', () => {
    const result = scanDocument(
      doc([
        element(
          'VIDEO',
          { width: '1920', height: '1080' },
          {
            currentSrc: 'https://cdn.example.com/clip.mp4',
            duration: 42,
            videoWidth: 1920,
            videoHeight: 1080,
          },
        ),
      ]),
    );
    expect(result.domSignals).toHaveLength(1);
    const signal = result.domSignals[0]!;
    expect(signal.role).toBe('video');
    expect(signal.currentSrc).toBe('https://cdn.example.com/clip.mp4');
    expect(signal.width).toBe(1920);
    expect(signal.height).toBe(1080);
    expect(signal.durationSec).toBe(42);
    expect(result.observedUrls).toContain('https://cdn.example.com/clip.mp4');
  });

  it('flags MediaSource-backed (blob) and encrypted (EME) elements', () => {
    const result = scanDocument(
      doc([
        element('VIDEO', {}, { currentSrc: 'blob:https://example.com/abc' }),
        element('VIDEO', {}, { src: 'https://example.com/a.mp4', mediaKeys: {} }),
        element('VIDEO', {}, { srcObject: {}, src: 'https://example.com/b.mp4' }),
      ]),
    );
    expect(result.domSignals[0]?.mediaSource).toBe(true);
    expect(result.domSignals[1]?.encrypted).toBe(true);
    expect(result.domSignals[2]?.mediaSource).toBe(true);
  });

  it('records a <source> with its parent media role', () => {
    const result = scanDocument(
      doc([
        element(
          'SOURCE',
          { src: 'https://x.com/a.webm', type: 'video/webm' },
          { parentTag: 'VIDEO' },
        ),
      ]),
    );
    expect(result.domSignals[0]).toMatchObject({
      role: 'source',
      src: 'https://x.com/a.webm',
      type: 'video/webm',
      parentRole: 'video',
    });
  });

  it('keeps media links and drops non-media anchors', () => {
    const result = scanDocument(
      doc([
        element('A', { href: 'https://x.com/movie.mp4' }),
        element('A', { href: 'https://x.com/article' }),
      ]),
    );
    expect(result.domSignals).toHaveLength(1);
    expect(result.domSignals[0]).toMatchObject({ role: 'link', href: 'https://x.com/movie.mp4' });
    expect(result.observedUrls).toEqual(['https://x.com/movie.mp4']);
  });

  it('returns empty results for a page with no media', () => {
    const result = scanDocument(doc([]));
    expect(result.domSignals).toEqual([]);
    expect(result.observedUrls).toEqual([]);
  });

  it('ignores unknown tags, non-positive durations, and non-numeric dimensions', () => {
    const result = scanDocument(
      doc([
        element('DIV'),
        element('AUDIO', { width: 'abc' }, { src: 'https://x.com/a.mp3', duration: 0 }),
      ]),
    );
    expect(result.domSignals).toHaveLength(1);
    const signal = result.domSignals[0]!;
    expect(signal.role).toBe('audio');
    expect(signal.durationSec).toBeUndefined();
    expect(signal.width).toBeUndefined();
  });
});

describe('content scanner bounds (§9.10, §13.8)', () => {
  /** Videos that all share one URL: they fill the signal cap without filling URLs. */
  function sharedSrcVideos(count: number): MediaElementLike[] {
    return Array.from({ length: count }, () =>
      element('VIDEO', {}, { currentSrc: 'https://cdn.example.com/same.mp4' }),
    );
  }

  it('stops the walk once both caps are reached', () => {
    let visited = 0;
    const document: DocumentLike = {
      querySelectorAll: function* (): Generator<MediaElementLike> {
        for (let index = 0; index < MAX_DOM_SIGNALS * 2; index += 1) {
          visited += 1;
          yield element(
            'VIDEO',
            {},
            { currentSrc: `https://cdn.example.com/${String(index)}.mp4` },
          );
        }
      },
    };

    const result = scanDocument(document);

    expect(result.domSignals).toHaveLength(MAX_DOM_SIGNALS);
    expect(result.observedUrls).toHaveLength(MAX_OBSERVED_URLS);
    // The walk stops at the bound instead of visiting the whole page.
    expect(visited).toBeLessThanOrEqual(MAX_DOM_SIGNALS + 1);
  });

  it('keeps harvesting media URLs after the signal cap, from every role', () => {
    const result = scanDocument(
      doc([
        ...sharedSrcVideos(MAX_DOM_SIGNALS),
        element('VIDEO', {}, { currentSrc: 'https://cdn.example.com/late.mp4' }),
        element('AUDIO', { src: 'https://cdn.example.com/late.mp3' }),
        element('SOURCE', { src: 'https://cdn.example.com/late.webm' }),
        element('A', { href: 'https://cdn.example.com/late.mkv' }),
        element('A', { href: 'https://example.com/not-media' }),
        element('DIV'),
      ]),
    );

    expect(result.domSignals).toHaveLength(MAX_DOM_SIGNALS);
    expect(result.observedUrls).toContain('https://cdn.example.com/late.mp4');
    expect(result.observedUrls).toContain('https://cdn.example.com/late.mp3');
    expect(result.observedUrls).toContain('https://cdn.example.com/late.webm');
    expect(result.observedUrls).toContain('https://cdn.example.com/late.mkv');
    expect(result.observedUrls).not.toContain('https://example.com/not-media');
  });

  it('harvests a late video element that carries both currentSrc and src', () => {
    const result = scanDocument(
      doc([
        ...sharedSrcVideos(MAX_DOM_SIGNALS),
        element(
          'VIDEO',
          { src: 'https://cdn.example.com/attr.mp4' },
          { currentSrc: 'https://cdn.example.com/current.mp4' },
        ),
      ]),
    );

    expect(result.observedUrls).toContain('https://cdn.example.com/current.mp4');
    expect(result.observedUrls).toContain('https://cdn.example.com/attr.mp4');
  });

  it('never exceeds the observed-URL cap', () => {
    const elements = [
      ...sharedSrcVideos(MAX_DOM_SIGNALS),
      ...Array.from({ length: MAX_OBSERVED_URLS * 2 }, (_, index) =>
        element('SOURCE', { src: `https://cdn.example.com/extra-${String(index)}.mp4` }),
      ),
    ];

    const result = scanDocument(doc(elements));

    expect(result.domSignals).toHaveLength(MAX_DOM_SIGNALS);
    expect(result.observedUrls).toHaveLength(MAX_OBSERVED_URLS);
  });
});
