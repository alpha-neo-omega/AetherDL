import { describe, expect, it } from 'vitest';
import { createMessageResolver, formatMessage } from '@shared/utils';

describe('shared/utils message resolution', () => {
  it('returns a template untouched when no values are supplied', () => {
    expect(formatMessage('Hello')).toBe('Hello');
    expect(formatMessage('{count} items')).toBe('{count} items');
  });

  it('substitutes named placeholders, including repeats', () => {
    expect(formatMessage('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
    expect(formatMessage('{a}{a}', { a: 'x' })).toBe('xx');
  });

  it('leaves an unsupplied placeholder intact rather than printing "undefined"', () => {
    expect(formatMessage('{count} items', {})).toBe('{count} items');
    expect(formatMessage('{a} and {b}', { a: '1' })).toBe('1 and {b}');
  });

  it('resolves a key from its catalogue', () => {
    const t = createMessageResolver({ hello: 'Hello', count: '{n} items' });
    expect(t('hello')).toBe('Hello');
    expect(t('count', { n: '3' })).toBe('3 items');
  });

  it('falls back for a key the catalogue has not translated', () => {
    const english = { hello: 'Hello', bye: 'Bye' };
    const partial = { hello: 'Bonjour' } as Record<keyof typeof english, string>;
    const t = createMessageResolver(partial, english);
    expect(t('hello')).toBe('Bonjour');
    expect(t('bye')).toBe('Bye');
  });

  it('uses the catalogue as its own fallback by default', () => {
    const t = createMessageResolver({ hello: 'Hello' });
    expect(t('hello')).toBe('Hello');
  });
});
