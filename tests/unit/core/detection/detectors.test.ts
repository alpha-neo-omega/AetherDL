import { describe, expect, it } from 'vitest';
import { createBlobMediaDetector } from '@core/detection/detectors/blob-media';
import { createDirectUrlDetector } from '@core/detection/detectors/direct-url';
import { createHtml5AudioDetector } from '@core/detection/detectors/html5-audio';
import { createHtml5VideoDetector } from '@core/detection/detectors/html5-video';
import {
  createDashManifestDetector,
  createHlsManifestDetector,
} from '@core/detection/detectors/manifest';
import { createMediaSourceDetector } from '@core/detection/detectors/media-source';
import { createNetworkMediaDetector } from '@core/detection/detectors/network-media';
import { context, signal } from './_fixtures';

describe('html5-video detector', () => {
  const detector = createHtml5VideoDetector();

  it('exposes metadata', () => {
    expect(detector.id).toBe('html5-video');
    expect(detector.metadata?.()).toMatchObject({ id: 'html5-video', supportedKinds: ['video'] });
  });

  it('detects a <video> currentSrc and <source> children', async () => {
    const ctx = context({
      domSignals: [
        signal({
          role: 'video',
          currentSrc: 'https://x.com/a.mp4',
          width: 1920,
          height: 1080,
          durationSec: 12,
          codecs: 'avc1.640028',
        }),
        signal({
          role: 'source',
          parentRole: 'video',
          src: 'https://x.com/b.webm',
          type: 'video/webm',
        }),
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      url: 'https://x.com/a.mp4',
      kind: 'video',
      container: 'mp4',
      width: 1920,
      codec: 'avc1.640028',
    });
    expect(found[1]).toMatchObject({ url: 'https://x.com/b.webm', mimeType: 'video/webm' });
  });

  it('ignores blob sources (left to blob-media) and audio elements', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'video', currentSrc: 'blob:https://x.com/xyz' }),
        signal({ role: 'audio', src: 'https://x.com/a.mp3' }),
      ],
    });
    expect(await detector.detect(ctx)).toHaveLength(0);
  });

  it('falls back to src when currentSrc is an empty string', async () => {
    const ctx = context({
      domSignals: [signal({ role: 'video', currentSrc: '', src: 'https://x.com/a.mp4' })],
    });
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ url: 'https://x.com/a.mp4' });
  });

  it('does not detect when no video signals present', () => {
    expect(detector.canDetect(context())).toBe(false);
  });
});

describe('html5-audio detector', () => {
  const detector = createHtml5AudioDetector();

  it('detects <audio> and its <source> children', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'audio', currentSrc: 'https://x.com/a.mp3', durationSec: 200 }),
        signal({
          role: 'source',
          parentRole: 'audio',
          src: 'https://x.com/b.ogg',
          type: 'audio/ogg',
        }),
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ kind: 'audio', durationSec: 200 });
  });

  it('ignores blob and video sources', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'audio', src: 'blob:https://x.com/xyz' }),
        signal({ role: 'video', src: 'https://x.com/v.mp4' }),
      ],
    });
    expect(await detector.detect(ctx)).toHaveLength(0);
  });

  it('falls back to src when currentSrc is empty', async () => {
    const ctx = context({
      domSignals: [signal({ role: 'audio', currentSrc: '', src: 'https://x.com/a.mp3' })],
    });
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ url: 'https://x.com/a.mp3' });
  });
});

describe('direct-url detector', () => {
  const detector = createDirectUrlDetector();

  it('detects supported media links and observed URLs', async () => {
    const ctx = context({
      observedUrls: ['https://x.com/song.flac', 'https://x.com/page.html'],
      domSignals: [signal({ role: 'link', href: 'https://x.com/movie.mkv' })],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    const urls = found.map((c) => c.url).sort();
    expect(urls).toEqual(['https://x.com/movie.mkv', 'https://x.com/song.flac']);
    expect(found.every((c) => c.detectedBy === 'direct-url')).toBe(true);
  });

  it('rejects non-http(s) and unsupported extensions', async () => {
    const ctx = context({
      observedUrls: ['ftp://x.com/a.mp4', 'https://x.com/doc.pdf', 'blob:https://x.com/y'],
    });
    expect(await detector.detect(ctx)).toHaveLength(0);
  });
});

describe('blob-media detector', () => {
  const detector = createBlobMediaDetector();

  it('reports blob-backed video/audio without reconstruction', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'video', currentSrc: 'blob:https://x.com/v', width: 1280, height: 720 }),
        signal({ role: 'audio', src: 'blob:https://x.com/a', type: 'audio/mpeg' }),
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ url: 'blob:https://x.com/v', kind: 'video', isBlob: true });
    expect(found[1]).toMatchObject({ url: 'blob:https://x.com/a', kind: 'audio', isBlob: true });
  });

  it('ignores non-blob sources', async () => {
    const ctx = context({ domSignals: [signal({ role: 'video', src: 'https://x.com/a.mp4' })] });
    expect(detector.canDetect(ctx)).toBe(false);
    expect(await detector.detect(ctx)).toHaveLength(0);
  });

  it('handles blob-backed <source> children via parentRole (no orphaned blobs)', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'source', parentRole: 'video', src: 'blob:https://x.com/child' }),
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      url: 'blob:https://x.com/child',
      kind: 'video',
      isBlob: true,
    });
  });

  it('does not falsely claim detection for a blob source with no media parent', () => {
    const ctx = context({
      domSignals: [signal({ role: 'source', src: 'blob:https://x.com/orphan' })],
    });
    expect(detector.canDetect(ctx)).toBe(false);
  });
});

