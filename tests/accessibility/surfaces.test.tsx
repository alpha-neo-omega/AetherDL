// @vitest-environment jsdom
/**
 * Accessibility: automated WCAG checks over every shipped surface
 * (PROJECT_BIBLE.md §16.6, §17).
 *
 * axe-core (ADR-009) runs the WCAG 2.0/2.1 A + AA rule sets against the real
 * rendered popup, settings and history trees — the same DOM a user's assistive
 * technology reads. Rules that need layout geometry cannot run under jsdom and stay
 * covered by the manual matrix (§16.7); the token-level contrast guarantees are
 * asserted separately in tests/unit/ui/design-system/tokens.test.ts (§17.4).
 */
import { run as runAxe, type AxeResults, type ElementContext, type RunOptions } from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { MediaPreferences } from '@ui/design-system';
import { PopupApp } from '@ui/popup';
import { SettingsApp } from '@ui/settings';
import type { MediaItem } from '@shared/types';
import { createFakeRuntimeClient, downloadTask, mediaItem } from '../unit/ui/_fixtures';
import { createFakeSettingsClient, historyRecord } from '../unit/ui/settings/_fixtures';
import { flush, render, type as typeInto } from '../unit/ui/_render';

const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

/** The standard the project commits to (§17.1): WCAG 2.1 level AA. */
const WCAG_AA: RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  // jsdom has neither layout geometry nor a canvas, so the two rules that need them
  // cannot be evaluated here. Contrast is asserted directly against the design
  // tokens (tests/unit/ui/design-system/tokens.test.ts, §17.4) and both are re-checked
  // by hand in the manual matrix (§16.7).
  rules: { 'target-size': { enabled: false }, 'color-contrast': { enabled: false } },
};

async function audit(container: HTMLElement): Promise<AxeResults> {
  return runAxe(container as ElementContext, WCAG_AA);
}

/** Readable failure text: rule id, impact, and the offending node. */
function describeViolations(results: AxeResults): string {
  return results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.html}`).join('\n'),
    )
    .join('\n');
}

async function expectNoViolations(container: HTMLElement): Promise<void> {
  const results = await audit(container);
  expect(describeViolations(results)).toBe('');
}

describe('accessibility: popup surface (§16.6, §17)', () => {
  it('has no WCAG A/AA violations with detected media and a live queue', async () => {
    const fake = createFakeRuntimeClient();
    const items: readonly MediaItem[] = [
      mediaItem({ id: 'a', title: 'Holiday Clip' }),
      mediaItem({ id: 'b', title: 'Podcast Episode', kind: 'audio' }),
      mediaItem({ id: 'c', title: 'Protected Stream', status: 'unsupported' }),
    ];
    fake.setItems(items);
    fake.setTasks([
      downloadTask({ id: 'job-1', item: items[0] as MediaItem, state: 'active' }),
      downloadTask({ id: 'job-2', item: items[1] as MediaItem, state: 'failed' }),
    ]);

    const view = render(<PopupApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />);
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });

  it('has no violations in its empty state', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([]);
    fake.setTasks([]);

    const view = render(<PopupApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />);
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });

  it('has no violations in its error state', async () => {
    const fake = createFakeRuntimeClient();
    fake.failNext('queryDetection', new Error('background unavailable'));

    const view = render(<PopupApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />);
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });
});

describe('accessibility: settings surface (§16.6, §17)', () => {
  it('has no WCAG A/AA violations across the settings catalogue', async () => {
    const fake = createFakeSettingsClient();

    const view = render(
      <SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />,
    );
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });

  it('has no violations while a validation error is shown', async () => {
    const fake = createFakeSettingsClient();
    const view = render(
      <SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />,
    );
    await flush();

    const label = [...view.container.querySelectorAll('label')].find(
      (candidate) => candidate.textContent?.trim() === 'Filename template',
    );
    const field = view.container.querySelector<HTMLInputElement>(`#${label?.htmlFor ?? ''}`);
    expect(field).not.toBeNull();
    typeInto(field as HTMLInputElement, '');
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });
});

describe('accessibility: history surface (§16.6, §17)', () => {
  it('has no WCAG A/AA violations with records listed', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [
      historyRecord({ id: 'h1' }),
      historyRecord({ id: 'h2', outcome: 'failed', kind: 'audio' }),
    ];

    const view = render(
      <SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />,
    );
    await flush();

    await expectNoViolations(view.container);
    view.unmount();
  });
});
