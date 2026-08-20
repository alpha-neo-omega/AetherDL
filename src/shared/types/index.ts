/**
 * Module: shared/types
 * Purpose: Cross-cutting type contracts shared by every layer (PROJECT_BIBLE.md
 *          §9.6 media model, §10.2 download task, §4.9 settings, §8.5 messaging).
 * Responsibilities: Define the normalized domain models and message contracts as
 *          pure types. Contains NO logic and NO implementations.
 * Restrictions: Leaf layer — depends only on sibling `shared/` modules (§8.16).
 * Dependencies: shared/result (AppError).
 * Public API: media, download, settings, history, and messaging type contracts.
 */
import type { AppError } from '../result';

// ---------------------------------------------------------------------------
// Media detection model (PROJECT_BIBLE.md §9.6, §9.8)
// ---------------------------------------------------------------------------

export type MediaKind = 'video' | 'audio' | 'stream' | 'image-sequence';

export type SupportStatus = 'supported' | 'unsupported';

export type QualityLabel =
  | '2160p'
  | '1440p'
  | '1080p'
  | '720p'
  | '480p'
  | '360p'
  | '240p'
  | '144p'
  | 'audio-only'
  | 'unknown';

/**
 * How the media is delivered (Phase 4 classification; additive, pending ADR-007).
 * `media-source` denotes MSE-backed media (a blob-family source, §5.4).
 */
export type DeliveryType =
  'html5' | 'direct' | 'progressive' | 'hls' | 'dash' | 'blob' | 'media-source';

export interface MediaVariant {
  readonly quality: QualityLabel;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateKbps?: number;
  readonly url: string;
  readonly sizeBytes?: number;
  readonly sizeEstimated?: boolean;
}