describe('network-media detector', () => {
  const detector = createNetworkMediaDetector();

  it('detects media from structured network observations', async () => {
    const ctx = context({
      networkResources: [
        { url: 'https://x.com/a.mp4', mimeType: 'video/mp4', sizeBytes: 5000 },
        { url: 'https://x.com/page.html', mimeType: 'text/html' },
        { url: 'https://x.com/list.m3u8', mimeType: 'application/vnd.apple.mpegurl' },
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      url: 'https://x.com/a.mp4',
      kind: 'video',
      delivery: 'progressive',
      sizeBytes: 5000,
      detectedBy: 'network-media',
    });
  });

  it('derives kind from extension when no MIME is present, and from MIME without extension', async () => {
    const ctx = context({
      networkResources: [
        { url: 'https://x.com/song.mp3' },
        { url: 'https://x.com/stream', mimeType: 'audio/mpeg' },
        { url: 'https://x.com/unknown' },
      ],
    });
    const found = await detector.detect(ctx);
    const urls = found.map((c) => c.url).sort();
    expect(urls).toEqual(['https://x.com/song.mp3', 'https://x.com/stream']);
    expect(found.every((c) => c.kind === 'audio')).toBe(true);
  });

  it('does not run without network observations', () => {
    expect(detector.canDetect(context())).toBe(false);
  });
});

describe('manifest detectors (recognition only)', () => {
  it('hls-manifest recognizes .m3u8 from links, network, and MIME', async () => {
    const detector = createHlsManifestDetector();
    const ctx = context({
      observedUrls: ['https://x.com/master.m3u8'],
      networkResources: [
        { url: 'https://x.com/api/stream', mimeType: 'application/vnd.apple.mpegurl' },
      ],
      domSignals: [signal({ role: 'link', href: 'https://x.com/other.mpd' })],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    const urls = found.map((c) => c.url).sort();
    expect(urls).toEqual(['https://x.com/api/stream', 'https://x.com/master.m3u8']);
    expect(found.every((c) => c.kind === 'stream' && c.delivery === 'hls')).toBe(true);
  });

  it('dash-manifest recognizes .mpd only', async () => {
    const detector = createDashManifestDetector();
    const ctx = context({ observedUrls: ['https://x.com/manifest.mpd', 'https://x.com/x.m3u8'] });
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      url: 'https://x.com/manifest.mpd',
      delivery: 'dash',
      kind: 'stream',
    });
  });

  it('deduplicates a manifest URL seen from multiple sources incl. media elements', async () => {
    const detector = createHlsManifestDetector();
    const ctx = context({
      observedUrls: ['https://x.com/dup.m3u8'],
      networkResources: [{ url: 'https://x.com/dup.m3u8' }],
      domSignals: [signal({ role: 'video', src: 'https://x.com/dup.m3u8' })],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(1);
  });
});

describe('media-source detector', () => {
  const detector = createMediaSourceDetector();

  it('reports MSE-backed media and flags EME as encrypted', async () => {
    const ctx = context({
      domSignals: [
        signal({ role: 'video', currentSrc: 'blob:https://x.com/mse', mediaSource: true }),
        signal({
          role: 'video',
          currentSrc: 'blob:https://x.com/drm',
          mediaSource: true,
          encrypted: true,
        }),
      ],
    });
    expect(detector.canDetect(ctx)).toBe(true);
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ delivery: 'media-source', isBlob: true });
    expect(found[1]).toMatchObject({ encrypted: true });
  });

  it('ignores media without MediaSource/EME', () => {
    const ctx = context({ domSignals: [signal({ role: 'video', src: 'https://x.com/a.mp4' })] });
    expect(detector.canDetect(ctx)).toBe(false);
  });

  it('handles MSE <source> children and non-blob EME sources', async () => {
    const ctx = context({
      domSignals: [
        signal({
          role: 'source',
          parentRole: 'audio',
          src: 'blob:https://x.com/s',
          mediaSource: true,
        }),
        signal({ role: 'video', src: 'https://x.com/live', encrypted: true }),
      ],
    });
    const found = await detector.detect(ctx);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ kind: 'audio', delivery: 'media-source', isBlob: true });
    // Non-blob EME source: encrypted, not a blob.
    expect(found[1]).toMatchObject({ kind: 'video', encrypted: true });
    expect(found[1]?.isBlob).toBeUndefined();
  });

  it('skips MediaSource signals that carry no URL', async () => {
    const ctx = context({ domSignals: [signal({ role: 'video', mediaSource: true })] });
    expect(await detector.detect(ctx)).toHaveLength(0);
  });

  it('skips MSE signals with no derivable kind or an empty URL', async () => {
    const ctx = context({
      domSignals: [
        signal({
          role: 'source',
          parentRole: 'link',
          src: 'blob:https://x.com/s',
          mediaSource: true,
        }),
        signal({ role: 'video', currentSrc: '', mediaSource: true }),
      ],
    });
    expect(await detector.detect(ctx)).toHaveLength(0);
  });
});

describe('detector metadata', () => {
  it('every built-in detector exposes consistent metadata', () => {
    const detectors = [
      createHtml5VideoDetector(),
      createHtml5AudioDetector(),
      createDirectUrlDetector(),
      createNetworkMediaDetector(),
      createHlsManifestDetector(),
      createDashManifestDetector(),
      createBlobMediaDetector(),
      createMediaSourceDetector(),
    ];
    for (const detector of detectors) {
      const meta = detector.metadata?.();
      expect(meta).toBeDefined();
      expect(meta?.id).toBe(detector.id);
      expect(meta?.priority).toBe(detector.priority);
      expect(meta?.enabled).toBe(true);
      expect(meta?.supportedKinds.length).toBeGreaterThan(0);
    }
  });
});
