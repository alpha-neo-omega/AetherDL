// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import type { MediaItem } from '@shared/types';
import { MessagingError, PermissionError } from '@shared/result/errors';
import { PopupApp, useRuntimeClient } from '@ui/popup';
import type { MediaPreferences } from '@ui/design-system';
import {
  createFakeRuntimeClient,
  downloadTask,
  mediaItem,
  type FakeRuntimeClient,
} from '../_fixtures';
import {
  byName,
  click,
  flush,
  render,
  renderAsync,
  requireByName,
  requireByNamePrefix,
  selectOption,
  texts,
  type Rendered,
} from '../_render';

const NEVER_MATCHES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

const ALWAYS_DARK: MediaPreferences = {
  matches: (query) => query.includes('dark'),
  subscribe: () => () => undefined,
};

async function mount(
  fake: FakeRuntimeClient,
  media: MediaPreferences = NEVER_MATCHES,
): Promise<Rendered> {
  return renderAsync(<PopupApp client={fake.client} media={media} locale="en-US" />);
}

afterEach(() => {
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['reducedMotion'];
});

function cards(view: Rendered): readonly string[] {
  return texts(view.container, '.adl-card__title');
}

/** A component that consumes the port without the provider above it. */
function Consumer(): ReactNode {
  useRuntimeClient();
  return null;
}

describe('ui/popup PopupApp — states', () => {
  it('shows the loading state until the runtime answers', async () => {
    const fake = createFakeRuntimeClient();
    // First paint, before the runtime promises settle.
    const view = render(<PopupApp client={fake.client} media={NEVER_MATCHES} />);
    const loading = view.container.querySelector('.adl-status--loading');
    expect(loading?.textContent).toContain('Looking for media');
    expect(loading?.getAttribute('aria-busy')).toBe('true');
    expect(loading?.querySelector('[role="progressbar"]')).not.toBeNull();

    await flush();

    expect(view.container.querySelector('.adl-status--loading')).toBeNull();
    view.unmount();
  });

  it('renders the empty state when the tab has no detected media', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);
    const status = view.container.querySelector('.adl-status--empty');
    expect(status?.textContent).toContain('No media detected');
    expect(status?.textContent).toContain('Play or open media');
    expect(status?.getAttribute('role')).toBe('status');
    view.unmount();
  });

  it('renders the empty state when there is no active tab, without querying detection', async () => {
    const fake = createFakeRuntimeClient();
    fake.setTabId(undefined);
    const view = await mount(fake);
    expect(fake.calls).not.toContain('queryDetection:7');
    expect(view.container.querySelector('.adl-status--empty')).not.toBeNull();
    view.unmount();
  });

  it('renders one card per detected item with a live count', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([
      mediaItem({ id: 'a', title: 'First' }),
      mediaItem({ id: 'b', title: 'Second' }),
    ]);
    const view = await mount(fake);

    expect(cards(view)).toEqual(['First', 'Second']);
    expect(view.container.querySelector('.adl-toolbar__count')?.textContent).toBe('2 items');
    expect(view.container.querySelector('.adl-list')?.getAttribute('aria-label')).toBe(
      'Detected media',
    );
    view.unmount();
  });

  it('uses the singular count for one item', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a' })]);
    const view = await mount(fake);
    expect(view.container.querySelector('.adl-toolbar__count')?.textContent).toBe('1 item');
    view.unmount();
  });

  it('shows the runtime-unavailable state and recovers on retry', async () => {
    const fake = createFakeRuntimeClient();
    fake.failNext(
      'getActiveTabId',
      new MessagingError('no receiver', {
        code: 'messaging-no-response',
        messageKey: 'error.messaging.noResponse',
      }),
    );
    const view = await mount(fake);

    const status = view.container.querySelector('.adl-status--error');
    expect(status?.textContent).toContain('AetherDL is not responding');
    expect(status?.textContent).not.toContain('messaging-no-response');

    fake.setItems([mediaItem({ id: 'a', title: 'Back' })]);
    click(requireByName(view.container, 'Retry'));
    await flush();

    expect(cards(view)).toEqual(['Back']);
    view.unmount();
  });
});

