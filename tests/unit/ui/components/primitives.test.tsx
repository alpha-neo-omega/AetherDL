// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Button, Icon, IconButton, ProgressBar, StatusView } from '@ui/components';
import { click, render, requireByName } from '../_render';

describe('ui/components primitives', () => {
  it('renders each Material button variant as a real button', () => {
    for (const variant of ['filled', 'tonal', 'outlined', 'text'] as const) {
      const view = render(
        <Button variant={variant} onClick={() => undefined}>
          Go
        </Button>,
      );
      const button = requireByName(view.container, 'Go') as HTMLButtonElement;
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.className).toContain(`adl-button--${variant}`);
      view.unmount();
    }
  });

  it('defaults to the filled variant and carries an icon when asked', () => {
    const view = render(
      <Button icon="download" onClick={() => undefined}>
        Save
      </Button>,
    );
    expect(view.container.querySelector('.adl-button')?.className).toContain('adl-button--filled');
    expect(view.container.querySelector('.adl-button svg')).not.toBeNull();
    view.unmount();
  });

  it('honours an explicit button type', () => {
    const view = render(
      <Button type="submit" onClick={() => undefined}>
        Send
      </Button>,
    );
    expect((requireByName(view.container, 'Send') as HTMLButtonElement).type).toBe('submit');
    view.unmount();
  });

  it('overrides the accessible name when the label is not descriptive', () => {
    const view = render(
      <Button ariaLabel="Download Holiday Clip" onClick={() => undefined}>
        Download
      </Button>,
    );
    expect(requireByName(view.container, 'Download Holiday Clip')).toBeDefined();
    view.unmount();
  });

  it('does not fire while disabled and stays silent without a reason', () => {
    const onClick = vi.fn();
    const view = render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    const button = requireByName(view.container, 'Go');
    expect(button.getAttribute('title')).toBeNull();
    expect(button.getAttribute('aria-description')).toBeNull();
    click(button);
    expect(onClick).not.toHaveBeenCalled();
    view.unmount();
  });

  it('fires when enabled', () => {
    const onClick = vi.fn();
    const view = render(<Button onClick={onClick}>Go</Button>);
    click(requireByName(view.container, 'Go'));
    expect(onClick).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('gives an icon-only button a name, and its disabled reason when present', () => {
    const enabled = render(
      <IconButton icon="cancel" label="Cancel download" onClick={() => undefined} />,
    );
    const button = requireByName(enabled.container, 'Cancel download');
    expect(button.getAttribute('title')).toBe('Cancel download');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    enabled.unmount();

    const disabled = render(
      <IconButton
        icon="cancel"
        label="Cancel download"
        disabled
        disabledReason="Nothing to cancel"
        onClick={() => undefined}
      />,
    );
    expect(requireByName(disabled.container, 'Cancel download').getAttribute('title')).toBe(
      'Nothing to cancel',
    );
    disabled.unmount();

    const bare = render(
      <IconButton icon="cancel" label="Cancel download" disabled onClick={() => undefined} />,
    );
    expect(requireByName(bare.container, 'Cancel download').getAttribute('title')).toBe(
      'Cancel download',
    );
    bare.unmount();
  });

  it('renders determinate progress with its value, clamped', () => {
    const view = render(<ProgressBar value={1.5} label="Downloading" />);
    const bar = view.container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('100');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    view.unmount();

    const low = render(<ProgressBar value={-1} label="Downloading" />);
    expect(low.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '0',
    );
    low.unmount();
  });

  it('falls back to indeterminate for a value that is not a finite number', () => {
    const view = render(<ProgressBar value={Number.NaN} label="Downloading" />);
    const bar = view.container.querySelector('[role="progressbar"]');
    expect(bar?.className).toContain('adl-progress--indeterminate');
    expect(bar?.getAttribute('aria-valuenow')).toBeNull();
    view.unmount();
  });

  it('announces each status view and offers its recovery action', () => {
    const onClick = vi.fn();
    const view = render(
      <StatusView
        kind="error"
        title="Something went wrong"
        detail="Try again."
        action={{ label: 'Retry', onClick }}
      />,
    );
    const status = view.container.querySelector('.adl-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-busy')).toBe('false');
    click(requireByName(view.container, 'Retry'));
    expect(onClick).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('renders the empty status without an action', () => {
    const view = render(<StatusView kind="empty" title="Nothing here" detail="Try later." />);
    expect(view.container.querySelector('.adl-status--empty')).not.toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    view.unmount();
  });

  it('marks icons decorative and sizes them on request', () => {
    const view = render(<Icon name="video" size={32} className="custom" />);
    const svg = view.container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('class')).toBe('custom');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
    view.unmount();
  });
});
