/**
 * Module: ui/components (button)
 * Purpose: The Material Design 3 button primitive in the variants AetherDL uses —
 *          filled (primary action), tonal, outlined, text, and icon
 *          (PROJECT_BIBLE.md §11.7).
 * Restrictions: UI layer — presentational only; all styling comes from design-system
 *          tokens via class names, never inline colour (§11.17). Every button is a
 *          real `<button>`: keyboard operable, focusable, with a visible focus ring
 *          and an accessible name (§17.2, §17.3, §17.5). A disabled button explains
 *          why through `aria-describedby`/`title` rather than going silent (§11.7).
 * Public API: ButtonVariant, ButtonProps, Button, IconButtonProps, IconButton.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text';

interface CommonProps {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Explains a disabled control; surfaced on hover/focus and to AT (§11.7). */
  readonly disabledReason?: string;
  readonly type?: 'button' | 'submit';
}

export interface ButtonProps extends CommonProps {
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly children: ReactNode;
  /** Overrides the accessible name when the label alone is not descriptive. */
  readonly ariaLabel?: string;
}

/** A disabled control still says why, on hover and to assistive tech (§11.7, §17.5). */
function reasonProps(
  disabled: boolean,
  reason: string | undefined,
): { readonly title?: string; readonly 'aria-description'?: string } {
  return disabled && reason !== undefined ? { title: reason, 'aria-description': reason } : {};
}

export function Button(props: ButtonProps): ReactNode {
  const variant = props.variant ?? 'filled';
  const disabled = props.disabled ?? false;
  return (
    <button
      type={props.type ?? 'button'}
      className={`adl-button adl-button--${variant}`}
      onClick={props.onClick}
      disabled={disabled}
      {...(props.ariaLabel !== undefined && { 'aria-label': props.ariaLabel })}
      {...reasonProps(disabled, props.disabledReason)}
    >
      {props.icon !== undefined && <Icon name={props.icon} />}
      <span className="adl-button__label">{props.children}</span>
    </button>
  );
}

export interface IconButtonProps extends CommonProps {
  readonly icon: IconName;
  /** Required: an icon-only control must still expose a name to AT (§17.5). */
  readonly label: string;
}

export function IconButton(props: IconButtonProps): ReactNode {
  const disabled = props.disabled ?? false;
  return (
    <button
      type={props.type ?? 'button'}
      className="adl-icon-button"
      onClick={props.onClick}
      disabled={disabled}
      aria-label={props.label}
      title={disabled ? (props.disabledReason ?? props.label) : props.label}
    >
      <Icon name={props.icon} size={20} />
    </button>
  );
}
