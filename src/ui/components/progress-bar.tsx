/**
 * Module: ui/components (progress bar)
 * Purpose: The Material Design 3 linear progress indicator used for download
 *          progress and loading states (PROJECT_BIBLE.md §11.5, §10.5).
 * Restrictions: UI layer — presentational only. Progress is HONEST: an unknown
 *          total renders an indeterminate track, never a fabricated percentage
 *          (§2.8, §10.5). Exposes `progressbar` semantics with a name and, when
 *          determinate, its value (§17.5). Animation is suppressed under reduced
 *          motion by the stylesheet (§17.7).
 * Public API: ProgressBarProps, ProgressBar.
 */
import type { ReactNode } from 'react';

export interface ProgressBarProps {
  /** Completion in 0..1. Omit for indeterminate (total unknown). */
  readonly value?: number;
  /** Accessible name for the indicator (§17.5). */
  readonly label: string;
}

export function ProgressBar(props: ProgressBarProps): ReactNode {
  const determinate = props.value !== undefined && Number.isFinite(props.value);
  const clamped = determinate ? Math.min(1, Math.max(0, props.value ?? 0)) : 0;
  const percent = Math.round(clamped * 100);

  return (
    <div
      className={`adl-progress${determinate ? '' : ' adl-progress--indeterminate'}`}
      role="progressbar"
      aria-label={props.label}
      {...(determinate
        ? { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }
        : {})}
    >
      <div
        className="adl-progress__track"
        {...(determinate ? { style: { inlineSize: `${percent}%` } } : {})}
      />
    </div>
  );
}
