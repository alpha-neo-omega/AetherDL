import { describe, expect, it } from 'vitest';
import {
  extensionToMime,
  filenameFromUrl,
  getExtension,
  isSupportedExtension,
  isSupportedMime,
  kindFromExtension,
  kindFromMime,
  manifestTypeFromExtension,
  manifestTypeFromMime,
  manifestTypeFromUrl,
} from '@shared/utils';

describe('shared/utils media helpers', () => {
  it('extracts extensions, ignoring query and fragment', () => {
    expect(getExtension('https://x.com/a/video.mp4?t=1#frag')).toBe('mp4');
    expect(getExtension('https://x.com/AUDIO.MP3')).toBe('mp3');
    expect(getExtension('https://x.com/path/')).toBeUndefined();
    expect(getExtension('https://x.com/noext')).toBeUndefined();
    expect(getExtension('https://x.com/.hidden')).toBeUndefined();
  });

  it('recognizes supported extensions and their MIME (§5.1)', () => {
    expect(isSupportedExtension('mp4')).toBe(true);
    expect(isSupportedExtension('MKV')).toBe(true);
    expect(isSupportedExtension('exe')).toBe(false);
    expect(extensionToMime('mp3')).toBe('audio/mpeg');
    expect(extensionToMime('webm')).toBe('video/webm');
    expect(extensionToMime('xyz')).toBeUndefined();
  });

  it('classifies MIME support via a closed allowlist (rejects streams, §5.1/§6)', () => {
    expect(isSupportedMime('video/mp4')).toBe(true);
    expect(isSupportedMime('audio/mpeg; codecs="mp3"')).toBe(true);
    expect(isSupportedMime('audio/x-m4a')).toBe(true);
    expect(isSupportedMime('audio/x-wav')).toBe(true);
    // Streaming / unsupported types must NOT slip through a prefix check.
    expect(isSupportedMime('application/vnd.apple.mpegurl')).toBe(false);
    expect(isSupportedMime('audio/x-mpegurl')).toBe(false);
    expect(isSupportedMime('video/mp2t')).toBe(false);
    expect(isSupportedMime('video/x-flv')).toBe(false);
    expect(isSupportedMime('video/3gpp')).toBe(false);
    expect(isSupportedMime('')).toBe(false);
    expect(kindFromMime('video/webm')).toBe('video');
    expect(kindFromMime('audio/ogg')).toBe('audio');
    expect(kindFromMime('text/html')).toBeUndefined();
  });

  it('derives kind from extension', () => {
    expect(kindFromExtension('mp4')).toBe('video');
    expect(kindFromExtension('flac')).toBe('audio');
    expect(kindFromExtension('txt')).toBeUndefined();
  });

  it('extracts a decoded filename, tolerating malformed encoding', () => {
    expect(filenameFromUrl('https://x.com/a/My%20Clip.mp4')).toBe('My Clip.mp4');
    expect(filenameFromUrl('https://x.com/')).toBeUndefined();
    // Malformed percent-encoding must not throw; the raw segment is returned.
    expect(filenameFromUrl('https://x.com/bad%E0%A4.mp4')).toBe('bad%E0%A4.mp4');
  });

  it('recognizes HLS/DASH manifests by extension and MIME (§5.5)', () => {
    expect(manifestTypeFromUrl('https://x.com/master.m3u8?token=1')).toBe('hls');
    expect(manifestTypeFromUrl('https://x.com/manifest.mpd')).toBe('dash');
    expect(manifestTypeFromUrl('https://x.com/video.mp4')).toBeUndefined();
    expect(manifestTypeFromMime('application/vnd.apple.mpegurl')).toBe('hls');
    expect(manifestTypeFromMime('audio/x-mpegurl')).toBe('hls');
    expect(manifestTypeFromMime('application/dash+xml')).toBe('dash');
    expect(manifestTypeFromMime('video/mp4')).toBeUndefined();
    expect(manifestTypeFromExtension('m3u8')).toBe('hls');
    expect(manifestTypeFromExtension('m3u')).toBe('hls');
    expect(manifestTypeFromExtension('MPD')).toBe('dash');
    expect(manifestTypeFromExtension('mp4')).toBeUndefined();
  });
});
