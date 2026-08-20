/**
 * Module: ui/popup (application)
 * Purpose: The popup surface — app bar, toolbar, detected-media list, bulk actions,
 *          queue panel, and the complete state catalogue (PROJECT_BIBLE.md §11.1,
 *          §11.5). Mounted by `runtime/popup`.
 * Restrictions: UI layer — a view over runtime state. It performs no detection and
 *          no download work, touches no browser API, and owns only ephemeral view
 *          state (search / filter / sort / selection); the background stays the
 *          owner of results and the queue (§8.7, §13.2). Filter, sort and search run
 *          through the core query engine (§4.12). All copy resolves from the message
 *          catalogue (§19.1) and all styling from design-system tokens (§11.17).
 * Public API: PopupAppProps, PopupApp.
 */
import { useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { createQueryEngine } from '@core/query/query';
import type { SortSpec } from '@core/query';
import type { DownloadTask, MediaItem, MediaKind, TaskState } from '@shared/types';
import { Button, MediaCard, StatusView, type MediaCardLabels } from '@ui/components';
import { ThemeProvider, type MediaPreferences, type ThemeMode } from '@ui/design-system';
import { INITIAL_POPUP_VIEW, popupViewReducer, toFilterSpec, type KindFilter } from '@ui/state';
import { describeError } from './errors';
import { QualityChooserDialog, type QualityChooserLabels } from './quality-chooser';
import { QueuePanel, type QueuePanelLabels } from './queue-panel';
import { createTranslator, type MessageKey, type Translate } from './strings';
import { RuntimeClientProvider, useRuntimeClient, type PopupRuntimeClient } from './runtime-client';
import { usePopupRuntime } from './use-popup-runtime';
import { useThemeSettings } from './use-theme-settings';

const KIND_OPTIONS: readonly { readonly value: KindFilter; readonly key: MessageKey }[] = [
  { value: 'all', key: 'popup.kind.all' },
  { value: 'video', key: 'popup.kind.video' },
  { value: 'audio', key: 'popup.kind.audio' },
  { value: 'stream', key: 'popup.kind.stream' },
  // No `image-sequence` option: no detector produces that kind, so the filter could
  // only ever return "no matches". The kind stays in the model for when one does
  // (§4.12 — a filter must describe media that can actually appear).
];

const SORT_OPTIONS: readonly { readonly value: SortSpec; readonly key: MessageKey }[] = [
  { value: { key: 'score', direction: 'desc' }, key: 'popup.sort.score' },
  { value: { key: 'title', direction: 'asc' }, key: 'popup.sort.title' },
  { value: { key: 'sizeBytes', direction: 'desc' }, key: 'popup.sort.sizeBytes' },
  { value: { key: 'durationSec', direction: 'desc' }, key: 'popup.sort.durationSec' },
  { value: { key: 'discoveredAt', direction: 'desc' }, key: 'popup.sort.discoveredAt' },
];

const TASK_STATE_KEYS: Readonly<Record<TaskState, MessageKey>> = {
  queued: 'task.queued',
  preparing: 'task.preparing',
  active: 'task.active',
  paused: 'task.paused',
  retrying: 'task.retrying',
  canceling: 'task.canceling',
  canceled: 'task.canceled',
  completed: 'task.completed',
  failed: 'task.failed',
  removed: 'task.removed',
};

function taskStateLabels(t: Translate): Readonly<Record<TaskState, string>> {
  const labels = {} as Record<TaskState, string>;
  for (const [state, key] of Object.entries(TASK_STATE_KEYS) as [TaskState, MessageKey][]) {
    labels[state] = t(key);
  }
  return labels;
}

/**
 * Whether this item has qualities to choose between (§10.6).
 *
 * Only a manifest does: it lists renditions. A progressive file is one file, and
 * offering a chooser for it would open an empty dialog.
 */
function hasQualities(item: MediaItem): boolean {
  return item.delivery === 'hls' || item.delivery === 'dash';
}

/** The most recent queue entry per media item; the queue stays authoritative (§4.4). */
function latestTaskByItem(tasks: readonly DownloadTask[]): ReadonlyMap<string, DownloadTask> {
  const latest = new Map<string, DownloadTask>();
  for (const task of tasks) {
    const current = latest.get(task.item.id);
    if (current === undefined || task.createdAt >= current.createdAt) {
      latest.set(task.item.id, task);
    }
  }
  return latest;
}

function sortIndexOf(sort: SortSpec): number {
  const index = SORT_OPTIONS.findIndex(
    (option) => option.value.key === sort.key && option.value.direction === sort.direction,
  );
  return index < 0 ? 0 : index;
}

function PopupSurface(props: {
  readonly locale?: string;
  readonly messages?: Readonly<Record<MessageKey, string>>;
}): ReactNode {
  const client = useRuntimeClient();
  const runtime = usePopupRuntime(client);
  const [view, dispatch] = useReducer(popupViewReducer, INITIAL_POPUP_VIEW);
  const messages = props.messages;
  const t = useMemo(() => createTranslator(messages), [messages]);
  const engine = useMemo(() => createQueryEngine(), []);
  const { actions, items, tasks } = runtime;

  // Drop selections for media that navigation or a refresh removed (§9.9).
  useEffect(() => {
    dispatch({ type: 'reconcile', itemIds: items.map((item) => item.id) });
  }, [items]);

  const visible = useMemo(
    () => engine.apply(items, toFilterSpec(view), view.sort),
    [engine, items, view],
  );
  const taskByItem = useMemo(() => latestTaskByItem(tasks), [tasks]);

  const cardLabels = useMemo<MediaCardLabels>(
    () => ({
      download: t('card.download'),
      copyLink: t('card.copyLink'),
      chooseQuality: t('card.chooseQuality'),
      select: t('card.select'),
      unsupported: t('card.unsupported'),
      estimated: t('card.estimated'),
      alreadyQueued: t('card.alreadyQueued'),
      progressLabel: t('card.progress'),
      fields: {
        type: t('card.field.type'),
        quality: t('card.field.quality'),
        resolution: t('card.field.resolution'),
        duration: t('card.field.duration'),
        size: t('card.field.size'),
        host: t('card.field.host'),
        filename: t('card.field.filename'),
        codec: t('card.field.codec'),
        delivery: t('card.field.delivery'),
      },
      delivery: {
        progressive: t('card.delivery.progressive'),
        direct: t('card.delivery.direct'),
        html5: t('card.delivery.html5'),
        hls: t('card.delivery.hls'),
        dash: t('card.delivery.dash'),
        blob: t('card.delivery.blob'),
        // The catalogue name may only contain word characters, so the key spells the
        // delivery type in camel case while the map is still keyed by its real value.
        'media-source': t('card.delivery.mediaSource'),
      },
      taskState: taskStateLabels(t),
    }),
    [t],
  );

  const qualityLabels = useMemo<QualityChooserLabels>(
    () => ({
      title: t('quality.title'),
      loading: t('quality.loading'),
      empty: t('quality.empty'),
      cancel: t('quality.cancel'),
      preferred: t('quality.preferred'),
      audioTrack: t('quality.audioTrack'),
    }),
    [t],
  );

  const queueLabels = useMemo<QueuePanelLabels>(
    () => ({
      title: t('queue.title'),
      show: t('queue.show'),
      hide: t('queue.hide'),
      empty: t('queue.empty'),
      summary: t('queue.summary'),
      clear: t('queue.clear'),
      clearHint: t('queue.clearHint'),
      listLabel: t('queue.list.label'),
      cancel: t('queue.cancel'),
      retry: t('queue.retry'),
      pause: t('queue.pause'),
      resume: t('queue.resume'),
      remove: t('queue.remove'),
      progressLabel: t('card.progress'),
      taskState: taskStateLabels(t),
      // The reason a job failed, in the user's own language, from the job's own error.
      describeFailure: (error) => describeError(error, t).detail,
    }),
    [t],
  );

  const selectableIds = visible
    .filter((item: MediaItem) => item.status === 'supported')
    .map((item) => item.id);
  const selectedIds = [...view.selected];
  const notice = runtime.notice === undefined ? undefined : describeError(runtime.notice, t);
  const countLabel =
    visible.length === 1
      ? t('popup.count.one')
      : t('popup.count.other', { count: String(visible.length) });

  const body = ((): ReactNode => {
    if (runtime.status === 'loading') {
      return (
        <StatusView
          kind="loading"
          title={t('popup.loading.title')}
          detail={t('popup.loading.detail')}
        />
      );
    }
    if (runtime.status === 'error') {
      return (
        <StatusView
          kind="error"
          title={t('error.unavailable.title')}
          detail={t('error.unavailable.detail')}
          action={{ label: t('popup.retry'), onClick: actions.reload }}
        />
      );
    }
    if (items.length === 0) {
      return (
        <StatusView kind="empty" title={t('popup.empty.title')} detail={t('popup.empty.detail')} />
      );
    }
    if (visible.length === 0) {
      return (
        <StatusView
          kind="empty"
          title={t('popup.noMatches.title')}
          detail={t('popup.noMatches.detail')}
        />
      );
    }
    return (
      <ul className="adl-list" aria-label={t('popup.results.label')}>
        {visible.map((item) => {
          const task = taskByItem.get(item.id);
          return (
            <MediaCard
              key={item.id}
              item={item}
              {...(task !== undefined && { task })}
              selected={view.selected.has(item.id)}
              onToggleSelected={(itemId) => {
                dispatch({ type: 'toggle', itemId });
              }}
              onDownload={(itemId) => {
                actions.download([itemId]);
              }}
              onCopyLink={actions.copyLink}
              {...(hasQualities(item) && { onChooseQuality: actions.chooseQuality })}
              labels={cardLabels}
              {...(props.locale !== undefined && { locale: props.locale })}
            />
          );
        })}
      </ul>
    );
  })();

  return (
    <div className="adl-popup">
      <header className="adl-appbar">
        <h1 className="adl-appbar__brand">{t('popup.brand')}</h1>
        <label className="adl-field adl-field--search">
          <span className="adl-visually-hidden">{t('popup.searchLabel')}</span>
          <input
            type="search"
            className="adl-input"
            placeholder={t('popup.searchPlaceholder')}
            value={view.search}
            onChange={(event) => {
              dispatch({ type: 'search', value: event.target.value });
            }}
          />
        </label>
      </header>

      <div className="adl-toolbar">
        <label className="adl-field">
          <span className="adl-visually-hidden">{t('popup.kindLabel')}</span>
          <select
            className="adl-select"
            value={view.kind}
            onChange={(event) => {
              dispatch({ type: 'kind', value: event.target.value as MediaKind | 'all' });
            }}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.key)}
              </option>
            ))}
          </select>
        </label>
        <label className="adl-field">
          <span className="adl-visually-hidden">{t('popup.sortLabel')}</span>
          <select
            className="adl-select"
            value={String(sortIndexOf(view.sort))}
            onChange={(event) => {
              const option = SORT_OPTIONS[Number(event.target.value)];
              if (option !== undefined) {
                dispatch({ type: 'sort', value: option.value });
              }
            }}
          >
            {SORT_OPTIONS.map((option, index) => (
              <option key={option.key} value={String(index)}>
                {t(option.key)}
              </option>
            ))}
          </select>
        </label>
        <p className="adl-toolbar__count" aria-live="polite">
          {countLabel}
        </p>
        <Button
          variant="text"
          disabled={selectableIds.length === 0}
          onClick={() => {
            dispatch({ type: 'select-all', itemIds: selectableIds });
          }}
        >
          {t('popup.selectAll')}
        </Button>
      </div>

      {notice !== undefined && (
        <div className="adl-notice" role="alert">
          <div className="adl-notice__text">
            <p className="adl-notice__title">{notice.title}</p>
            <p className="adl-notice__detail">{notice.detail}</p>
          </div>
          <Button variant="text" onClick={actions.dismissNotice}>
            {t('error.dismiss')}
          </Button>
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="adl-bulk">
          <Button
            variant="tonal"
            icon="download"
            onClick={() => {
              actions.download(selectedIds);
              dispatch({ type: 'clear-selection' });
            }}
          >
            {t('popup.downloadSelected')}
          </Button>
          <Button
            variant="text"
            onClick={() => {
              dispatch({ type: 'clear-selection' });
            }}
          >
            {t('popup.clearSelection')}
          </Button>
        </div>
      )}

      <main className="adl-main">{body}</main>

      <QueuePanel
        tasks={tasks}
        labels={queueLabels}
        onCancel={actions.cancel}
        onRetry={actions.retry}
        onPause={actions.pause}
        onResume={actions.resume}
        onRemove={actions.remove}
        onClear={actions.clearQueue}
        {...(props.locale !== undefined && { locale: props.locale })}
      />

      {runtime.chooser !== undefined && (
        <QualityChooserDialog
          title={runtime.chooser.item.title}
          status={runtime.chooser.status}
          renditions={runtime.chooser.renditions}
          labels={qualityLabels}
          onPick={(renditionId) => {
            if (runtime.chooser !== undefined) {
              actions.downloadRendition(runtime.chooser.item.id, renditionId);
            }
          }}
          onClose={actions.closeChooser}
        />
      )}
    </div>
  );
}

