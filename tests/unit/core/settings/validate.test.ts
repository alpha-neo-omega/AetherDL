import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import { coerceSettings, SETTING_LIMITS, validateSettingsPatch } from '@core/settings/validate';
import type { Settings } from '@shared/types';

function accept(patch: Partial<Settings>): Partial<Settings> {
  const result = validateSettingsPatch(patch);
  if (!result.ok) {
    throw new Error(`expected ${JSON.stringify(patch)} to be accepted: ${result.error.code}`);
  }
  return result.value;
}

function rejectCode(patch: unknown): string {
  const result = validateSettingsPatch(patch);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(patch)} to be rejected`);
  }
  return result.error.code;
}

describe('core/settings validation', () => {
  it('publishes the normative catalogue defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'system',
      maxConcurrentDownloads: 3,
      maxRetries: 3,
      filenameTemplate: '{title}.{ext}',
      downloadSubfolder: '',
      notifications: true,
      keepHistory: true,
      historyRetention: 'forever',
      duplicateWarnings: true,
      contextMenu: true,
      reducedMotion: 'system',
      language: 'system',
      detectionSensitivity: 'balanced',
    });
  });

  it('accepts every setting at its default', () => {
    expect(accept(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts each enumerated value', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      expect(accept({ theme })).toEqual({ theme });
    }
    for (const retention of ['forever', '30d', '90d', 'session'] as const) {
      expect(accept({ historyRetention: retention })).toEqual({ historyRetention: retention });
    }
    for (const motion of ['system', 'on', 'off'] as const) {
      expect(accept({ reducedMotion: motion })).toEqual({ reducedMotion: motion });
    }
    for (const sensitivity of ['conservative', 'balanced', 'aggressive'] as const) {
      expect(accept({ detectionSensitivity: sensitivity })).toEqual({
        detectionSensitivity: sensitivity,
      });
    }
  });

  it('rejects a value outside an enumeration', () => {
    expect(rejectCode({ theme: 'neon' })).toBe('settings-invalid-theme');
    expect(rejectCode({ historyRetention: 'always' })).toBe('settings-invalid-historyRetention');
    expect(rejectCode({ reducedMotion: 'maybe' })).toBe('settings-invalid-reducedMotion');
    expect(rejectCode({ detectionSensitivity: 'wild' })).toBe(
      'settings-invalid-detectionSensitivity',
    );
  });

  it('enforces the concurrency and retry ranges', () => {
    const { maxConcurrentDownloads, maxRetries } = SETTING_LIMITS;
    expect(accept({ maxConcurrentDownloads: maxConcurrentDownloads.min })).toBeTruthy();
    expect(accept({ maxConcurrentDownloads: maxConcurrentDownloads.max })).toBeTruthy();
    expect(rejectCode({ maxConcurrentDownloads: maxConcurrentDownloads.min - 1 })).toBe(
      'settings-invalid-maxConcurrentDownloads',
    );
    expect(rejectCode({ maxConcurrentDownloads: maxConcurrentDownloads.max + 1 })).toBe(
      'settings-invalid-maxConcurrentDownloads',
    );
    expect(rejectCode({ maxConcurrentDownloads: 2.5 })).toBe(
      'settings-invalid-maxConcurrentDownloads',
    );
    expect(accept({ maxRetries: maxRetries.min })).toBeTruthy();
    expect(rejectCode({ maxRetries: maxRetries.min - 1 })).toBe('settings-invalid-maxRetries');
    expect(rejectCode({ maxRetries: maxRetries.max + 1 })).toBe('settings-invalid-maxRetries');
  });

  it('requires a non-empty, bounded filename template', () => {
    expect(accept({ filenameTemplate: '{title}-{quality}.{ext}' })).toBeTruthy();
    expect(rejectCode({ filenameTemplate: '' })).toBe('settings-invalid-filenameTemplate');
    expect(rejectCode({ filenameTemplate: '   ' })).toBe('settings-invalid-filenameTemplate');
    expect(
      rejectCode({ filenameTemplate: 'x'.repeat(SETTING_LIMITS.filenameTemplateMaxLength + 1) }),
    ).toBe('settings-invalid-filenameTemplate');
  });

  it('refuses a subfolder that could escape the downloads directory', () => {
    expect(accept({ downloadSubfolder: '' })).toEqual({ downloadSubfolder: '' });
    expect(accept({ downloadSubfolder: 'clips/holiday' })).toBeTruthy();
    for (const escape of ['../secrets', 'a/../..', '/etc', 'C:/Windows', 'a\\..\\b', 'a:b']) {
      expect(rejectCode({ downloadSubfolder: escape }), escape).toBe(
        'settings-invalid-downloadSubfolder',
      );
    }
    expect(
      rejectCode({ downloadSubfolder: 'x'.repeat(SETTING_LIMITS.downloadSubfolderMaxLength + 1) }),
    ).toBe('settings-invalid-downloadSubfolder');
  });

  it('accepts system or a language tag, and nothing else', () => {
    for (const language of ['system', 'en', 'en-GB', 'pt-BR']) {
      expect(accept({ language }), language).toBeTruthy();
    }
    for (const bad of ['', 'e', 'not a locale', '123']) {
      expect(rejectCode({ language: bad }), bad).toBe('settings-invalid-language');
    }
  });

  it('requires booleans for the toggles', () => {
    for (const key of [
      'notifications',
      'keepHistory',
      'duplicateWarnings',
      'contextMenu',
    ] as const) {
      expect(accept({ [key]: false })).toEqual({ [key]: false });
      expect(rejectCode({ [key]: 'yes' })).toBe(`settings-invalid-${key}`);
    }
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    expect(rejectCode({ sendDiagnostics: true })).toBe('settings-unknown-key');
  });

  it('rejects a patch that is not an object', () => {
    for (const bad of [null, 'nope', 42, undefined]) {
      expect(rejectCode(bad)).toBe('settings-invalid-patch');
    }
  });

  it('ignores explicitly undefined members of a patch', () => {
    const patch = { theme: undefined, maxRetries: 1 } as unknown as Partial<Settings>;
    expect(accept(patch)).toEqual({ maxRetries: 1 });
  });

  it('rejects the whole patch when any value is invalid', () => {
    expect(rejectCode({ maxRetries: 1, theme: 'neon' })).toBe('settings-invalid-theme');
  });

  it('names the offending setting in the error context, without leaking the value', () => {
    const result = validateSettingsPatch({ maxRetries: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe('validation');
      expect(result.error.context).toMatchObject({ setting: 'maxRetries', received: 'number' });
      expect(JSON.stringify(result.error.context)).not.toContain('99');
    }
  });

  it('repairs a stored catalogue field by field', () => {
    expect(
      coerceSettings({
        theme: 'dark',
        maxRetries: 500,
        filenameTemplate: '',
        unknown: 'ignored',
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });

  it('answers with the defaults for anything unreadable', () => {
    for (const stored of [undefined, null, 'corrupt', 42, []]) {
      expect(coerceSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });
});
