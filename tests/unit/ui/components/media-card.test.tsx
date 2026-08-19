// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MediaCard } from '@ui/components';
import { cardLabels, downloadTask, mediaItem } from '../_fixtures';
import { click, render, requireByNamePrefix, texts } from '../_render';

const LOCALE = 'en-US';
const labels = cardLabels();

function noop(): void {
  /* intentionally empty: the test asserts on the callbacks it cares about */
}

function renderCard(overrides: Partial<Parameters<typeof MediaCard>[0]> = {}) {
  return render(
    <ul>
      <MediaCard
        item={mediaItem({ id: 'a' })}
        selected={false}
        onToggleSelected={noop}
        onDownload={noop}
        onCopyLink={noop}
        labels={labels}
        locale={LOCALE}
        {...overrides}
      />
    </ul>,
  );
}

describe('ui/components MediaCard', () => {
  it('renders the title and every metadata field the engine supplied', () => {
    const view = renderCard({
      item: mediaItem({
        id: 'a',
        title: 'Holiday Clip',
        container: 'mp4',
        quality: '1080p',
        width: 1920,
        height: 1080,
        durationSec: 204,
        sizeBytes: 5 * 1024 * 1024,
        originHost: 'videos.test',
        filename: 'holiday.mp4',
        codec: 'avc1.640028',
        delivery: 'progressive',
      }),
    });

    expect(view.container.querySelector('.adl-card__title')?.textContent).toBe('Holiday Clip');
    expect(texts(view.container, '.adl-card__fact dd')).toEqual([
      'MP4',
      '1080p',
      '1920×1080',
      '3:24',
      '5 MB',
      'videos.test',
      'holiday.mp4',
      'avc1.640028',
      'progressive',
    ]);
    view.unmount();
  });

  it('omits fields the engine did not supply rather than inventing them', () => {
    const view = renderCard({ item: mediaItem({ id: 'a', originHost: 'only.test' }) });
    expect(texts(view.container, '.adl-card__fact dd')).toEqual(['only.test']);
    expect(view.container.textContent).not.toContain('Unknown');
    view.unmount();
  });

  it('marks an estimated size in both the value and its field name', () => {
    const view = renderCard({
      item: mediaItem({ id: 'a', sizeBytes: 1024 * 1024, sizeEstimated: true }),
    });
    expect(texts(view.container, '.adl-card__fact dd')).toContain('~1 MB');
    expect(texts(view.container, '.adl-card__fact dt')).toContain('Size (estimated)');
    view.unmount();
  });

  it('hides a quality the engine could not determine', () => {
    const view = renderCard({ item: mediaItem({ id: 'a', quality: 'unknown' }) });
    expect(texts(view.container, '.adl-card__fact dd')).not.toContain('unknown');
    view.unmount();
  });

  it('names every metadata value for assistive tech', () => {
    const view = renderCard({ item: mediaItem({ id: 'a', container: 'webm', durationSec: 61 }) });
    expect(texts(view.container, '.adl-card__fact dt')).toEqual(['Type', 'Duration', 'Host']);
    view.unmount();
  });

  it('downloads and copies through the callbacks, never touching a browser API', () => {
    const onDownload = vi.fn();
    const onCopyLink = vi.fn();
    const item = mediaItem({ id: 'a', title: 'Clip' });
    const view = renderCard({ item, onDownload, onCopyLink });

    click(requireByNamePrefix(view.container, 'Download: Clip'));
    click(requireByNamePrefix(view.container, 'Copy link: Clip'));

    expect(onDownload).toHaveBeenCalledWith('a');
    expect(onCopyLink).toHaveBeenCalledWith(item);
    view.unmount();
  });

  it('toggles selection through the checkbox', () => {
    const onToggleSelected = vi.fn();
    const view = renderCard({ onToggleSelected });
    const checkbox = view.container.querySelector<HTMLInputElement>('.adl-card__select');
    expect(checkbox?.checked).toBe(false);
    click(checkbox as Element);
    expect(onToggleSelected).toHaveBeenCalledWith('a');
    view.unmount();
  });

  it('marks protected media unsupported, disables download, and states the reason', () => {
    const view = renderCard({
      item: mediaItem({
        id: 'drm',
        title: 'Protected',
        status: 'unsupported',
        unsupportedReason: 'Protected content',
      }),
    });

    const card = view.container.querySelector('.adl-card');
    expect(card?.classList.contains('adl-card--unsupported')).toBe(true);
    const badge = view.container.querySelector('.adl-card__badge')?.textContent ?? '';
    expect(badge).toContain('Unsupported');
    expect(badge).toContain('Protected content');

    const download = requireByNamePrefix(view.container, 'Download: Protected');
    expect((download as HTMLButtonElement).disabled).toBe(true);
    expect(download.getAttribute('title')).toBe('Protected content');
    expect(download.getAttribute('aria-description')).toBe('Protected content');

    const checkbox = view.container.querySelector<HTMLInputElement>('.adl-card__select');
    expect(checkbox?.disabled).toBe(true);
    view.unmount();
  });

  it('falls back to a generic reason when the engine gave none', () => {
    const view = renderCard({
      item: mediaItem({ id: 'drm', title: 'Protected', status: 'unsupported' }),
    });
    const download = requireByNamePrefix(view.container, 'Download: Protected');
    expect(download.getAttribute('title')).toBe('Unsupported');
    view.unmount();
  });

  it('does not convey the unsupported state with colour alone', () => {
    const view = renderCard({
      item: mediaItem({ id: 'drm', status: 'unsupported', unsupportedReason: 'Protected' }),
    });
    // An icon plus text label, not just a tinted card (§17.4).
    expect(view.container.querySelector('.adl-card__badge svg')).not.toBeNull();
    expect(view.container.querySelector('.adl-card__badge')?.textContent).toContain('Unsupported');
    view.unmount();
  });

  it('reflects an active job with determinate progress and blocks a second enqueue', () => {
    const item = mediaItem({ id: 'a', title: 'Clip' });
    const view = renderCard({
      item,
      task: downloadTask({ id: 't1', item, state: 'active', progress: 0.42 }),
    });

    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Downloading');
    const progress = view.container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('42');
    expect(progress?.getAttribute('aria-label')).toBe('Download progress: Clip');

    const download = requireByNamePrefix(view.container, 'Download: Clip');
    expect((download as HTMLButtonElement).disabled).toBe(true);
    expect(download.getAttribute('title')).toBe('Already in the download queue.');
    view.unmount();
  });

  it('shows indeterminate progress when the total is unknown', () => {
    const item = mediaItem({ id: 'a' });
    const view = renderCard({ item, task: downloadTask({ id: 't1', item, state: 'active' }) });
    const progress = view.container.querySelector('[role="progressbar"]');
    expect(progress?.classList.contains('adl-progress--indeterminate')).toBe(true);
    expect(progress?.getAttribute('aria-valuenow')).toBeNull();
    view.unmount();
  });

  it('shows a settled job without a progress bar and re-enables download', () => {
    const item = mediaItem({ id: 'a', title: 'Clip' });
    for (const [state, label] of [
      ['completed', 'Completed'],
      ['failed', 'Failed'],
    ] as const) {
      const view = renderCard({ item, task: downloadTask({ id: 't1', item, state }) });
      expect(view.container.querySelector('.adl-card__status')?.textContent).toContain(label);
      expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
      expect(
        (requireByNamePrefix(view.container, 'Download: Clip') as HTMLButtonElement).disabled,
      ).toBe(false);
      view.unmount();
    }
  });

  it('uses the kind icon for audio and stream media', () => {
    for (const kind of ['audio', 'stream', 'image-sequence'] as const) {
      const view = renderCard({ item: mediaItem({ id: 'a', kind }) });
      expect(view.container.querySelector('.adl-card__kind')).not.toBeNull();
      view.unmount();
    }
  });
});
