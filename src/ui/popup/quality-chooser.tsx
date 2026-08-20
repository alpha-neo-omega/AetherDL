/**
 * Module: ui/popup (stream quality chooser)
 * Purpose: Let the user pick which rendition of a stream to download
 *          (PROJECT_BIBLE.md §10.6, §11.6). A stream is not one file: it is a list of
 *          copies at different sizes, and until now the download took the biggest one
 *          without asking — which for real manifests means a 4K, 15 Mbps copy of a
 *          clip the user wanted at 720p.
 * Restrictions: UI layer — presentational. It renders the renditions the background
 *          reported and reports back the one that was clicked; it reads no manifest,
 *          fetches nothing, and decides nothing about quality itself (§8.1, §13.2).
 *          Every string arrives as a prop (§19.1). It is a modal dialog, so it is
 *          labelled, closes on Escape, and takes focus on open (§17.2, §17.5).
 * Public API: QualityChooserLabels, QualityChooserProps, describeRendition,
 *          QualityChooserDialog.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { StreamRenditionSnapshot } from '@shared/types';
import { Button } from '@ui/components';

export interface QualityChooserLabels {
  readonly title: string;
  readonly loading: string;
  readonly empty: string;
  readonly cancel: string;
  /** Marks the rendition the current preference would have taken anyway. */
  readonly preferred: string;
  readonly audioTrack: string;
}

export interface QualityChooserProps {
  readonly title: string;
  readonly status: 'loading' | 'ready';
  readonly renditions: readonly StreamRenditionSnapshot[];
  readonly labels: QualityChooserLabels;
  readonly onPick: (renditionId: string) => void;
  readonly onClose: () => void;
}

/** Megabits per second, one decimal — how bitrate is written on every player UI. */
function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${String(Math.round(bitsPerSecond / 1000))} kbps`;
}

/**
 * How one rendition reads to a person: its height when it declared one, its bitrate,
 * and its codec. Nothing is invented — a manifest that declares only a bandwidth is
 * described by that bandwidth alone (§2.8).
 */
export function describeRendition(rendition: StreamRenditionSnapshot): string {
  const parts: string[] = [];
  if (rendition.height !== undefined) {
    parts.push(`${String(rendition.height)}p`);
  } else if (rendition.width !== undefined) {
    parts.push(`${String(rendition.width)} px wide`);
  }
  if (rendition.bandwidth !== undefined) {
    parts.push(formatBitrate(rendition.bandwidth));
  }
  if (rendition.codecs !== undefined && rendition.codecs !== '') {
    parts.push(rendition.codecs);
  }
  return parts.length > 0 ? parts.join(' · ') : rendition.id;
}

export function QualityChooserDialog(props: QualityChooserProps): ReactNode {
  const { labels } = props;
  const dialog = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog on open, and Escape closes it: a modal that traps
  // neither focus nor Escape is a modal only to sighted mouse users (§17.2).
  useEffect(() => {
    const node = dialog.current;
    if (node === null) {
      return undefined;
    }
    const focusable = node.querySelector<HTMLElement>('button');
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [props.onClose, props.status]);

  // Only video renditions are choices; an audio track is what gets joined in, not an
  // alternative to the picture, so it is listed as information and not as a button.
  const choices = props.renditions.filter((rendition) => rendition.kind === 'video');
  const audio = props.renditions.filter((rendition) => rendition.kind === 'audio');

  return (
    <div className="adl-modal" role="presentation">
      <div
        className="adl-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adl-quality-title"
        ref={dialog}
      >
        <h2 className="adl-modal__title" id="adl-quality-title">
          {labels.title}
        </h2>
        <p className="adl-modal__subtitle">{props.title}</p>

        {props.status === 'loading' && <p className="adl-modal__status">{labels.loading}</p>}

        {props.status === 'ready' && choices.length === 0 && (
          <p className="adl-modal__status">{labels.empty}</p>
        )}

        {choices.length > 0 && (
          <ul className="adl-modal__list">
            {choices.map((rendition) => (
              <li key={rendition.id}>
                <button
                  type="button"
                  className="adl-quality"
                  onClick={() => {
                    props.onPick(rendition.id);
                  }}
                >
                  <span className="adl-quality__label">{describeRendition(rendition)}</span>
                  {rendition.isPreferred && (
                    <span className="adl-quality__badge">{labels.preferred}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {audio.length > 0 && (
          <p className="adl-modal__note">
            {labels.audioTrack}: {audio.map(describeRendition).join(', ')}
          </p>
        )}

        <div className="adl-modal__actions">
          <Button variant="text" onClick={props.onClose}>
            {labels.cancel}
          </Button>
        </div>
      </div>
    </div>
  );
}
