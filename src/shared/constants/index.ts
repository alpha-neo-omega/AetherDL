/**
 * Module: shared/constants
 * Purpose: App-wide constant values referenced across layers (PROJECT_BIBLE.md
 *          §4.9 setting defaults, §5.1 supported formats, §12.1 budgets).
 * Responsibilities: Provide immutable constant data. No logic.
 * Restrictions: Leaf layer — no internal dependencies (§8.16).
 * Dependencies: none.
 * Public API: default values, supported-format lists, performance budgets.
 */

/** Default maximum concurrent downloads (PROJECT_BIBLE.md §10.3). */
export const MAX_CONCURRENT_DOWNLOADS_DEFAULT = 3;

/** Default maximum retry attempts (PROJECT_BIBLE.md §10.4). */
export const MAX_RETRIES_DEFAULT = 3;

/** Default filename template (PROJECT_BIBLE.md §10.7). */
export const DEFAULT_FILENAME_TEMPLATE = '{title}.{ext}';

/** Supported video container extensions (PROJECT_BIBLE.md §5.1). */
export const SUPPORTED_VIDEO_FORMATS: readonly string[] = [
  'mp4',
  'webm',
  'm4v',
  'mov',
  'avi',
  'mkv',
];

/** Supported audio container extensions (PROJECT_BIBLE.md §5.1). */
export const SUPPORTED_AUDIO_FORMATS: readonly string[] = [
  'mp3',
  'aac',
  'm4a',
  'flac',
  'wav',
  'ogg',
];

/** Gzipped bundle-size budgets in bytes (PROJECT_BIBLE.md §12.1). */
export const BUNDLE_SIZE_BUDGETS_GZ = {
  background: 150 * 1024,
  content: 40 * 1024,
  popup: 200 * 1024,
} as const;

/** Popup time-to-interactive budget in milliseconds (PROJECT_BIBLE.md §12.1). */
export const POPUP_TTI_BUDGET_MS = 150;

/** Detection latency budget in milliseconds (PROJECT_BIBLE.md §12.1). */
export const DETECTION_LATENCY_BUDGET_MS = 300;

/**
 * Broadcast channel announcing a tab's fresh detection results (§8.5). It lives in
 * the leaf layer because both the background that publishes it and the surfaces that
 * subscribe need the name, and a surface must not pull in background code to get it.
 */
export const DETECTION_FINISHED_CHANNEL = 'detection/finished';

/** Broadcast channel carrying download lifecycle events to surfaces (§8.5, §12.4). */
export const DOWNLOAD_EVENT_CHANNEL = 'download/event';

/**
 * Broadcast channel announcing an applied settings change so every open surface
 * reflects it live (§4.9, §13.3 of ARCHITECTURE.md — settings state is pushed).
 */
export const SETTINGS_CHANGED_CHANNEL = 'settings/changed';

/**
 * The content script's emitted filename, injected programmatically into the active
 * tab on a user gesture (§8.10 "programmatic inject (scripting)", §13.7 activeTab).
 * The build emits exactly this name (build/vite/config.ts), the packaging validator
 * requires it, and the background injects it — one name, one source.
 */
export const CONTENT_SCRIPT_FILE = 'content.js';

/**
 * Upper bound on the DOM signals one observation may carry (§9.10, §12.4). A
 * pathological page must not make the content script build — or the background
 * accept — an unbounded report. The content script stops scanning at this bound and
 * the background enforces the same number at the trust boundary (§13.8).
 */
export const MAX_DOM_SIGNALS = 500;

/** Upper bound on the observed URLs one observation may carry (§9.10, §13.8). */
export const MAX_OBSERVED_URLS = 500;