export interface MediaItem {
  readonly id: string;
  readonly kind: MediaKind;
  readonly status: SupportStatus;
  /** Present (machine + human readable) when `status` is `unsupported` (§6). */
  readonly unsupportedReason?: string;
  readonly title: string;
  readonly url: string;
  readonly originHost: string;
  readonly container?: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  readonly bitrateKbps?: number;
  readonly quality?: QualityLabel;
  readonly sizeBytes?: number;
  readonly sizeEstimated?: boolean;
  readonly variants?: readonly MediaVariant[];
  readonly detectedBy: string;
  readonly score: number;
  readonly discoveredAt: number;
  // --- Detection-provided detail (additive; pending ADR-007 ratification) ---
  /** The URL as originally observed, before normalization (§9.5). */
  readonly originalUrl?: string;
  /** Suggested filename derived from the source (§4.2); not the final saved name. */
  readonly filename?: string;
  /** Lowercase container extension, e.g. `mp4` (§5.1). */
  readonly extension?: string;
  /** Codec string when known from metadata, e.g. `avc1.640028` (§9.8). */
  readonly codec?: string;
  /** How the media is delivered (Phase 4 classification, §5.5). */
  readonly delivery?: DeliveryType;
  /** Opaque, non-PII detection metadata bag for diagnostics/UI hints (§4.2). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Download model (PROJECT_BIBLE.md §10.2)
// ---------------------------------------------------------------------------

export type TaskState =
  | 'queued'
  | 'preparing'
  | 'active'
  | 'paused'
  | 'retrying'
  | 'canceling'
  | 'canceled'
  | 'completed'
  | 'failed'
  | 'removed';

export interface DownloadTask {
  readonly id: string;
  readonly item: MediaItem;
  readonly state: TaskState;
  readonly filename: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly progress?: number;
  readonly attempt: number;
  readonly nativeDownloadId?: number;
  readonly error?: AppError;
  readonly createdAt: number;
  readonly updatedAt: number;
  // --- Phase 5 (download manager) additive fields ---
  /** Scheduling priority; higher runs first (FIFO by createdAt breaks ties). */
  readonly priority?: number;
  /** The generated name before collision resolution (§10.7). */
  readonly originalFilename?: string;
  /** When the transfer began (epoch ms), set on transition to `active`. */
  readonly startedAt?: number;
  /** When the job reached a terminal state (epoch ms). */
  readonly completedAt?: number;
  /** Opaque, non-PII job metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Settings model (PROJECT_BIBLE.md §4.9)
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';
export type DetectionSensitivity = 'conservative' | 'balanced' | 'aggressive';
export type HistoryRetention = 'forever' | '30d' | '90d' | 'session';
export type ReducedMotionPreference = 'system' | 'on' | 'off';

export interface Settings {
  readonly theme: ThemeMode;
  readonly maxConcurrentDownloads: number;
  readonly maxRetries: number;
  readonly filenameTemplate: string;
  readonly downloadSubfolder: string;
  readonly notifications: boolean;
  readonly keepHistory: boolean;
  readonly historyRetention: HistoryRetention;
  readonly duplicateWarnings: boolean;
  readonly contextMenu: boolean;
  readonly reducedMotion: ReducedMotionPreference;
  readonly language: string;
  readonly detectionSensitivity: DetectionSensitivity;
}

// ---------------------------------------------------------------------------
// History model (PROJECT_BIBLE.md §4.11)
// ---------------------------------------------------------------------------

export interface HistoryRecord {
  readonly id: string;
  readonly title: string;
  readonly kind: MediaKind;
  readonly container?: string;
  readonly sizeBytes?: number;
  readonly originHost: string;
  readonly timestamp: number;
  readonly outcome: 'completed' | 'failed';
  readonly filename: string;
}

// ---------------------------------------------------------------------------
// Messaging contracts (PROJECT_BIBLE.md §8.5)
// ---------------------------------------------------------------------------

export interface MessageExchange<Request, Response> {
  readonly request: Request;
  readonly response: Response;
}

/**
 * Wire mirror of a media-relevant DOM node, sent by the content script to the
 * background (§8.5, §8.10). Structurally identical to the detection engine's
 * `DomSignal`; declared here because cross-context message payloads live in the
 * leaf `shared/` layer (§8.16) and cannot import `core/`. The background maps + and
 * validates these into a detection `DetectionContext` at the trust boundary (§13.8).
 */
export interface WireDomSignal {
  readonly role: 'video' | 'audio' | 'source' | 'link';
  readonly tagName: string;
  readonly src?: string;
  readonly currentSrc?: string;
  readonly href?: string;
  readonly type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  readonly parentRole?: 'video' | 'audio' | 'source' | 'link';
  readonly title?: string;
  readonly codecs?: string;
  readonly mediaSource?: boolean;
  readonly encrypted?: boolean;
}

/** The content script's structured observation of one page/frame (§8.10). */
export interface DetectionReport {
  readonly pageUrl: string;
  readonly documentTitle?: string;
  readonly frameId?: number;
  readonly domSignals: readonly WireDomSignal[];
  readonly observedUrls: readonly string[];
}

/**
 * Wire snapshot of one job's transfer progress (§10.5). Deliberately compact:
 * cross-context messages carry small values and references, never bulk data
 * (§8.5 rule 6). Progress is honest — an unknown total omits `progress` rather
 * than fabricating a percentage (§2.8).
 */
export interface DownloadProgressSnapshot {
  readonly taskId: string;
  readonly state: TaskState;
  readonly filename: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly progress?: number;
}

/**
 * Wire snapshot of queue counts per lifecycle state, plus the total (§10.2).
 * Derived from {@link TaskState} so it cannot drift from the core queue's own
 * stats shape, which lives in `core/` and is unreachable from this leaf layer
 * (§8.16) — the same constraint that produced {@link WireDomSignal}.
 */
export type QueueStatsSnapshot = { readonly [K in TaskState]: number } & {
  readonly total: number;
};

/** Request shape shared by every single-job download command (§8.5). */
export interface TaskIdRequest {
  readonly taskId: string;
}

/**
 * Names of the download lifecycle events the background broadcasts to open
 * surfaces (§8.5, §10.2). The background forwards the Download Manager's own
 * events under these names; it never maintains a second event system.
 */
export type DownloadEventName =
  | 'download:queued'
  | 'download:preparing'
  | 'download:started'
  | 'download:progress'
  | 'download:completed'
  | 'download:failed'
  | 'download:cancelled'
  | 'retry:scheduled'
  | 'queue:paused'
  | 'queue:resumed'
  | 'queue:completed'
  | 'error';

/**
 * The one-way payload broadcast for each download lifecycle event (§8.5, §12.4).
 * Compact by design — surfaces pull full state with `download/query` (§8.5 rule 6).
 * Any carried `AppError` is stripped of `cause`/`context`, which are local dev
 * diagnostics and never cross a context boundary (§20.5).
 */
export interface DownloadEventBroadcast {
  readonly event: DownloadEventName;
  readonly task?: DownloadProgressSnapshot;
  readonly retry?: {
    readonly taskId: string;
    readonly attempt: number;
    readonly delayMs: number;
  };
  readonly summary?: {
    readonly completed: number;
    readonly failed: number;
    readonly canceled: number;
  };
  readonly error?: AppError;
}

// ---------------------------------------------------------------------------
// Stream assembly (PROJECT_BIBLE.md §10.6)
// ---------------------------------------------------------------------------

export interface StreamAssembleRequest {
  readonly manifestUrl: string;
  /** Optional ceiling; the assembler's own limit applies when omitted. */
  readonly maxTotalBytes?: number;
  /**
   * Identifies this assembly, so an abort stops the one it means. Two jobs can share
   * a manifest URL — the same stream downloaded twice — and keying on the URL alone
   * would let one cancel the other. Omitted, the host falls back to the URL.
   */
  readonly requestId?: string;
}

/** What the assembly host answers with. Encrypted manifests never get this far. */
export interface StreamAssembleResult {
  readonly url: string;
  readonly byteLength: number;
  /** The container the assembled bytes actually are (`ts` or `mp4`). */
  readonly extension: string;
  readonly mimeType: string;
  readonly segmentCount: number;
  /** Origins the assembly read from (§13.7 point-of-use host permissions). */
  readonly origins: readonly string[];
}

/** Broadcast while an assembly runs, so the queue can show real progress (§10.5). */
export interface StreamProgressBroadcast {
  readonly manifestUrl: string;
  /** Present when the caller identified its request; matched in preference to the URL. */
  readonly requestId?: string;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly bytesReceived: number;
}

/**
 * The typed message contract map. Extended, under change control, as message
 * families are implemented in later phases (§8.5). Phase 3 (reopened) adds the
 * `detection/*` runtime handlers (additive; the family already existed via
 * `detection/query`). Phase 5 (reopened) completes the `download/*` family the
 * background download runtime answers (additive; `download/enqueue` is unchanged).
 */
export interface MessageMap {
  readonly 'detection/query': MessageExchange<{ readonly tabId: number }, readonly MediaItem[]>;
  /** Content → background: report observations for a tab; runs detection. */
  readonly 'detection/run': MessageExchange<DetectionReport, readonly MediaItem[]>;
  /** Re-run detection on a tab's last-known observations, bypassing the cache. */
  readonly 'detection/refresh': MessageExchange<{ readonly tabId: number }, readonly MediaItem[]>;
  /** Drop a tab's cached detection results and stored observations. */
  readonly 'detection/clear': MessageExchange<{ readonly tabId: number }, void>;
  /** Enqueue detected media by identity key; the background resolves the items. */
  readonly 'download/enqueue': MessageExchange<{ readonly itemIds: readonly string[] }, void>;
  /** Cancel a job (prompt and idempotent, §10.10). */
  readonly 'download/cancel': MessageExchange<TaskIdRequest, void>;
  /** Manually retry a failed, retryable job (§4.5). */
  readonly 'download/retry': MessageExchange<TaskIdRequest, void>;
  /** Park a queued/active job (§10.2). */
  readonly 'download/pause': MessageExchange<TaskIdRequest, void>;
  /** Return a paused job to the queue (§10.2). */
  readonly 'download/resume': MessageExchange<TaskIdRequest, void>;
  /** Drop a job from the queue, cancelling it first when it is live (§10.2). */
  readonly 'download/remove': MessageExchange<TaskIdRequest, void>;
  /** Remove every non-transferring job from the queue (§4.4). */
  readonly 'download/clear': MessageExchange<void, void>;
  /** Read the whole queue — the single source of truth for download state (§4.4). */
  readonly 'download/query': MessageExchange<void, readonly DownloadTask[]>;
  /** Read compact progress for every job still in flight (§10.5). */
  readonly 'download/progress': MessageExchange<void, readonly DownloadProgressSnapshot[]>;
  /** Read queue counts by lifecycle state (§10.2). */
  readonly 'download/stats': MessageExchange<void, QueueStatsSnapshot>;
  /** Read the settings catalogue with its normative defaults applied (§4.9). */
  readonly 'settings/get': MessageExchange<void, Settings>;
  /** Apply a validated change; rejects the whole patch if any value is invalid. */
  readonly 'settings/update': MessageExchange<Partial<Settings>, Settings>;
  /** Restore every setting to its normative default (§4.9). */
  readonly 'settings/reset': MessageExchange<void, Settings>;
  /** Read local download history, newest first (§4.11). */
  readonly 'history/query': MessageExchange<void, readonly HistoryRecord[]>;
  /** Delete one history record (§4.11). */
  readonly 'history/delete': MessageExchange<{ readonly id: string }, void>;
  /** Erase all history (§14.4). */
  readonly 'history/clear': MessageExchange<void, void>;
  /** Export history as local JSON; the payload never leaves the device (§4.11). */
  readonly 'history/export': MessageExchange<void, string>;
  /**
   * Background → assembly host (Chromium offscreen document): assemble a non-DRM
   * HLS/DASH manifest and answer with a local URL the Downloads API can save
   * (§10.6). The bytes never cross this boundary — only the manifest URL going in
   * and a `blob:` URL coming back — because a runtime message is a poor byte pipe.
   */
  readonly 'stream/assemble': MessageExchange<StreamAssembleRequest, StreamAssembleResult>;
  /**
   * Readiness probe for the assembly host. Creating an offscreen document resolves
   * before its module script has run, so the caller polls this until the host
   * answers rather than sending work into a context with no listener yet.
   */
  readonly 'stream/ready': MessageExchange<void, boolean>;
  /** Cancel one in-flight assembly, by request id where the caller sent one (§10.10). */
  readonly 'stream/abort': MessageExchange<
    { readonly manifestUrl: string; readonly requestId?: string },
    void
  >;
  /** Revoke a previously returned assembly URL and drop its bytes (§8.9). */
  readonly 'stream/release': MessageExchange<{ readonly url: string }, void>;
}

export type MessageType = keyof MessageMap;
