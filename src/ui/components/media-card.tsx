/**
 * Module: ui/components (media card)
 * Purpose: The core UI unit — one detected media item with its metadata, actions,
 *          selection affordance and live queue state (PROJECT_BIBLE.md §11.6).
 * Restrictions: UI layer — presentational only. It renders ONLY metadata the
 *          detection engine supplied; absent fields are omitted rather than
 *          fabricated (§2.8, §4.2). Unsupported/protected media is clearly marked
 *          and its download action is disabled with the reason exposed (§6.3,
 *          §11.5). Every string arrives as a prop so components hold no hard-coded
 *          copy (§19.1). Status is never conveyed by colour alone (§17.4).
 * Public API: MediaCardLabels, MediaCardProps, MediaCard.
 */
import type { ReactNode } from 'react';
import { formatBytes, formatDuration } from '@shared/utils';
import type { DownloadTask, MediaItem, MediaKind, TaskState } from '@shared/types';
import { Button, IconButton } from './button';
import { Icon, type IconName } from './icons';
import { ProgressBar } from './progress-bar';

export interface MediaCardLabels {
  readonly download: string;
  readonly copyLink: string;
  readonly select: string;
  readonly unsupported: string;
  readonly estimated: string;
  readonly alreadyQueued: string;
  /** Field names for the metadata list, read by assistive tech (§17.5). */
  readonly fields: {
    readonly type: string;
    readonly quality: string;
    readonly resolution: string;
    readonly duration: string;
    readonly size: string;
    readonly host: string;
    readonly filename: string;
    readonly codec: string;
    readonly delivery: string;
  };
  readonly taskState: Readonly<Record<TaskState, string>>;
  /**
   * How each delivery type reads to a person. Without it the card printed the raw
   * enum (`hls`, `media-source`), which is neither English nor translatable (§19.1).
   */
  readonly delivery?: Readonly<Record<string, string>>;
  readonly progressLabel: string;
}

export interface MediaCardProps {
  readonly item: MediaItem;
  /** The item's queue entry, when it has one (§4.4 single source of truth). */
  readonly task?: DownloadTask;
  readonly selected: boolean;
  readonly onToggleSelected: (itemId: string) => void;
  readonly onDownload: (itemId: string) => void;
  readonly onCopyLink: (item: MediaItem) => void;
  readonly labels: MediaCardLabels;
  readonly locale?: string;
}

const KIND_ICON: Readonly<Record<MediaKind, IconName>> = {
  video: 'video',
  audio: 'audio',
  stream: 'stream',
  'image-sequence': 'image-sequence',
};

/** Queue states in which a fresh enqueue would duplicate live work (§4.6). */
const BUSY_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'preparing',
  'active',
  'paused',
  'retrying',
  'canceling',
]);

interface Fact {
  readonly label: string;
  readonly value: string;
}

function facts(item: MediaItem, labels: MediaCardLabels, locale?: string): readonly Fact[] {
  const { fields } = labels;
  const list: Fact[] = [];
  const push = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      list.push({ label, value });
    }
  };

  push(fields.type, item.container?.toUpperCase() ?? item.mimeType);
  push(
    fields.quality,
    item.quality !== undefined && item.quality !== 'unknown' ? item.quality : undefined,
  );
  push(
    fields.resolution,
    item.width !== undefined && item.height !== undefined
      ? `${item.width}×${item.height}`
      : undefined,
  );
  push(fields.duration, formatDuration(item.durationSec));
  // An estimated size says so in its field name too, so the marker is not a lone
  // glyph a screen reader would skip past (§4.2, §17.5).
  const size = formatBytes(item.sizeBytes, locale);
  const estimated = item.sizeEstimated === true;
  push(
    estimated ? `${fields.size} (${labels.estimated})` : fields.size,
    size === undefined ? undefined : estimated ? `~${size}` : size,
  );
  push(fields.host, item.originHost);
  push(fields.filename, item.filename);
  push(fields.codec, item.codec);
  // Localized where the caller supplied wording; the raw value only as a last resort,
  // which is still better than printing nothing.
  push(
    fields.delivery,
    item.delivery === undefined ? undefined : (labels.delivery?.[item.delivery] ?? item.delivery),
  );
  return list;
}

export function MediaCard(props: MediaCardProps): ReactNode {
  const { item, task, labels } = props;
  const unsupported = item.status !== 'supported';
  const busy = task !== undefined && BUSY_STATES.has(task.state);
  const disabledReason = unsupported
    ? (item.unsupportedReason ?? labels.unsupported)
    : busy
      ? labels.alreadyQueued
      : undefined;

  return (
    <li className={`adl-card${unsupported ? ' adl-card--unsupported' : ''}`}>
      <div className="adl-card__lead">
        <input
          type="checkbox"
          className="adl-card__select"
          checked={props.selected}
          disabled={unsupported}
          onChange={() => {
            props.onToggleSelected(item.id);
          }}
          aria-label={`${labels.select}: ${item.title}`}
        />
        <Icon name={KIND_ICON[item.kind]} size={22} className="adl-card__kind" />
      </div>

      <div className="adl-card__body">
        <h3 className="adl-card__title" title={item.title}>
          {item.title}
        </h3>

        {unsupported && (
          <p className="adl-card__badge">
            <Icon name="blocked" size={14} />
            <span>
              {labels.unsupported}
              {item.unsupportedReason !== undefined ? ` — ${item.unsupportedReason}` : ''}
            </span>
          </p>
        )}

        <dl className="adl-card__facts">
          {facts(item, labels, props.locale).map((fact) => (
            <div className="adl-card__fact" key={fact.label}>
              <dt className="adl-visually-hidden">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>

        {task !== undefined && (
          <div className="adl-card__task">
            <p className="adl-card__status">
              <Icon
                name={
                  task.state === 'completed'
                    ? 'done'
                    : task.state === 'failed'
                      ? 'error'
                      : 'download'
                }
                size={14}
              />
              <span>{labels.taskState[task.state]}</span>
            </p>
            {busy && (
              <ProgressBar
                label={`${labels.progressLabel}: ${item.title}`}
                {...(task.progress !== undefined && { value: task.progress })}
              />
            )}
          </div>
        )}
      </div>

      <div className="adl-card__actions">
        <Button
          variant="filled"
          icon="download"
          disabled={unsupported || busy}
          {...(disabledReason !== undefined && { disabledReason })}
          ariaLabel={`${labels.download}: ${item.title}`}
          onClick={() => {
            props.onDownload(item.id);
          }}
        >
          {labels.download}
        </Button>
        <IconButton
          icon="copy"
          label={`${labels.copyLink}: ${item.title}`}
          onClick={() => {
            props.onCopyLink(item);
          }}
        />
      </div>
    </li>
  );
}
