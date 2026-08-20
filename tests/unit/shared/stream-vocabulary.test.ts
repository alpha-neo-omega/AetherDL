/**
 * The stream refusal vocabulary (PROJECT_BIBLE.md §20.2, §20.5).
 *
 * This mapping exists because a Chromium stream refusal crosses a message boundary
 * that carries only a code, and the client rebuilds the error from it. A code the
 * mapping does not know reaches the user as a generic failure — which is how the
 * MPEG-TS refusals first showed up in the browser, caught by the e2e. These tests
 * pin the classification per family so the next code added cannot drift silently.
 */
import { describe, expect, it } from 'vitest';
import {
  isProtectedStreamCode,
  isStreamErrorCode,
  streamMessageKeyFor,
  streamRetryableFor,
} from '@shared/result/stream';

describe('shared/result stream vocabulary', () => {
  it('recognises the codes that travel over the assembly boundary', () => {
    expect(isStreamErrorCode('stream-ts-not-a-stream')).toBe(true);
    expect(isStreamErrorCode('http-404')).toBe(true);
    expect(isStreamErrorCode('download-permission-denied')).toBe(false);
  });

  it('classifies encryption as protected media, never as a transport fault', () => {
    for (const code of ['stream-hls-encrypted', 'stream-dash-encrypted']) {
      expect(isProtectedStreamCode(code)).toBe(true);
      expect(streamMessageKeyFor(code)).toBe('error.drm');
      expect(streamRetryableFor(code)).toBe(false);
    }
  });

  it('describes a live stream as live and an oversized one as oversized', () => {
    expect(streamMessageKeyFor('stream-hls-live')).toBe('error.download.stream.live');
    expect(streamMessageKeyFor('stream-dash-dynamic')).toBe('error.download.stream.live');
    expect(streamMessageKeyFor('stream-too-large')).toBe('error.download.stream.tooLarge');
    expect(streamMessageKeyFor('stream-hls-too-many')).toBe('error.download.stream.tooLarge');
  });

  it('describes every track-level refusal as a track problem', () => {
    // Demux, remux and mux refusals are all "this stream's tracks cannot be joined",
    // which is a different sentence from "your network failed".
    for (const code of [
      'stream-hls-separate-audio',
      'stream-ts-not-a-stream',
      'stream-ts-no-tracks',
      'stream-ts-no-parameter-sets',
      'stream-ts-track-missing',
      'stream-mp4-no-samples',
      'stream-mux-empty',
      'stream-mux-no-moof',
    ]) {
      expect(streamMessageKeyFor(code), code).toBe('error.download.stream.tracks');
      expect(streamRetryableFor(code), code).toBe(false);
    }
  });

  it('describes a transfer failure as a network problem, and allows a retry', () => {
    for (const code of ['stream-manifest-fetch-failed', 'stream-segment-failed']) {
      expect(streamMessageKeyFor(code)).toBe('error.network');
      expect(streamRetryableFor(code)).toBe(true);
    }
    expect(streamMessageKeyFor('http-timeout')).toBe('error.network');
    expect(streamRetryableFor('http-timeout')).toBe(true);
    expect(streamRetryableFor('http-404')).toBe(false);
  });

  it('falls back to a stream failure for anything it has not been taught', () => {
    expect(streamMessageKeyFor('stream-something-new')).toBe('error.download.stream');
  });
});
