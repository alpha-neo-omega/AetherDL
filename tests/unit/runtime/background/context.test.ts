import { describe, expect, it } from 'vitest';
import {
  buildDetectionContext,
  isDetectionReport,
  MAX_SIGNALS,
  MAX_URLS,
} from '@runtime/background/context';
import type { WireDomSignal } from '@shared/types';
import { report } from '../_fixtures';

describe('isDetectionReport (top-level shape guard, §13.8)', () => {
  it('accepts a well-formed report', () => {
    expect(isDetectionReport({ pageUrl: 'x', domSignals: [], observedUrls: [] })).toBe(true);
  });

  it('rejects non-objects and reports missing required fields', () => {
    expect(isDetectionReport(null)).toBe(false);
    expect(isDetectionReport('nope')).toBe(false);
    expect(isDetectionReport(42)).toBe(false);
    expect(isDetectionReport({ pageUrl: 'x', domSignals: 'no', observedUrls: [] })).toBe(false);
    expect(isDetectionReport({ domSignals: [], observedUrls: [] })).toBe(false);
    expect(isDetectionReport({ pageUrl: 'x', domSignals: [] })).toBe(false);
  });
});

describe('detection context builder (trust boundary, §13.8)', () => {
  it('maps a valid report into a DetectionContext for the given tab', () => {
    const context = buildDetectionContext(
      report({
        pageUrl: 'https://x.com/watch',
        documentTitle: 'Title',
        frameId: 2,
        domSignals: [{ role: 'video', tagName: 'VIDEO', currentSrc: 'https://x.com/a.mp4' }],
        observedUrls: ['https://x.com/a.mp4'],
      }),
      7,
      'dom',
      1234,
    );
    expect(context).toMatchObject({
      tabId: 7,
      pageUrl: 'https://x.com/watch',
      documentTitle: 'Title',
      frameId: 2,
      source: 'dom',
      timestamp: 1234,
    });
    expect(context.domSignals).toHaveLength(1);
    expect(context.observedUrls).toEqual(['https://x.com/a.mp4']);
  });

  it('drops malformed signals and non-string URLs', () => {
    const domSignals: WireDomSignal[] = [
      { role: 'bogus', tagName: 'DIV' } as unknown as WireDomSignal,
      { role: 'video', tagName: 'VIDEO', src: 'https://x.com/a.mp4' },
    ];
    const observedUrls = ['https://x.com/a.mp4', 123 as unknown as string, ''];
    const context = buildDetectionContext(report({ domSignals, observedUrls }), 1, 'dom', 0);
    expect(context.domSignals).toHaveLength(1);
    expect(context.domSignals[0]?.role).toBe('video');
    expect(context.observedUrls).toEqual(['https://x.com/a.mp4']);
  });

  it('drops null/primitive array elements without throwing, keeping valid siblings', () => {
    const domSignals = [
      null,
      42,
      { role: 'video', tagName: 'VIDEO', src: 'https://x.com/a.mp4' },
    ] as unknown as WireDomSignal[];
    const context = buildDetectionContext(report({ domSignals }), 1, 'dom', 0);
    expect(context.domSignals).toHaveLength(1);
    expect(context.domSignals[0]?.role).toBe('video');
  });

  it('preserves Phase 4 flags (mediaSource / encrypted) when true', () => {
    const context = buildDetectionContext(
      report({
        domSignals: [{ role: 'video', tagName: 'VIDEO', mediaSource: true, encrypted: true }],
      }),
      1,
      'dom',
      0,
    );
    expect(context.domSignals[0]).toMatchObject({ mediaSource: true, encrypted: true });
  });

  it('maps all optional signal fields and a link href', () => {
    const context = buildDetectionContext(
      report({
        domSignals: [
          {
            role: 'source',
            tagName: 'SOURCE',
            src: 'https://x.com/a.webm',
            type: 'video/webm',
            width: 1920,
            height: 1080,
            durationSec: 12,
            parentRole: 'video',
            title: 'Clip',
            codecs: 'avc1.640028',
          },
          { role: 'link', tagName: 'A', href: 'https://x.com/a.mp4' },
        ],
      }),
      1,
      'manual',
      5,
    );
    expect(context.domSignals[0]).toMatchObject({
      type: 'video/webm',
      width: 1920,
      height: 1080,
      durationSec: 12,
      parentRole: 'video',
      title: 'Clip',
      codecs: 'avc1.640028',
    });
    expect(context.domSignals[1]).toMatchObject({ role: 'link', href: 'https://x.com/a.mp4' });
    expect(context.source).toBe('manual');
  });

  it('omits frameId/title when absent and tolerates an empty pageUrl', () => {
    const context = buildDetectionContext(report({ pageUrl: '' }), 1, 'dom', 0);
    expect(context).not.toHaveProperty('frameId');
    expect(context).not.toHaveProperty('documentTitle');
    expect(context.pageUrl).toBe('');
  });

  it('caps untrusted collections at the configured maxima', () => {
    const domSignals: WireDomSignal[] = Array.from({ length: MAX_SIGNALS + 50 }, () => ({
      role: 'video',
      tagName: 'VIDEO',
    }));
    const observedUrls = Array.from({ length: MAX_URLS + 50 }, (_v, i) => `https://x.com/${i}.mp4`);
    const context = buildDetectionContext(report({ domSignals, observedUrls }), 1, 'dom', 0);
    expect(context.domSignals).toHaveLength(MAX_SIGNALS);
    expect(context.observedUrls).toHaveLength(MAX_URLS);
  });
});
