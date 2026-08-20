/**
 * Module: ui/popup (queue panel)
 * Purpose: Render the background-owned download queue with its live progress and
 *          the operations the ratified messaging contract defines — cancel, retry,
 *          pause, resume, remove, clear (PROJECT_BIBLE.md §4.4, §11.1).
 * Restrictions: UI layer — a view over the queue. It defines no alternative queue
 *          semantics: which action a job accepts follows the download state machine
 *          the runtime enforces (§10.2), and every action is an intent sent to the
 *          background. Progress comes from runtime state, never from local timers
 *          (§10.5). Status is icon + text, never colour alone (§17.4).
 * Public API: QueuePanelLabels, QueuePanelProps, QueuePanel.
 */
import { useId, useState, type ReactNode } from 'react';
import { formatBytes } from '@shared/utils';
import type { AppError } from '@shared/result';
import type { DownloadTask, TaskState } from '@shared/types';
import { Button, IconButton, ProgressBar } from '@ui/components';

export interface QueuePanelLabels {
  readonly title: string;
  readonly show: string;
  readonly hide: string;
  readonly empty: string;
  readonly summary: string;
  readonly clear: string;
  readonly clearHint: string;
  readonly listLabel: string;
  readonly cancel: string;
  readonly retry: string;
  readonly pause: string;
  readonly resume: string;
  readonly remove: string;
  readonly progressLabel: string;
  readonly taskState: Readonly<Record<TaskState, string>>;
  /**
   * Turns a job's own error into the sentence the user reads. A failed job that shows
   * only "Failed" tells the user nothing: an encrypted stream, a 404, a declined
   * permission and a full disk are the same word and different problems (§20.5).
   */
  readonly describeFailure: (error: AppError) => string;
}

export interface QueuePanelProps {
  readonly tasks: readonly DownloadTask[];
  readonly labels: QueuePanelLabels;
  readonly onCancel: (taskId: string) => void;
  readonly onRetry: (taskId: string) => void;
  readonly onPause: (taskId: string) => void;
  readonly onResume: (taskId: string) => void;
  readonly onRemove: (taskId: string) => void;
  readonly onClear: () => void;
  readonly locale?: string;
}

/** Jobs the runtime is still working on (§10.2 state machine). */
const LIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'preparing',
  'active',
  'canceling',
]);

const CANCELLABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'preparing',
  'active',
  'paused',
  'retrying',
]);

const PAUSABLE: ReadonlySet<TaskState> = new Set<TaskState>(['queued', 'active']);

function bytesLine(task: DownloadTask, locale: string | undefined): string | undefined {
  const received = formatBytes(task.bytesReceived, locale);
  const total = formatBytes(task.bytesTotal, locale);
  if (received === undefined) {
    return total;
  }
  return total === undefined ? received : `${received} / ${total}`;
}

export function QueuePanel(props: QueuePanelProps): ReactNode {
  const { labels, tasks } = props;
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const active = tasks.filter((task) => LIVE_STATES.has(task.state)).length;
  const queued = tasks.filter((task) => task.state === 'queued').length;
  const summary = labels.summary
    .replace('{active}', String(active))
    .replace('{queued}', String(queued));

  return (
    <section className="adl-queue" aria-label={labels.title}>
      <div className="adl-queue__bar">
        <button
          type="button"
          className="adl-queue__toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setExpanded((open) => !open);
          }}
        >
          {expanded ? labels.hide : labels.show}
        </button>
        <p className="adl-queue__summary" aria-live="polite">
          {summary}
        </p>
        <Button
          variant="text"
          icon="clear"
          disabled={tasks.length === 0}
          disabledReason={labels.empty}
          onClick={props.onClear}
          ariaLabel={`${labels.clear} — ${labels.clearHint}`}
        >
          {labels.clear}
        </Button>
      </div>

      <div id={listId} hidden={!expanded}>
        {tasks.length === 0 ? (
          <p className="adl-queue__empty">{labels.empty}</p>
        ) : (
          <ul className="adl-queue__list" aria-label={labels.listLabel}>
            {tasks.map((task) => {
              const bytes = bytesLine(task, props.locale);
              const retryable = task.state === 'failed' && task.error?.retryable !== false;
              return (
                <li className="adl-queue__item" key={task.id}>
                  <div className="adl-queue__item-head">
                    <span className="adl-queue__item-name" title={task.filename}>
                      {task.filename}
                    </span>
                    <span className="adl-queue__item-state">{labels.taskState[task.state]}</span>
                  </div>
                  {task.state === 'failed' && task.error !== undefined && (
                    <p className="adl-queue__item-reason">{labels.describeFailure(task.error)}</p>
                  )}
                  {LIVE_STATES.has(task.state) && (
                    <ProgressBar
                      label={`${labels.progressLabel}: ${task.filename}`}
                      {...(task.progress !== undefined && { value: task.progress })}
                    />
                  )}
                  {bytes !== undefined && <p className="adl-queue__item-bytes">{bytes}</p>}
                  <div className="adl-queue__item-actions">
                    {PAUSABLE.has(task.state) && (
                      <IconButton
                        icon="pause"
                        label={`${labels.pause}: ${task.filename}`}
                        onClick={() => {
                          props.onPause(task.id);
                        }}
                      />
                    )}
                    {task.state === 'paused' && (
                      <IconButton
                        icon="resume"
                        label={`${labels.resume}: ${task.filename}`}
                        onClick={() => {
                          props.onResume(task.id);
                        }}
                      />
                    )}
                    {retryable && (
                      <IconButton
                        icon="retry"
                        label={`${labels.retry}: ${task.filename}`}
                        onClick={() => {
                          props.onRetry(task.id);
                        }}
                      />
                    )}
                    {CANCELLABLE.has(task.state) && (
                      <IconButton
                        icon="cancel"
                        label={`${labels.cancel}: ${task.filename}`}
                        onClick={() => {
                          props.onCancel(task.id);
                        }}
                      />
                    )}
                    <IconButton
                      icon="remove"
                      label={`${labels.remove}: ${task.filename}`}
                      onClick={() => {
                        props.onRemove(task.id);
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
