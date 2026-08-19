import { describe, expect, it, vi } from 'vitest';
import { createDeduplicator } from '@core/detection/dedupe/dedupe';
import { createMetadataExtractor } from '@core/detection/metadata/metadata';
import type { DetectionPipeline, RawCandidate } from '@core/detection/pipeline';
import { createDetectionPipeline } from '@core/detection/pipeline/pipeline';
import { createScorer } from '@core/detection/scoring/scoring';
import type { PlatformError } from '@shared/result/errors';
import { context } from './_fixtures';

function makePipeline(
  onReject?: (candidate: RawCandidate, error: PlatformError) => void,
): DetectionPipeline {
  return createDetectionPipeline({
    scorer: createScorer(),
    deduplicator: createDeduplicator(),
    metadataExtractor: createMetadataExtractor(),
    clock: () => 1000,
    ...(onReject !== undefined && { onReject }),
  });
}

describe('detection pipeline', () => {
  it('builds a normalized, scored MediaItem from a valid candidate', async () => {
    const pipeline = makePipeline();
    const items = await pipeline.run(context(), [
      {
        url: 'https://x.com/clip.mp4',
        kind: 'video',
        detectedBy: 'html5-video',
        width: 1920,
        height: 1080,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'video',
      status: 'supported',
      url: 'https://x.com/clip.mp4',
      container: 'mp4',
      extension: 'mp4',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
      originHost: 'x.com',
      discoveredAt: 1000,
    });
    expect(items[0]!.score).toBeGreaterThan(0);
  });

  it('rejects invalid candidates and surfaces them via onReject', async () => {
    const onReject = vi.fn();
    const pipeline = makePipeline(onReject);
    const items = await pipeline.run(context(), [
      { url: 'https://x.com/doc.pdf', kind: 'video', detectedBy: 'direct-url' },
    ]);
    expect(items).toHaveLength(0);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('enriches items with quality, delivery, codec, bitrate and classifies streams', async () => {
    const pipeline = makePipeline();
    const items = await pipeline.run(context(), [
      {
        url: 'https://x.com/v.mp4',
        kind: 'video',
        detectedBy: 'html5-video',
        width: 1920,
        height: 1080,
        codec: 'avc1.640028',
        bitrateKbps: 4500,
      },
      { url: 'https://x.com/s.m3u8', kind: 'stream', detectedBy: 'hls-manifest', delivery: 'hls' },
    ]);
    const byUrl = new Map(items.map((item) => [item.url, item]));
    expect(byUrl.get('https://x.com/v.mp4')).toMatchObject({
      quality: '1080p',
      delivery: 'html5',
      codec: 'avc1.640028',
      bitrateKbps: 4500,
      status: 'supported',
    });
    expect(byUrl.get('https://x.com/s.m3u8')).toMatchObject({
      delivery: 'hls',
      kind: 'stream',
      status: 'supported',
    });
  });

  it('classifies blob / media-source / encrypted media as unsupported (§5.4/§6)', async () => {
    const pipeline = makePipeline();
    const items = await pipeline.run(context(), [
      { url: 'blob:https://x.com/b', kind: 'video', detectedBy: 'blob-media', isBlob: true },
      {
        url: 'blob:https://x.com/drm',
        kind: 'video',
        detectedBy: 'media-source',
        delivery: 'media-source',
        isBlob: true,
        encrypted: true,
      },
    ]);
    expect(items.every((item) => item.status === 'unsupported')).toBe(true);
    const drm = items.find((item) => item.url.endsWith('drm'));
    expect(drm?.unsupportedReason).toMatch(/DRM|Encrypted/i);
  });

  it('classifies a non-blob, non-encrypted MediaSource item as unsupported (§5.4)', async () => {
    const pipeline = makePipeline();
    const items = await pipeline.run(context(), [
      {
        url: 'https://x.com/live.mp4',
        kind: 'video',
        detectedBy: 'media-source',
        delivery: 'media-source',
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('unsupported');
    expect(items[0]?.delivery).toBe('media-source');
  });

  it('deduplicates and sorts by score descending', async () => {
    const pipeline = makePipeline();
    const items = await pipeline.run(context(), [
      { url: 'https://x.com/a.mp3', kind: 'audio', detectedBy: 'html5-audio' },
      { url: 'https://x.com/a.mp3', kind: 'audio', detectedBy: 'direct-url' },
      {
        url: 'https://x.com/big.mp4',
        kind: 'video',
        detectedBy: 'html5-video',
        width: 3840,
        height: 2160,
      },
    ]);
    expect(items).toHaveLength(2);
    // The high-resolution video scores highest and sorts first.
    expect(items[0]).toMatchObject({ url: 'https://x.com/big.mp4' });
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1]!.score).toBeGreaterThanOrEqual(items[i]!.score);
    }
  });
});
