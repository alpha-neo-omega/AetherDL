/**
 * Integration: the fully-wired detection engine (createDetectionEngine) over a
 * synthetic DOM-signal context — exactly what the content script will feed it
 * (PROJECT_BIBLE.md §9, §16.2).
 */
import { describe, expect, it, vi } from 'vitest';
import { createDetectionEngine } from '@core/detection/factory';
import type { DetectionContext, DomSignal } from '@core/detection/pipeline';

function signal(props: { role: DomSignal['role'] } & Partial<Omit<DomSignal, 'role'>>): DomSignal {
  return { tagName: props.role.toUpperCase(), ...props };
}

function context(props: Partial<DetectionContext> = {}): DetectionContext {
  return {
    tabId: 1,
    pageUrl: 'https://example.com/watch',
    domSignals: [],
    observedUrls: [],
    source: 'dom',
    timestamp: 1000,
    ...props,
  };
}

describe('detection engine (integration)', () => {
  it('detects mixed media across all built-in detectors from one context', async () => {
    const engine = createDetectionEngine({ clock: () => 5000 });
    const ctx = context({
      documentTitle: 'Sample',
      domSignals: [
        signal({
          role: 'video',
          currentSrc: 'https://example.com/movie.mp4',
          width: 1920,
          height: 1080,
        }),
        signal({ role: 'audio', currentSrc: 'https://example.com/song.mp3', durationSec: 210 }),
        signal({ role: 'video', currentSrc: 'blob:https://example.com/live' }),
        signal({ role: 'link', href: 'https://example.com/extra.webm' }),
      ],
      observedUrls: ['https://example.com/direct.flac'],
    });

    const items = await engine.detect(ctx);
    const urls = items.map((item) => item.url).sort();
    expect(urls).toContain('https://example.com/movie.mp4');
    expect(urls).toContain('https://example.com/song.mp3');
    expect(urls).toContain('blob:https://example.com/live');
    expect(urls).toContain('https://example.com/extra.webm');
    expect(urls).toContain('https://example.com/direct.flac');

    // Every item is normalized, timestamped by the injected clock, and scored.
    // Blob-backed media is reported but marked unsupported (§5.4/§6.3); the rest
    // are supported.
    for (const item of items) {
      expect(item.discoveredAt).toBe(5000);
      expect(item.score).toBeGreaterThan(0);
      expect(item.originHost).toBe('example.com');
      if (item.url.startsWith('blob:')) {
        expect(item.status).toBe('unsupported');
        expect(item.unsupportedReason).toBeDefined();
      } else {
        expect(item.status).toBe('supported');
      }
    }
    // Sorted by score descending.
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1]!.score).toBeGreaterThanOrEqual(items[i]!.score);
    }
  });

  it('emits media:detected and serves a cache hit on repeat', async () => {
    const engine = createDetectionEngine({ clock: () => 1 });
    const detected = vi.fn();
    const cacheHit = vi.fn();
    engine.on('media:detected', detected);
    engine.on('cache:hit', cacheHit);

    const ctx = context({
      tabId: 3,
      domSignals: [signal({ role: 'video', currentSrc: 'https://example.com/a.mp4' })],
    });
    const first = await engine.detect(ctx);
    expect(first.length).toBeGreaterThan(0);
    expect(detected).toHaveBeenCalled();

    const second = await engine.detect(ctx);
    expect(second).toEqual(first);
    expect(cacheHit).toHaveBeenCalledWith({ tabId: 3 });

    await engine.dispose();
  });

  it('emits an error event when a detected candidate fails validation', async () => {
    const engine = createDetectionEngine({ clock: () => 1 });
    const errors = vi.fn();
    engine.on('error', errors);
    // A <video> whose src has no extension and no type yields an unclassifiable
    // candidate that the pipeline rejects (§13.5), surfaced as an error event.
    const items = await engine.detect(
      context({
        domSignals: [signal({ role: 'video', currentSrc: 'https://example.com/stream-no-ext' })],
      }),
    );
    expect(items).toHaveLength(0);
    expect(errors).toHaveBeenCalled();
    await engine.dispose();
  });

  it('works with default options (system clock and default bounds)', async () => {
    const engine = createDetectionEngine();
    const items = await engine.detect(
      context({ domSignals: [signal({ role: 'video', currentSrc: 'https://example.com/a.mp4' })] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.discoveredAt).toBeGreaterThan(0);
    await engine.dispose();
  });

  it('detects advanced sources (network, HLS/DASH, MediaSource) and emits Phase 4 events', async () => {
    const engine = createDetectionEngine({ clock: () => 9000 });
    const manifestDetected = vi.fn();
    const networkDetected = vi.fn();
    const mseDetected = vi.fn();
    const correlationComplete = vi.fn();
    engine.on('manifest:detected', manifestDetected);
    engine.on('network:media-detected', networkDetected);
    engine.on('mediasource:detected', mseDetected);
    engine.on('correlation:complete', correlationComplete);

    const items = await engine.detect(
      context({
        domSignals: [
          signal({ role: 'video', currentSrc: 'blob:https://example.com/mse', mediaSource: true }),
          signal({ role: 'link', href: 'https://example.com/master.m3u8' }),
        ],
        observedUrls: ['https://example.com/manifest.mpd'],
        networkResources: [
          { url: 'https://example.com/movie.mp4', mimeType: 'video/mp4', sizeBytes: 1000 },
        ],
      }),
    );

    const deliveries = items.map((item) => item.delivery);
    expect(deliveries).toContain('hls');
    expect(deliveries).toContain('dash');
    expect(deliveries).toContain('progressive');
    expect(deliveries).toContain('media-source');
    expect(manifestDetected).toHaveBeenCalledTimes(2);
    expect(networkDetected).toHaveBeenCalledTimes(1);
    expect(mseDetected).toHaveBeenCalledTimes(1);
    expect(correlationComplete).toHaveBeenCalled();

    const mse = items.find((item) => item.delivery === 'media-source');
    expect(mse?.status).toBe('unsupported');
    await engine.dispose();
  });

  it('correlates the same URL from multiple detectors, merging metadata + raising confidence', async () => {
    const engine = createDetectionEngine({ clock: () => 1 });
    const enriched = vi.fn();
    const correlationComplete = vi.fn();
    engine.on('metadata:enriched', enriched);
    engine.on('correlation:complete', correlationComplete);

    const items = await engine.detect(
      context({
        domSignals: [
          signal({
            role: 'video',
            currentSrc: 'https://example.com/a.mp4',
            width: 1920,
            height: 1080,
          }),
        ],
        networkResources: [
          { url: 'https://example.com/a.mp4', mimeType: 'video/mp4', sizeBytes: 9999 },
        ],
      }),
    );
    const matches = items.filter((item) => item.url === 'https://example.com/a.mp4');
    expect(matches).toHaveLength(1);
    const item = matches[0];
    // html5-video (priority base, dims) corroborated by network-media (size).
    expect(item?.detectedBy).toBe('html5-video');
    expect(item?.width).toBe(1920);
    expect(item?.sizeBytes).toBe(9999);
    expect(item?.metadata?.['corroboratedBy']).toBeDefined();

    expect(enriched).toHaveBeenCalledWith({ itemCount: items.length });
    expect(correlationComplete).toHaveBeenCalledWith({
      itemCount: items.length,
      corroboratedCount: 1,
    });
    await engine.dispose();
  });

  it('refuses an encrypted non-blob <video> even when a high-priority detector sees it (§6)', async () => {
    const engine = createDetectionEngine({ clock: () => 1 });
    const items = await engine.detect(
      context({
        domSignals: [
          signal({
            role: 'video',
            currentSrc: 'https://example.com/movie.mp4',
            width: 1920,
            height: 1080,
            encrypted: true,
          }),
        ],
      }),
    );
    const item = items.find((candidate) => candidate.url === 'https://example.com/movie.mp4');
    expect(item).toBeDefined();
    // html5-video (priority 90) sees it, media-source (45) flags EME; the merged
    // item must remain refused — DRM is never surfaced as supported (§6 / N16).
    expect(item?.status).toBe('unsupported');
    expect(item?.unsupportedReason).toMatch(/Encrypted|DRM/i);
    await engine.dispose();
  });
});
