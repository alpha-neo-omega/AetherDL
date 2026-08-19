/**
 * Module: ui/components (status view)
 * Purpose: The shared presentation for the non-results UI states — loading, empty,
 *          and error (PROJECT_BIBLE.md §11.4, §11.5). Every view defines all its
 *          applicable states; a view with only a happy path is incomplete.
 * Restrictions: UI layer — presentational only. Errors show plain language, a cause
 *          hint and a recovery action; never a stack trace or internal code (§20.5).
 *          Status is announced to assistive tech without spamming (§17.5).
 * Public API: StatusKind, StatusViewProps, StatusView.
 */
import type { ReactNode } from 'react';
import { Button } from './button';
import { Icon, type IconName } from './icons';
import { ProgressBar } from './progress-bar';

export type StatusKind = 'loading' | 'empty' | 'error';

export interface StatusViewProps {
  readonly kind: StatusKind;
  readonly title: string;
  /** One-line explanation, plus a hint for the empty state (§11.5). */
  readonly detail: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

const ICONS: Readonly<Record<Exclude<StatusKind, 'loading'>, IconName>> = {
  empty: 'search',
  error: 'error',
};

export function StatusView(props: StatusViewProps): ReactNode {
  return (
    <div
      className={`adl-status adl-status--${props.kind}`}
      role="status"
      aria-live="polite"
      aria-busy={props.kind === 'loading'}
    >
      {props.kind === 'loading' ? (
        <ProgressBar label={props.title} />
      ) : (
        <Icon name={ICONS[props.kind]} size={32} className="adl-status__icon" />
      )}
      <p className="adl-status__title">{props.title}</p>
      <p className="adl-status__detail">{props.detail}</p>
      {props.action !== undefined && (
        <Button variant="tonal" icon="retry" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      )}
    </div>
  );
}
