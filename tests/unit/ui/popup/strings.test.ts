import { describe, expect, it } from 'vitest';
import { createTranslator, EN_MESSAGES, type MessageKey } from '@ui/popup';

describe('ui/popup message catalogue', () => {
  it('resolves a key from the default English catalogue', () => {
    const t = createTranslator();
    expect(t('popup.brand')).toBe('AetherDL');
    expect(t('card.download')).toBe('Download');
  });

  it('substitutes named placeholders', () => {
    const t = createTranslator();
    expect(t('popup.count.other', { count: '3' })).toBe('3 items');
    expect(t('queue.summary', { active: '1', queued: '2' })).toBe('1 active · 2 queued');
  });

  it('leaves an unsupplied placeholder untouched rather than printing "undefined"', () => {
    const t = createTranslator();
    expect(t('popup.count.other', {})).toBe('{count} items');
  });

  it('falls back to English for a key a catalogue has not translated', () => {
    const partial = { ...EN_MESSAGES, 'popup.brand': 'AetherDL (fr)' } as Record<
      MessageKey,
      string
    >;
    delete (partial as Record<string, string>)['card.download'];
    const t = createTranslator(partial);
    expect(t('popup.brand')).toBe('AetherDL (fr)');
    expect(t('card.download')).toBe('Download');
  });

  it('has no empty message in the catalogue', () => {
    for (const [key, value] of Object.entries(EN_MESSAGES)) {
      expect(value.length, `"${key}" is empty`).toBeGreaterThan(0);
    }
  });
});
