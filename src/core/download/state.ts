/**
 * Module: core/download (state machine)
 * Purpose: The deterministic, validated download lifecycle (PROJECT_BIBLE.md §10.2).
 *          States: queued → preparing → active → completed | failed | paused |
 *          canceling → canceled; failed/paused/retrying → queued; any → removed.
 *          (User lifecycle names map on: "downloading" ≡ active, "cancelled" ≡
 *          canceled.)
 * Restrictions: Domain layer — pure.
 * Public API: TERMINAL_STATES, canTransition, assertTransition.
 */
import type { TaskState } from '@shared/types';
import { QueueError } from '@core/download/errors';

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['preparing', 'paused', 'canceling', 'canceled', 'removed'],
  preparing: ['active', 'failed', 'canceling'],
  active: ['completed', 'failed', 'paused', 'canceling'],
  paused: ['queued', 'canceled', 'removed'],
  retrying: ['queued', 'canceled', 'removed'],
  canceling: ['canceled', 'paused'],
  completed: ['removed'],
  failed: ['queued', 'retrying', 'removed'],
  canceled: ['removed'],
  removed: [],
};

/** States from which no further work occurs (until explicit retry/remove). */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'canceled',
  'removed',
]);

/** Whether a transition from `from` to `to` is permitted. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a transition is valid; throws {@link QueueError} otherwise. */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new QueueError(`Illegal download state transition: ${from} → ${to}`, {
      code: 'download-illegal-transition',
      messageKey: 'error.download.transition',
      context: { from, to },
    });
  }
}
