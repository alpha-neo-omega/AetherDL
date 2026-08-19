// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DownloadTask, TaskState } from '@shared/types';
import { QueuePanel } from '@ui/popup';
import { downloadTask, mediaItem, queueLabels } from '../_fixtures';
import {
  byName,
  byNamePrefix,
  click,
  render,
  requireByName,
  requireByNamePrefix,
  texts,
} from '../_render';

const labels = queueLabels();
const item = mediaItem({ id: 'a', title: 'Clip' });

const handlers = {
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onRemove: vi.fn(),
  onClear: vi.fn(),
};

function renderPanel(tasks: readonly DownloadTask[]) {
  return render(<QueuePanel tasks={tasks} labels={labels} locale="en-US" {...handlers} />);
}

function task(state: TaskState, props: Partial<DownloadTask> = {}): DownloadTask {
  return downloadTask({ id: 't1', item, state, ...props });
}

function expand(container: HTMLElement): void {
  click(requireByName(container, labels.show));
}

describe('ui/popup QueuePanel', () => {
  it('summarises the queue and disables clearing when it is empty', () => {
    const view = renderPanel([]);
    expect(view.container.querySelector('.adl-queue__summary')?.textContent).toBe(
      '0 active · 0 queued',
    );
    const clear = requireByNamePrefix(view.container, 'Clear —') as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.getAttribute('title')).toBe('Nothing queued.');
    view.unmount();
  });

  it('counts live transfers and waiting jobs separately', () => {
    const view = renderPanel([
      task('active', { id: 'a1' }),
      task('preparing', { id: 'a2' }),
      task('queued', { id: 'q1' }),
      task('completed', { id: 'c1' }),
    ]);
    expect(view.container.querySelector('.adl-queue__summary')?.textContent).toBe(
      '2 active · 1 queued',
    );
    view.unmount();
  });

  it('announces the summary politely without stealing focus', () => {
    const view = renderPanel([]);
    expect(view.container.querySelector('.adl-queue__summary')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    view.unmount();
  });

  it('expands and collapses the list, exposing the state to assistive tech', () => {
    const view = renderPanel([task('queued')]);
    const toggle = requireByName(view.container, labels.show);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    click(toggle);
    expect(requireByName(view.container, labels.hide).getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.adl-queue__list')).not.toBeNull();

    click(requireByName(view.container, labels.hide));
    expect(requireByName(view.container, labels.show).getAttribute('aria-expanded')).toBe('false');
    view.unmount();
  });

  it('says so when the queue is empty and expanded', () => {
    const view = renderPanel([]);
    expand(view.container);
    expect(view.container.querySelector('.adl-queue__empty')?.textContent).toBe('Nothing queued.');
    view.unmount();
  });

  it('offers pause, cancel and remove for a queued job', () => {
    const view = renderPanel([task('queued')]);
    expand(view.container);
    expect(byNamePrefix(view.container, 'Pause:')).toBeDefined();
    expect(byNamePrefix(view.container, 'Cancel:')).toBeDefined();
    expect(byNamePrefix(view.container, 'Remove:')).toBeDefined();
    expect(byNamePrefix(view.container, 'Resume:')).toBeUndefined();
    expect(byNamePrefix(view.container, 'Retry:')).toBeUndefined();
    view.unmount();
  });

  it('offers resume for a paused job and hides pause', () => {
    const view = renderPanel([task('paused')]);
    expand(view.container);
    expect(byNamePrefix(view.container, 'Resume:')).toBeDefined();
    expect(byNamePrefix(view.container, 'Pause:')).toBeUndefined();
    view.unmount();
  });

  it('offers retry only for a failed job the contract allows retrying', () => {
    const retryable = renderPanel([
      task('failed', {
        error: { category: 'network', code: 'n', messageKey: 'k', retryable: true },
      }),
    ]);
    expand(retryable.container);
    expect(byNamePrefix(retryable.container, 'Retry:')).toBeDefined();
    expect(byNamePrefix(retryable.container, 'Cancel:')).toBeUndefined();
    retryable.unmount();

    const refused = renderPanel([
      task('failed', {
        error: { category: 'drm', code: 'd', messageKey: 'k', retryable: false },
      }),
    ]);
    expand(refused.container);
    expect(byNamePrefix(refused.container, 'Retry:')).toBeUndefined();
    refused.unmount();
  });

  it('offers only removal for a settled job', () => {
    for (const state of ['completed', 'canceled', 'removed'] as const) {
      const view = renderPanel([task(state)]);
      expand(view.container);
      expect(byNamePrefix(view.container, 'Remove:')).toBeDefined();
      expect(byNamePrefix(view.container, 'Cancel:')).toBeUndefined();
      expect(byNamePrefix(view.container, 'Pause:')).toBeUndefined();
      view.unmount();
    }
  });

  it('shows progress only while a transfer is live', () => {
    const live = renderPanel([task('active', { progress: 0.25 })]);
    expand(live.container);
    expect(
      live.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('25');
    live.unmount();

    const waiting = renderPanel([task('queued')]);
    expand(waiting.container);
    expect(waiting.container.querySelector('[role="progressbar"]')).toBeNull();
    waiting.unmount();
  });

  it('shows transferred and total bytes when the runtime knows them', () => {
    const both = renderPanel([task('active', { bytesReceived: 1024, bytesTotal: 4096 })]);
    expand(both.container);
    expect(texts(both.container, '.adl-queue__item-bytes')).toEqual(['1 kB / 4 kB']);
    both.unmount();

    const partial = renderPanel([task('active', { bytesReceived: 2048 })]);
    expand(partial.container);
    expect(texts(partial.container, '.adl-queue__item-bytes')).toEqual(['2 kB']);
    partial.unmount();

    const totalOnly = renderPanel([task('queued', { bytesTotal: 2048 })]);
    expand(totalOnly.container);
    expect(texts(totalOnly.container, '.adl-queue__item-bytes')).toEqual(['2 kB']);
    totalOnly.unmount();

    const unknown = renderPanel([task('queued')]);
    expand(unknown.container);
    expect(unknown.container.querySelector('.adl-queue__item-bytes')).toBeNull();
    unknown.unmount();
  });

  it('sends each operation to the runtime with the job id', () => {
    for (const [state, prefix, handler] of [
      ['queued', 'Pause:', handlers.onPause],
      ['queued', 'Cancel:', handlers.onCancel],
      ['queued', 'Remove:', handlers.onRemove],
      ['paused', 'Resume:', handlers.onResume],
    ] as const) {
      handler.mockClear();
      const view = renderPanel([task(state)]);
      expand(view.container);
      click(byNamePrefix(view.container, prefix) as Element);
      expect(handler).toHaveBeenCalledWith('t1');
      view.unmount();
    }

    handlers.onRetry.mockClear();
    const failed = renderPanel([
      task('failed', {
        error: { category: 'network', code: 'n', messageKey: 'k', retryable: true },
      }),
    ]);
    expand(failed.container);
    click(byNamePrefix(failed.container, 'Retry:') as Element);
    expect(handlers.onRetry).toHaveBeenCalledWith('t1');
    failed.unmount();
  });

  it('clears the queue and explains what clearing does', () => {
    handlers.onClear.mockClear();
    const view = renderPanel([task('completed')]);
    const clear = byName(view.container, 'Clear — Removes every job except transfers in progress.');
    expect(clear).toBeDefined();
    click(clear as Element);
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('names the list and every control for assistive tech', () => {
    const view = renderPanel([task('active')]);
    expand(view.container);
    expect(view.container.querySelector('.adl-queue__list')?.getAttribute('aria-label')).toBe(
      'Download queue',
    );
    expect(view.container.querySelector('section')?.getAttribute('aria-label')).toBe('Queue');
    for (const button of view.container.querySelectorAll('.adl-icon-button')) {
      expect(button.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
    }
    view.unmount();
  });
});
