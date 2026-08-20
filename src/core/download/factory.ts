/**
 * Module: core/download (system composition)
 * Purpose: Compose the download subsystem into a ready DownloadManager
 *          (PROJECT_BIBLE.md §10). Composition root the background surface uses,
 *          injecting the platform DownloadsAdapter (dependency inversion, §8.4).
 * Restrictions: Domain layer — wires pure components + the injected adapter; clock/
 *          RNG/timer injectable for determinism (defaults use the system).
 * Public API: DownloadSystemOptions, DownloadSystemConfiguration,
 *          ConfigurableDownloadManager, createDownloadSystem.
 */
import {
  DEFAULT_FILENAME_TEMPLATE,
  MAX_CONCURRENT_DOWNLOADS_DEFAULT,
  MAX_RETRIES_DEFAULT,
} from '@shared/constants';
import type { StreamQualityPreference } from '@shared/types';
import type { ConflictAction, DownloadsAdapter } from '@platform/downloads';
import type { StreamDeliveryAdapter } from '@platform/stream';
import { createConcurrencyLimiter } from '@core/download/concurrency/concurrency';
import { createFilenameGenerator } from '@core/download/filename/filename';
import type { DownloadManager } from '@core/download/manager';
import { createDownloadManager } from '@core/download/manager/manager';
import { createProgressTracker } from '@core/download/progress/progress';
import { createDownloadQueue } from '@core/download/queue/queue';
import type { RetryDecision, RetryPolicy } from '@core/download/retry';
import { createRetryPolicy } from '@core/download/retry/retry';
import type { DownloadQueue } from '@core/download/queue';
import type { HistoryService } from '@core/history';
import type { QueueRepository } from '@core/storage';

export interface DownloadSystemOptions {
  /** The platform downloads adapter — the ONLY route to the browser (§10.8). */
  readonly downloads: DownloadsAdapter;
  /** Durable queue store (omit → in-memory; §8.14). */
  readonly queueRepository?: QueueRepository;
  /**
   * A pre-built queue whose lifecycle the caller owns — created, hydrated, and
   * released by the composition root so the durable queue is reconstructed before
   * scheduling resumes (§8.9). Omit to have the system build its own queue over
   * `queueRepository`; existing callers are unaffected.
   */
  readonly queue?: DownloadQueue;
  /** Records completed/failed downloads (§4.11). */
  readonly history?: HistoryService;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly maxConcurrent?: number;
  readonly maxRetries?: number;
  readonly filenameTemplate?: string;
  readonly conflictAction?: ConflictAction;
  readonly downloadSubfolder?: string;
  /** Which rendition of a multi-quality stream to take (§10.6). */
  readonly streamQuality?: StreamQualityPreference;
  /**
   * Assembles non-encrypted HLS/DASH manifests into a local file (§10.6). Omitted,
   * stream items stay refused at validation, exactly as before.
   */
  readonly streamDelivery?: StreamDeliveryAdapter;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly generateId?: () => string;
  readonly scheduleTimer?: (delayMs: number, callback: () => void) => () => void;
}

/**
 * The user-configurable half of the system (PROJECT_BIBLE.md §4.9, §10.3, §10.4,
 * §10.7). Every field mirrors a setting; omitted fields are left as they are.
 */
export interface DownloadSystemConfiguration {
  readonly maxConcurrent?: number;
  readonly maxRetries?: number;
  readonly filenameTemplate?: string;
  readonly downloadSubfolder?: string;
  readonly streamQuality?: StreamQualityPreference;
}

/**
 * A manager whose user-configurable values can be re-applied while it runs. The
 * queue, the jobs in flight and every other behaviour are untouched: settings change
 * during a session and the running system has to follow them (§4.9), and recreating
 * the manager would drop the live queue (§10.2).
 */
export type ConfigurableDownloadManager = DownloadManager & {
  configure(configuration: DownloadSystemConfiguration): void;
};

/** A retry policy that delegates to whichever policy the current settings describe. */
function createAdjustableRetryPolicy(
  build: (maxAttempts: number) => RetryPolicy,
  initial: number,
): RetryPolicy & { setMaxAttempts(maxAttempts: number): void } {
  let inner = build(initial);
  return {
    get maxAttempts(): number {
      return inner.maxAttempts;
    },
    shouldRetry: (error, attempt): RetryDecision => inner.shouldRetry(error, attempt),
    setMaxAttempts(maxAttempts: number): void {
      inner = build(maxAttempts);
    },
  };
}

export function createDownloadSystem(options: DownloadSystemOptions): ConfigurableDownloadManager {
  const clock = options.clock ?? ((): number => Date.now());

  const queue =
    options.queue ??
    createDownloadQueue(
      options.queueRepository !== undefined ? { repository: options.queueRepository } : {},
    );
  const concurrency = createConcurrencyLimiter(
    options.maxConcurrent ?? MAX_CONCURRENT_DOWNLOADS_DEFAULT,
  );
  const buildRetryPolicy = (maxAttempts: number): RetryPolicy =>
    createRetryPolicy({
      maxAttempts,
      ...(options.random !== undefined && { random: options.random }),
      ...(options.baseDelayMs !== undefined && { baseDelayMs: options.baseDelayMs }),
      ...(options.maxDelayMs !== undefined && { maxDelayMs: options.maxDelayMs }),
    });
  const retryPolicy = createAdjustableRetryPolicy(
    buildRetryPolicy,
    options.maxRetries ?? MAX_RETRIES_DEFAULT,
  );
  const filename = createFilenameGenerator(clock);
  const progress = createProgressTracker(clock);

  // The manager reads these two per job, so keeping them behind getters is all a
  // live change needs — no manager state to refresh, nothing to restart (§10.7).
  let filenameTemplate = options.filenameTemplate ?? DEFAULT_FILENAME_TEMPLATE;
  let downloadSubfolder = options.downloadSubfolder ?? '';
  let streamQuality: StreamQualityPreference = options.streamQuality ?? 'highest';

  const manager = createDownloadManager({
    downloads: options.downloads,
    queue,
    concurrency,
    retryPolicy,
    filename,
    progress,
    clock,
    get filenameTemplate(): string {
      return filenameTemplate;
    },
    conflictAction: options.conflictAction ?? 'uniquify',
    get downloadSubfolder(): string {
      return downloadSubfolder;
    },
    get streamQuality(): StreamQualityPreference {
      return streamQuality;
    },
    ...(options.history !== undefined && { history: options.history }),
    ...(options.streamDelivery !== undefined && { streamDelivery: options.streamDelivery }),
    ...(options.generateId !== undefined && { generateId: options.generateId }),
    ...(options.scheduleTimer !== undefined && { scheduleTimer: options.scheduleTimer }),
  });

  return {
    ...manager,
    configure(configuration: DownloadSystemConfiguration): void {
      if (configuration.maxConcurrent !== undefined) {
        concurrency.setLimit(configuration.maxConcurrent);
      }
      if (configuration.maxRetries !== undefined) {
        retryPolicy.setMaxAttempts(configuration.maxRetries);
      }
      if (configuration.filenameTemplate !== undefined) {
        filenameTemplate = configuration.filenameTemplate;
      }
      if (configuration.downloadSubfolder !== undefined) {
        downloadSubfolder = configuration.downloadSubfolder;
      }
      if (configuration.streamQuality !== undefined) {
        streamQuality = configuration.streamQuality;
      }
    },
  };
}