describe('ui/popup PopupApp — search, filter and sort', () => {
  const items: readonly MediaItem[] = [
    mediaItem({ id: 'v', title: 'Beach Video', kind: 'video', score: 5, sizeBytes: 100 }),
    mediaItem({ id: 'a', title: 'Album Track', kind: 'audio', score: 9, sizeBytes: 10 }),
  ];

  it('filters by search text across title and metadata', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems(items);
    const view = await mount(fake);

    const search = view.container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(search.getAttribute('placeholder')).toBe('Search');
    const { type } = await import('../_render');
    type(search, 'beach');

    expect(cards(view)).toEqual(['Beach Video']);
    view.unmount();
  });

  it('shows the no-matches state when a search excludes everything', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems(items);
    const view = await mount(fake);
    const { type } = await import('../_render');
    type(view.container.querySelector('input[type="search"]') as HTMLInputElement, 'zzz');

    expect(view.container.querySelector('.adl-status--empty')?.textContent).toContain('No matches');
    view.unmount();
  });

  it('filters by kind', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems(items);
    const view = await mount(fake);
    const selects = view.container.querySelectorAll('select');
    selectOption(selects[0] as HTMLSelectElement, 'audio');
    expect(cards(view)).toEqual(['Album Track']);
    view.unmount();
  });

  it('sorts by the chosen order', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems(items);
    const view = await mount(fake);
    // Default is best-match (score descending).
    expect(cards(view)).toEqual(['Album Track', 'Beach Video']);

    const selects = view.container.querySelectorAll('select');
    selectOption(selects[1] as HTMLSelectElement, '2'); // size, descending
    expect(cards(view)).toEqual(['Beach Video', 'Album Track']);
    view.unmount();
  });
});

describe('ui/popup PopupApp — downloads', () => {
  it('enqueues one item through the approved contract', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip' })]);
    const view = await mount(fake);

    click(requireByNamePrefix(view.container, 'Download: Clip'));
    await flush();

    expect(fake.calls).toContain('enqueue:a');
    view.unmount();
  });

  it('never enqueues protected media', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([
      mediaItem({
        id: 'drm',
        title: 'Protected',
        status: 'unsupported',
        unsupportedReason: 'Protected content',
      }),
    ]);
    const view = await mount(fake);

    const button = requireByNamePrefix(view.container, 'Download: Protected') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    await flush();

    expect(fake.calls.some((call) => call.startsWith('enqueue'))).toBe(false);
    view.unmount();
  });

  it('selects supported media in bulk and enqueues the selection', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([
      mediaItem({ id: 'a', title: 'A' }),
      mediaItem({ id: 'b', title: 'B' }),
      mediaItem({ id: 'drm', title: 'D', status: 'unsupported' }),
    ]);
    const view = await mount(fake);

    click(requireByName(view.container, 'Select all'));
    click(requireByName(view.container, 'Download selected'));
    await flush();

    expect(fake.calls).toContain('enqueue:a,b');
    // Selection clears after the bulk action.
    expect(byName(view.container, 'Download selected')).toBeUndefined();
    view.unmount();
  });

  it('clears a selection without enqueueing', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'A' })]);
    const view = await mount(fake);

    click(requireByName(view.container, 'Select all'));
    click(requireByName(view.container, 'Clear selection'));

    expect(byName(view.container, 'Download selected')).toBeUndefined();
    expect(fake.calls.some((call) => call.startsWith('enqueue'))).toBe(false);
    view.unmount();
  });

  it('disables select all when nothing is selectable', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'drm', status: 'unsupported' })]);
    const view = await mount(fake);
    expect((requireByName(view.container, 'Select all') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  });

  it('copies a media link through the runtime, never the DOM API', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip', url: 'https://example.com/a.mp4' })]);
    const view = await mount(fake);

    click(requireByNamePrefix(view.container, 'Copy link: Clip'));
    await flush();

    expect(fake.calls).toContain('copyLink:https://example.com/a.mp4');
    view.unmount();
  });
});

