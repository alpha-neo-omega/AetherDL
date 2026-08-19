// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMediaPreferences,
  DARK_SCHEME,
  LIGHT_SCHEME,
  ThemeProvider,
  type MediaPreferences,
} from '@ui/design-system';
import { render } from '../_render';

const DARK = '(prefers-color-scheme: dark)';
const REDUCED = '(prefers-reduced-motion: reduce)';

interface FakeMedia {
  readonly media: MediaPreferences;
  set(query: string, value: boolean): void;
  readonly subscriptions: number;
}

function createFakeMedia(initial: Readonly<Record<string, boolean>> = {}): FakeMedia {
  const values = new Map<string, boolean>(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  let subscriptions = 0;

  return {
    media: {
      matches: (query) => values.get(query) ?? false,
      subscribe: (query, listener) => {
        subscriptions += 1;
        const set = listeners.get(query) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(query, set);
        return () => {
          subscriptions -= 1;
          set.delete(listener);
        };
      },
    },
    set(query: string, value: boolean): void {
      values.set(query, value);
      act(() => {
        for (const listener of listeners.get(query) ?? []) {
          listener();
        }
      });
    },
    get subscriptions(): number {
      return subscriptions;
    },
  };
}

const root = (): HTMLElement => document.documentElement;

afterEach(() => {
  root().removeAttribute('style');
  delete root().dataset['theme'];
  delete root().dataset['reducedMotion'];
});

describe('ui/design-system ThemeProvider', () => {
  it('defaults to the system theme and resolves it to light', () => {
    const fake = createFakeMedia();
    const view = render(
      <ThemeProvider media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );

    expect(root().dataset['theme']).toBe('light');
    expect(root().style.getPropertyValue('--adl-color-surface')).toBe(LIGHT_SCHEME.surface);
    expect(root().style.getPropertyValue('color-scheme')).toBe('light');
    expect(view.container.textContent).toBe('content');
    view.unmount();
  });

  it('resolves the system theme to dark when the OS prefers dark', () => {
    const fake = createFakeMedia({ [DARK]: true });
    const view = render(
      <ThemeProvider media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );

    expect(root().dataset['theme']).toBe('dark');
    expect(root().style.getPropertyValue('--adl-color-surface')).toBe(DARK_SCHEME.surface);
    view.unmount();
  });

  it('follows a live change of the OS preference', () => {
    const fake = createFakeMedia();
    const view = render(
      <ThemeProvider media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(root().dataset['theme']).toBe('light');

    fake.set(DARK, true);
    expect(root().dataset['theme']).toBe('dark');
    expect(root().style.getPropertyValue('--adl-color-on-surface')).toBe(DARK_SCHEME.onSurface);

    fake.set(DARK, false);
    expect(root().dataset['theme']).toBe('light');
    view.unmount();
  });

  it('pins the scheme when the setting is explicit, ignoring the OS', () => {
    const fake = createFakeMedia({ [DARK]: true });
    const light = render(
      <ThemeProvider mode="light" media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(root().dataset['theme']).toBe('light');
    light.unmount();

    const dark = render(
      <ThemeProvider mode="dark" media={createFakeMedia().media}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(root().dataset['theme']).toBe('dark');
    dark.unmount();
  });

  it('publishes the reduced-motion preference', () => {
    const fake = createFakeMedia({ [REDUCED]: true });
    const view = render(
      <ThemeProvider media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(root().dataset['reducedMotion']).toBe('true');

    fake.set(REDUCED, false);
    expect(root().dataset['reducedMotion']).toBe('false');
    view.unmount();
  });

  it('releases every subscription and token on unmount', () => {
    const fake = createFakeMedia();
    const view = render(
      <ThemeProvider media={fake.media}>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(fake.subscriptions).toBeGreaterThan(0);

    view.unmount();

    expect(fake.subscriptions).toBe(0);
    expect(root().dataset['theme']).toBeUndefined();
    expect(root().dataset['reducedMotion']).toBeUndefined();
    expect(root().style.getPropertyValue('--adl-color-surface')).toBe('');
    expect(root().style.getPropertyValue('color-scheme')).toBe('');
  });

  it('reads and follows matchMedia when the engine provides it', () => {
    const listeners = new Set<() => void>();
    const list = {
      matches: true,
      addEventListener: (_event: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_event: string, listener: () => void) => {
        listeners.delete(listener);
      },
    };
    Object.defineProperty(globalThis, 'matchMedia', {
      value: () => list,
      configurable: true,
      writable: true,
    });
    try {
      const media = createMediaPreferences();
      expect(media.matches(DARK)).toBe(true);
      const unsubscribe = media.subscribe(DARK, () => undefined);
      expect(listeners.size).toBe(1);
      unsubscribe();
      expect(listeners.size).toBe(0);

      const view = render(
        <ThemeProvider>
          <p>content</p>
        </ThemeProvider>,
      );
      expect(root().dataset['theme']).toBe('dark');
      view.unmount();
    } finally {
      Reflect.deleteProperty(globalThis, 'matchMedia');
    }
  });

  it('subscribes to nothing when matchMedia returns a list without listeners', () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      value: () => ({ matches: false }),
      configurable: true,
      writable: true,
    });
    try {
      const media = createMediaPreferences();
      expect(() => {
        media.subscribe(DARK, () => undefined)();
      }).not.toThrow();
    } finally {
      Reflect.deleteProperty(globalThis, 'matchMedia');
    }
  });

  it('degrades to the light theme where matchMedia is unavailable', () => {
    // jsdom ships no matchMedia, so the default source is exercised as-is (§7.2).
    expect(typeof globalThis.matchMedia).not.toBe('function');
    const media = createMediaPreferences();
    expect(media.matches(DARK)).toBe(false);
    const unsubscribe = media.subscribe(DARK, () => undefined);
    expect(() => {
      unsubscribe();
    }).not.toThrow();

    const view = render(
      <ThemeProvider>
        <p>content</p>
      </ThemeProvider>,
    );
    expect(root().dataset['theme']).toBe('light');
    view.unmount();
  });
});