/**
 * Themes the popup from the user's Appearance settings, which the background
 * pushes whenever they change (§4.9 applied live, §11.15, §17.7). An explicit
 * `mode` prop still wins, so a host can pin the appearance.
 */
function PopupRoot(props: {
  readonly mode?: ThemeMode;
  readonly media?: MediaPreferences;
  readonly locale?: string;
  readonly messages?: Readonly<Record<MessageKey, string>>;
}): ReactNode {
  const client = useRuntimeClient();
  const appearance = useThemeSettings(client);
  return (
    <ThemeProvider
      mode={props.mode ?? appearance.theme}
      reducedMotion={appearance.reducedMotion}
      {...(props.media !== undefined && { media: props.media })}
    >
      <PopupSurface
        {...(props.locale !== undefined && { locale: props.locale })}
        {...(props.messages !== undefined && { messages: props.messages })}
      />
    </ThemeProvider>
  );
}

export interface PopupAppProps {
  /** The injected runtime boundary (dependency inversion, §8.4 rule 3). */
  readonly client: PopupRuntimeClient;
  /** Pins the theme; omitted, the popup follows the Theme setting (§4.9, §11.15). */
  readonly mode?: ThemeMode;
  readonly media?: MediaPreferences;
  /** Locale for `Intl` formatting; defaults to the runtime locale (§19.3). */
  readonly locale?: string;
  /** Resolved message catalogue; defaults to the built-in English one (§19.2). */
  readonly messages?: Readonly<Record<MessageKey, string>>;
}

export function PopupApp(props: PopupAppProps): ReactNode {
  return (
    <RuntimeClientProvider client={props.client}>
      <PopupRoot
        {...(props.mode !== undefined && { mode: props.mode })}
        {...(props.media !== undefined && { media: props.media })}
        {...(props.locale !== undefined && { locale: props.locale })}
        {...(props.messages !== undefined && { messages: props.messages })}
      />
    </RuntimeClientProvider>
  );
}