describe('ui/popup PopupApp — queue and runtime events', () => {
  const item = mediaItem({ id: 'a', title: 'Clip' });

  it('renders the queue the runtime reports and reflects it on the card', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([downloadTask({ id: 't1', item, state: 'active', progress: 0.5 })]);
    const view = await mount(fake);

    expect(view.container.querySelector('.adl-queue__summary')?.textContent).toBe(
      '1 active · 0 queued',
    );
    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Downloading');
    view.unmount();
  });

  it('applies a pushed progress snapshot without re-reading the queue', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([downloadTask({ id: 't1', item, state: 'active', progress: 0.1 })]);
    const view = await mount(fake);
    const before = fake.calls.filter((call) => call === 'queryQueue').length;

    fake.emitDownload({
      event: 'download:progress',
      task: {
        taskId: 't1',
        state: 'active',
        filename: 'Clip.mp4',
        progress: 0.75,
        bytesReceived: 750,
        bytesTotal: 1000,
      },
    });
    await flush();

    expect(
      view.container.querySelector('.adl-card [role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('75');
    expect(fake.calls.filter((call) => call === 'queryQueue')).toHaveLength(before);
    view.unmount();
  });

  it('ignores a progress snapshot for a job it does not know', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([downloadTask({ id: 't1', item, state: 'active', progress: 0.1 })]);
    const view = await mount(fake);

    fake.emitDownload({
      event: 'download:progress',
      task: { taskId: 'ghost', state: 'active', filename: 'x', progress: 0.9 },
    });
    await flush();

    expect(
      view.container.querySelector('.adl-card [role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('10');
    view.unmount();
  });

  it('re-reads the queue on a lifecycle event and shows completion', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([downloadTask({ id: 't1', item, state: 'active' })]);
    const view = await mount(fake);

    fake.setTasks([downloadTask({ id: 't1', item, state: 'completed', progress: 1 })]);
    fake.emitDownload({ event: 'download:completed' });
    await flush();

    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Completed');
    view.unmount();
  });

  it('shows a failed job and retries it through the runtime', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([
      downloadTask({
        id: 't1',
        item,
        state: 'failed',
        error: { category: 'network', code: 'n', messageKey: 'k', retryable: true },
      }),
    ]);
    const view = await mount(fake);

    click(requireByName(view.container, 'Show queue'));
    click(requireByNamePrefix(view.container, 'Retry:'));
    await flush();

    expect(fake.calls).toContain('retry:t1');
    view.unmount();
  });

  it('sends cancel, pause, resume, remove and clear as the queue allows', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([item]);
    fake.setTasks([downloadTask({ id: 't1', item, state: 'queued' })]);
    const view = await mount(fake);
    click(requireByName(view.container, 'Show queue'));

    click(requireByNamePrefix(view.container, 'Pause:'));
    click(requireByNamePrefix(view.container, 'Cancel:'));
    click(requireByNamePrefix(view.container, 'Remove:'));
    click(requireByNamePrefix(view.container, 'Clear —'));
    await flush();

    expect(fake.calls).toContain('pause:t1');
    expect(fake.calls).toContain('cancel:t1');
    expect(fake.calls).toContain('remove:t1');
    expect(fake.calls).toContain('clearQueue');

    fake.setTasks([downloadTask({ id: 't1', item, state: 'paused' })]);
    fake.emitDownload({ event: 'download:cancelled' });
    await flush();
    click(requireByNamePrefix(view.container, 'Resume:'));
    await flush();
    expect(fake.calls).toContain('resume:t1');
    view.unmount();
  });

  it('refreshes detection when the background announces fresh results for this tab', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);
    expect(view.container.querySelector('.adl-status--empty')).not.toBeNull();

    fake.setItems([mediaItem({ id: 'new', title: 'Just appeared' })]);
    fake.emitDetection(7);
    await flush();

    expect(cards(view)).toEqual(['Just appeared']);
    view.unmount();
  });

  it('ignores detection announcements for another tab', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Mine' })]);
    const view = await mount(fake);

    fake.setItems([mediaItem({ id: 'other', title: 'Not mine' })]);
    fake.emitDetection(99);
    await flush();

    expect(cards(view)).toEqual(['Mine']);
    view.unmount();
  });
});

