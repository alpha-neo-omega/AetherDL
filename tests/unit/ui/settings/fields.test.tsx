// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NumberField, SelectField, TextField, ToggleField } from '@ui/settings';
import { click, render, selectOption, type } from '../_render';

function control(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`No ${selector}`);
  }
  return element;
}

function help(container: HTMLElement, element: HTMLElement): string | undefined {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
  return ids
    .map(
      (id) =>
        [...container.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === id)
          ?.textContent ?? '',
    )
    .join(' ')
    .trim();
}

describe('ui/settings form fields', () => {
  it('labels a select, lists its options and reports a change', () => {
    const onChange = vi.fn();
    const view = render(
      <SelectField
        label="Theme"
        help="System follows your browser."
        value="light"
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
        ]}
        onChange={onChange}
      />,
    );

    const select = control(view.container, 'select') as HTMLSelectElement;
    expect(select.value).toBe('light');
    expect(view.container.querySelector('label')?.htmlFor).toBe(select.id);
    expect(help(view.container, select)).toBe('System follows your browser.');

    selectOption(select, 'system');
    expect(onChange).toHaveBeenCalledWith('system');
    view.unmount();
  });

  it('reports a numeric change and exposes its bounds', () => {
    const onChange = vi.fn();
    const view = render(
      <NumberField label="Retries" value={3} min={0} max={10} onChange={onChange} />,
    );

    const input = control(view.container, 'input') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.min).toBe('0');
    expect(input.max).toBe('10');
    expect(input.getAttribute('aria-invalid')).toBe('false');

    type(input, '7');
    expect(onChange).toHaveBeenCalledWith(7);
    view.unmount();
  });

  it('reports a text change and shows a placeholder when given one', () => {
    const onChange = vi.fn();
    const view = render(
      <TextField label="Subfolder" value="clips" placeholder="none" onChange={onChange} />,
    );

    const input = control(view.container, 'input') as HTMLInputElement;
    expect(input.value).toBe('clips');
    expect(input.placeholder).toBe('none');

    type(input, 'clips/holiday');
    expect(onChange).toHaveBeenCalledWith('clips/holiday');
    view.unmount();
  });

  it('reports a toggle change', () => {
    const onChange = vi.fn();
    const view = render(<ToggleField label="Notifications" checked={false} onChange={onChange} />);

    const input = control(view.container, 'input') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(false);

    click(input);
    expect(onChange).toHaveBeenCalledWith(true);
    view.unmount();
  });

  it('shows a validation message next to the field and marks it invalid', () => {
    const view = render(
      <NumberField
        label="Retries"
        value={99}
        min={0}
        max={10}
        error="That value is not allowed."
        onChange={() => undefined}
      />,
    );

    const input = control(view.container, 'input') as HTMLInputElement;
    const error = control(view.container, '.adl-field-row__error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(help(view.container, input)).toContain('That value is not allowed.');
    view.unmount();
  });

  it('describes a field by both its help and its error when both are present', () => {
    const view = render(
      <TextField
        label="Subfolder"
        help="Relative to Downloads."
        error="Not allowed."
        value=""
        onChange={() => undefined}
      />,
    );
    const input = control(view.container, 'input');
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toHaveLength(2);
    view.unmount();
  });

  it('has no description when there is neither help nor error', () => {
    const view = render(<TextField label="Subfolder" value="" onChange={() => undefined} />);
    expect(control(view.container, 'input').getAttribute('aria-describedby')).toBeNull();
    view.unmount();
  });

  it('disables every field kind on request', () => {
    for (const node of [
      <SelectField
        key="s"
        label="Theme"
        value="a"
        options={[{ value: 'a', label: 'A' }]}
        disabled
        onChange={() => undefined}
      />,
      <NumberField
        key="n"
        label="N"
        value={1}
        min={0}
        max={2}
        disabled
        onChange={() => undefined}
      />,
      <TextField key="t" label="T" value="" disabled onChange={() => undefined} />,
      <ToggleField key="g" label="G" checked={false} disabled onChange={() => undefined} />,
    ]) {
      const view = render(node);
      const element = view.container.querySelector<HTMLInputElement | HTMLSelectElement>(
        'input, select',
      );
      expect(element?.disabled).toBe(true);
      view.unmount();
    }
  });
});
