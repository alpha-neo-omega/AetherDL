/**
 * Test helper: mount React components on a real jsdom tree with `act`, plus small
 * DOM query/interaction helpers. Deliberately dependency-free — the project keeps a
 * minimal, vetted dependency set (PROJECT_BIBLE.md §13.9, ADR-002), so the popup is
 * exercised through the same DOM a user drives rather than through a test library's
 * abstraction. Not a test file.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  readonly container: HTMLElement;
  rerender(node: ReactNode): void;
  unmount(): void;
}

export function render(node: ReactNode): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    rerender(next: ReactNode): void {
      act(() => {
        root.render(next);
      });
    },
    unmount(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Flush pending promises and effects inside `act` so the tree settles. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** Render and settle asynchronous effects in one step. */
export async function renderAsync(node: ReactNode): Promise<Rendered> {
  const rendered = render(node);
  await flush();
  return rendered;
}

function all(container: HTMLElement, selector: string): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)];
}

/** Find a control by its accessible name (aria-label first, then text). */
export function byName(container: HTMLElement, name: string): HTMLElement | undefined {
  return all(container, 'button, input, select, a').find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() === name,
  );
}

/** Find a control whose accessible name starts with `prefix` (e.g. "Download: title"). */
export function byNamePrefix(container: HTMLElement, prefix: string): HTMLElement | undefined {
  return all(container, 'button, input, select, a').find((element) =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().startsWith(prefix),
  );
}

export function requireByName(container: HTMLElement, name: string): HTMLElement {
  const element = byName(container, name);
  if (element === undefined) {
    throw new Error(`No control named "${name}"`);
  }
  return element;
}

export function requireByNamePrefix(container: HTMLElement, prefix: string): HTMLElement {
  const element = byNamePrefix(container, prefix);
  if (element === undefined) {
    throw new Error(`No control whose name starts with "${prefix}"`);
  }
  return element;
}

export function texts(container: HTMLElement, selector: string): readonly string[] {
  return all(container, selector).map((element) => element.textContent?.trim() ?? '');
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Set a text input's value the way a user would, defeating React's value tracker. */
export function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function selectOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