describe('ui/popup PopupApp — errors', () => {
  it('surfaces a permission error the runtime broadcasts, and dismisses it', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip' })]);
    const view = await mount(fake);

    fake.emitDownload({
      event: 'error',
      error: {
        category: 'permission',
        code: 'download-permission-denied',
        messageKey: 'error.permission.downloads',
        retryable: false,
      },
    });
    await flush();

    const notice = view.container.querySelector('.adl-notice');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('downloads permission');
    expect(notice?.textContent).not.toContain('download-permission-denied');
    // Results stay visible alongside a recoverable failure.
    expect(cards(view)).toEqual(['Clip']);

    click(requireByName(view.container, 'Dismiss'));
    expect(view.container.querySelector('.adl-notice')).toBeNull();
    view.unmount();
  });

  it('surfaces a failed action instead of failing silently', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip' })]);
    const view = await mount(fake);

    fake.failNext(
      'enqueue',
      new PermissionError('denied', {
        code: 'permission-request-failed',
        messageKey: 'error.permission.operation',
      }),
    );
    click(requireByNamePrefix(view.container, 'Download: Clip'));
    await flush();

    expect(view.container.querySelector('.adl-notice')?.textContent).toContain(
      'downloads permission',
    );
    view.unmount();
  });

  it('surfaces a queue read that fails after an event', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a' })]);
    const view = await mount(fake);

    fake.failNext('queryQueue', new Error('offline'));
    fake.emitDownload({ event: 'download:queued' });
    await flush();

    expect(view.container.querySelector('.adl-notice')?.textContent).toContain('Something went');
    view.unmount();
  });

  it('surfaces a detection refresh that fails', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);

    fake.failNext('queryDetection', new Error('gone'));
    fake.emitDetection(7);
    await flush();

    expect(view.container.querySelector('.adl-notice')).not.toBeNull();
    view.unmount();
  });

  it('surfaces a failed copy', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip' })]);
    const view = await mount(fake);

    fake.failNext('copyLink', new Error('no clipboard'));
    click(requireByNamePrefix(view.container, 'Copy link: Clip'));
    await flush();

    expect(view.container.querySelector('.adl-notice')).not.toBeNull();
    view.unmount();
  });
});

describe('ui/popup PopupApp — theme, accessibility and cleanup', () => {
  it('applies the light theme by default and dark when the OS prefers it', async () => {
    const light = await mount(createFakeRuntimeClient());
    expect(document.documentElement.dataset['theme']).toBe('light');
    light.unmount();

    const dark = await mount(createFakeRuntimeClient(), ALWAYS_DARK);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    dark.unmount();
  });

  it('honours an explicit theme setting over the OS preference', async () => {
    const fake = createFakeRuntimeClient();
    const view = await renderAsync(
      <PopupApp client={fake.client} media={ALWAYS_DARK} mode="light" />,
    );
    expect(document.documentElement.dataset['theme']).toBe('light');
    view.unmount();
  });

  it('gives every control an accessible name and a real button element', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'Clip' })]);
    fake.setTasks([downloadTask({ id: 't1', item: mediaItem({ id: 'a' }), state: 'queued' })]);
    const view = await mount(fake);
    click(requireByName(view.container, 'Show queue'));

    for (const button of view.container.querySelectorAll('button')) {
      const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
      expect(name.length, `unnamed button: ${button.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
    }
    for (const input of view.container.querySelectorAll('input, select')) {
      const labelled = input.getAttribute('aria-label') !== null || input.closest('label') !== null;
      expect(labelled, `unlabelled field: ${input.outerHTML.slice(0, 80)}`).toBe(true);
    }
    view.unmount();
  });

  it('uses landmarks and a heading for structure', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);
    expect(view.container.querySelector('header')).not.toBeNull();
    expect(view.container.querySelector('main')).not.toBeNull();
    expect(view.container.querySelector('h1')?.textContent).toBe('AetherDL');
    view.unmount();
  });

  it('announces the result count politely', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a' })]);
    const view = await mount(fake);
    expect(view.container.querySelector('.adl-toolbar__count')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    view.unmount();
  });

  it('releases every runtime subscription when the popup closes', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);
    expect(fake.subscriptions).toEqual({ downloads: 1, detection: 1 });

    view.unmount();

    expect(fake.subscriptions).toEqual({ downloads: 0, detection: 0 });
  });

  it('does not poll the runtime while idle', async () => {
    const fake = createFakeRuntimeClient();
    const view = await mount(fake);
    const settled = fake.calls.length;

    await flush();
    await flush();

    expect(fake.calls).toHaveLength(settled);
    view.unmount();
  });

  it('refuses to render a popup that was not composed with a runtime client', () => {
    // The composition root must inject the port; a bare consumer is a wiring bug.
    expect(() => render(<Consumer />)).toThrow('RuntimeClientProvider');
  });

  it('drops selections for media that disappeared from the page', async () => {
    const fake = createFakeRuntimeClient();
    fake.setItems([mediaItem({ id: 'a', title: 'A' }), mediaItem({ id: 'b', title: 'B' })]);
    const view = await mount(fake);
    click(requireByName(view.container, 'Select all'));
    expect(byName(view.container, 'Download selected')).toBeDefined();

    fake.setItems([]);
    fake.emitDetection(7);
    await flush();

    expect(byName(view.container, 'Download selected')).toBeUndefined();
    view.unmount();
  });
});
