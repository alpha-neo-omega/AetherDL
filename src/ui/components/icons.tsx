/**
 * Module: ui/components (icons)
 * Purpose: The single, local, Material-style icon set (PROJECT_BIBLE.md §11.10).
 *          Shipped as inline SVG — no remote requests, no icon font (§13.2, §14.3).
 * Restrictions: UI layer — presentational only. Icons are decorative and marked
 *          `aria-hidden`; the control that owns them carries the accessible name
 *          (§17.5). No colour is hard-coded: every glyph inherits `currentColor`
 *          from its token-styled parent (§11.13, §11.17).
 * Public API: IconName, Icon.
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'video'
  | 'audio'
  | 'stream'
  | 'image-sequence'
  | 'download'
  | 'copy'
  | 'cancel'
  | 'retry'
  | 'pause'
  | 'resume'
  | 'remove'
  | 'clear'
  | 'blocked'
  | 'done'
  | 'error'
  | 'search';

/** 24×24 path data on a 0 0 24 24 viewBox, filled with `currentColor`. */
const PATHS: Readonly<Record<IconName, string>> = {
  video:
    'M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm15 3.5 3-2v9l-3-2v-5Z',
  audio: 'M12 3v10.6a4 4 0 1 0 2 3.4V7h4V3h-6Z',
  stream:
    'M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm5.7-3.7 1.4-1.4a9 9 0 0 1 0 14.2l-1.4-1.4a7 7 0 0 0 0-11.4Zm-11.4 0a7 7 0 0 0 0 11.4l-1.4 1.4a9 9 0 0 1 0-14.2l1.4 1.4Z',
  'image-sequence': 'M3 5h14v12H3V5Zm16 2h2v12H7v-2h12V7Zm-13 8h10l-3.5-4.5-2.5 3-1.5-2L6 15Z',
  download: 'M12 3v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L10 12.2V3h2ZM4 19h16v2H4v-2Z',
  copy: 'M9 2h9a2 2 0 0 1 2 2v11h-2V4H9V2ZM6 6h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z',
  cancel:
    'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm4.2 4.4L6.4 16.2A8 8 0 0 0 17.6 5l-1.4 1.4ZM12 4a8 8 0 0 0-6.2 13l11.2-11.2A8 8 0 0 0 12 4Z',
  retry: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z',
  pause: 'M7 5h4v14H7V5Zm6 0h4v14h-4V5Z',
  resume: 'M8 5v14l11-7L8 5Z',
  remove: 'M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 12H7L6 9Z',
  clear: 'M5 6h14v2H5V6Zm2 4h10l-1 10H8L7 10Zm2-7h6v2H9V3Z',
  blocked:
    'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 0 0-6.3 12.9L16.9 5.7A8 8 0 0 0 12 4Zm6.3 3.1L7.1 18.3A8 8 0 0 0 18.3 7.1Z',
  done: 'M9.5 17.6 4 12.1l1.4-1.4 4.1 4.1 9.1-9.1L20 7.1 9.5 17.6Z',
  error: 'M12 2 1 21h22L12 2Zm1 14v2h-2v-2h2Zm0-8v6h-2V8h2Z',
  search:
    'M10 3a7 7 0 1 1-4.2 12.6l-2.1 2.1-1.4-1.4 2.1-2.1A7 7 0 0 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
};

export interface IconProps {
  readonly name: IconName;
  /** Square size in pixels; defaults to the 18px inline size used by controls. */
  readonly size?: number;
  readonly className?: string;
}

export function Icon(props: IconProps): ReactNode {
  const size = props.size ?? 18;
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
