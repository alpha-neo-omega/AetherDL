/**
 * Module: runtime/background/runtime
 * Purpose: The background detection runtime (PROJECT_BIBLE.md §8.9, §9.1) — the
 *          composition that wires the EXISTING detection engine to platform services:
 *          typed message handlers, tab/navigation lifecycle, per-tab runtime state,
 *          badge, cache invalidation, and a single forwarded event stream. It uses
 *          the detection engine exactly as implemented (no detector/pipeline changes).
 * Restrictions: Runtime layer — thin orchestration; browser access via the injected
 *          Browser facade only (§8.4); no `chrome`/`browser` globals. Handlers are
 *          defensive and idempotent (§20.7); every listener is detached on dispose.
 * Public API: RuntimeEventMap, BackgroundRuntime, BackgroundRuntimeDeps,
 *          createBackgroundRuntime.
 */
import type { Browser } from '@platform/browser';
import type { DetectorManager } from '@core/detection/manager';
import type { AppError } from '@shared/result';
import { PlatformError, RuntimeError } from '@shared/result/errors';
import type { DetectionReport, MediaItem } from '@shared/types';
import { CONTENT_SCRIPT_FILE, DETECTION_FINISHED_CHANNEL } from '@shared/constants';
import { TypedEventEmitter, type Unsubscribe } from '@shared/utils';
import { createBadgeController, type BadgeController } from '@runtime/background/badge';
import { buildDetectionContext, isDetectionReport } from '@runtime/background/context';
import { createRuntimeState, supportedCount, type RuntimeState } from '@runtime/background/state';

/**
 * Broadcast channel (background → surfaces) announcing a tab's fresh results.
 * Re-exported from the leaf layer so a surface can subscribe without importing
 * background code (§8.16); the name and this import path are unchanged.
 */
export { DETECTION_FINISHED_CHANNEL } from '@shared/constants';

/** Runtime lifecycle + forwarded detection events (single stream, §8.5). */
export type RuntimeEventMap = {
  readonly 'runtime:initialized': [{ readonly startedAt: number }];
  readonly 'detection:started': [{ readonly tabId: number }];
  readonly 'detection:finished': [
    { readonly tabId: number; readonly items: readonly MediaItem[]; readonly fromCache: boolean },
  ];
  readonly 'media:detected': [MediaItem];
  readonly 'cache:hit': [{ readonly tabId: number }];
  readonly 'cache:miss': [{ readonly tabId: number }];
  readonly 'detection:failed': [{ readonly tabId: number | undefined; readonly error: AppError }];
  readonly 'tab:changed': [{ readonly tabId: number }];
  readonly navigation: [{ readonly tabId: number; readonly url: string | undefined }];
  readonly error: [AppError];
};

export interface BackgroundRuntime {
  /** Register all listeners + handlers (synchronously at top level, §8.9). */
  start(): void;
  on<K extends keyof RuntimeEventMap>(
    event: K,
    listener: (...args: RuntimeEventMap[K]) => void,
  ): Unsubscribe;
  /** Read-only access to runtime state (for surfaces/diagnostics). */
  readonly state: RuntimeState;
  /** Detach every listener/handler and dispose the engine + badge (§12.8). */
  dispose(): Promise<void>;
}

export interface BackgroundRuntimeDeps {
  readonly browser: Browser;
  readonly engine: DetectorManager;
  readonly clock?: () => number;
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Safely extract a valid tab id from an untrusted request payload (§13.8). */
function extractTabId(request: unknown): number | undefined {
  const tabId = (request as { readonly tabId?: unknown } | null | undefined)?.tabId;
  return isTabId(tabId) ? tabId : undefined;
}

function toAppError(cause: unknown): AppError {
  if (cause instanceof PlatformError) {
    return cause.toAppError();
  }
  return new RuntimeError('Background runtime error', {
    code: 'runtime-detection-failed',
    messageKey: 'error.runtime.detection',
    cause,
  }).toAppError();
}

export function createBackgroundRuntime(deps: BackgroundRuntimeDeps): BackgroundRuntime {
  const { browser, engine } = deps;
  const clock = deps.clock ?? ((): number => Date.now());
  const emitter = new TypedEventEmitter<RuntimeEventMap>();
  const state = createRuntimeState({ clock });
  const badge: BadgeController = createBadgeController({
    action: browser.action,
    onError: (cause) => emitter.emit('error', toAppError(cause)),
  });

  const unsubscribes: Unsubscribe[] = [];
  let started = false;
  let disposed = false;

  // Monotonic per-tab run token. Bumped on every run start and on any
  // invalidation (navigation/clear); a run only commits if its token is still
  // current, so a stale in-flight result never overwrites newer state (§10.2).
  const runTokens = new Map<number, number>();
  const bumpToken = (tabId: number): number => {
    const next = (runTokens.get(tabId) ?? 0) + 1;
    runTokens.set(tabId, next);
    return next;
  };

  const broadcastFinished = (tabId: number, items: readonly MediaItem[]): void => {
    void browser.messaging
      .broadcast(DETECTION_FINISHED_CHANNEL, { tabId, itemCount: supportedCount(items) })
      .catch(() => undefined);
  };

  /** Run detection for a tab from a report; updates state, badge, and broadcasts. */
  const runDetection = async (
    tabId: number,
    report: DetectionReport,
    source: 'dom' | 'manual',
  ): Promise<readonly MediaItem[]> => {
    state.setReport(tabId, report);
    state.setStatus(tabId, 'running');
    state.beginOperation(tabId);
    const token = bumpToken(tabId);
    try {
      const context = buildDetectionContext(report, tabId, source, clock());
      const items = await engine.detect(context);
      // A newer run or an invalidation (navigation/clear) superseded this one while
      // detectors ran — drop the stale result rather than clobber current state.
      if (runTokens.get(tabId) !== token) {
        return items;
      }
      state.recordRun();
      state.setItems(tabId, items);
      void badge.set(tabId, supportedCount(items));
      broadcastFinished(tabId, items);
      return items;
    } catch (cause) {
      if (runTokens.get(tabId) !== token) {
        return [];
      }
      state.setStatus(tabId, 'failed');
      state.recordError();
      const error = toAppError(cause);
      emitter.emit('detection:failed', { tabId, error });
      emitter.emit('error', error);
      return [];
    } finally {
      state.endOperation(tabId);
    }
  };

  /**
   * Put the content script into a tab so it observes and reports (§8.10). Reached
   * only from `detection/refresh`, which a surface sends after a user gesture — that
   * gesture is what grants `activeTab` for the tab (§13.7); no standing host
   * permission is used or requested. Injection is idempotent from the caller's point
   * of view: re-injecting simply re-runs the observer on the current DOM.
   */
  const injectObserver = async (tabId: number): Promise<void> => {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      });
    } catch (cause) {
      // A tab the extension may not touch (browser UI pages, the store, a tab that
      // closed mid-flight) simply yields no observations; the refresh still answers
      // from what is already known (§20.7).
      emitter.emit('error', toAppError(cause));
    }
  };

  const clearTab = (tabId: number): void => {
    bumpToken(tabId);
    engine.invalidate(tabId);
    state.clearDetection(tabId);
    void badge.clear(tabId);
  };

  /** Fully drop a gone tab: invalidate its in-flight run, cache, state, and badge. */
  const dropTab = (tabId: number): void => {
    runTokens.delete(tabId); // a still-in-flight run for this tab fails its token check
    engine.invalidate(tabId);
    state.removeTab(tabId);
    badge.forget(tabId);
  };

  const onNavigate = (tabId: number, url: string | undefined): void => {
    // Navigation invalidates the tab's cached detection; the content script
    // re-observes the new page and reports fresh signals (§9.9, §8.10). Bumping the
    // token cancels any in-flight run for the previous page.
    bumpToken(tabId);
    engine.invalidate(tabId);
    state.setUrl(tabId, url);
    state.clearDetection(tabId);
    void badge.set(tabId, 0);
    emitter.emit('navigation', { tabId, url });
  };

  const forwardEngineEvents = (): void => {
    unsubscribes.push(
      engine.on('detection:started', (context) => {
        emitter.emit('detection:started', { tabId: context.tabId });
      }),
      engine.on('detection:finished', (finished) => {
        emitter.emit('detection:finished', {
          tabId: finished.context.tabId,
          items: finished.items,
          fromCache: finished.fromCache,
        });
      }),
      engine.on('media:detected', (item) => {
        emitter.emit('media:detected', item);
      }),
      engine.on('cache:hit', (payload) => {
        emitter.emit('cache:hit', payload);
      }),
      engine.on('cache:miss', (payload) => {
        emitter.emit('cache:miss', payload);
      }),
      engine.on('error', (error) => {
        state.recordError();
        emitter.emit('error', error);
      }),
    );
  };

  const registerMessageHandlers = (): void => {
    const bus = browser.messaging;
    unsubscribes.push(
      // Content → background: observations for the active tab (activeTab model,
      // §13.7 — a content script only runs in the active tab, so it attributes here).
      // The payload is untrusted (§13.8): reject a malformed report outright.
      bus.on('detection/run', async (report) => {
        if (!isDetectionReport(report)) {
          return [];
        }
        const active = await browser.tabs.getActive();
        if (active?.id === undefined) {
          return [];
        }
        return runDetection(active.id, report, 'dom');
      }),
      // Re-run detection on a tab's last-known observations, bypassing the cache.
      bus.on('detection/refresh', async (request) => {
        const tabId = extractTabId(request);
        if (tabId === undefined) {
          return [];
        }
        // Inject the observer first: a tab that has never been observed has no
        // report to re-run, and this is the gesture-backed moment the extension is
        // allowed to touch the page (§8.10, §13.7). Fresh observations arrive as
        // their own `detection/run` and are broadcast to open surfaces (§8.5).
        await injectObserver(tabId);
        const report = state.getReport(tabId);
        if (report === undefined) {
          return state.getItems(tabId);
        }
        engine.invalidate(tabId);
        return runDetection(tabId, report, 'manual');
      }),
      // Return a tab's last detected items (from the runtime cache, §8.7).
      bus.on('detection/query', (request) => {
        const tabId = extractTabId(request);
        return tabId === undefined ? [] : state.getItems(tabId);
      }),
      // Drop a tab's cached results + stored observations.
      bus.on('detection/clear', (request) => {
        const tabId = extractTabId(request);
        if (tabId !== undefined) {
          clearTab(tabId);
        }
      }),
    );
  };

  const registerTabListeners = (): void => {
    const { tabs } = browser;
    unsubscribes.push(
      tabs.onActivated((tabId) => {
        state.setActiveTab(tabId);
        const tab = state.ensureTab(tabId);
        void badge.set(tabId, tab.itemCount);
        emitter.emit('tab:changed', { tabId });
      }),
      tabs.onCreated((tab) => {
        state.ensureTab(tab.id, tab.url);
      }),
      // A URL change is a navigation for ANY scheme (including about:/chrome://) —
      // clear the tab's stale detection/badge. onNavigated (http(s) only) is not
      // sufficient because leaving a media page for a non-http(s) page must also
      // clear. Status-only updates (unchanged url) are ignored.
      tabs.onUpdated((tab) => {
        const previous = state.getTab(tab.id)?.url;
        if (tab.url !== undefined && tab.url !== previous) {
          onNavigate(tab.id, tab.url);
        } else if (tab.url !== undefined) {
          // Status-only update on the same URL — keep it; never null a known URL.
          state.setUrl(tab.id, tab.url);
        }
      }),
      tabs.onRemoved((tabId) => {
        dropTab(tabId);
      }),
      tabs.onAttached((tabId) => {
        state.ensureTab(tabId);
      }),
      tabs.onDetached(() => {
        // The tab still exists (moving windows); retain its state.
      }),
      tabs.onReplaced((replacement) => {
        dropTab(replacement.removedTabId);
        state.ensureTab(replacement.addedTabId);
      }),
    );
  };

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      forwardEngineEvents();
      registerMessageHandlers();
      registerTabListeners();
      emitter.emit('runtime:initialized', { startedAt: state.health().startedAt });
    },

    on<K extends keyof RuntimeEventMap>(
      event: K,
      listener: (...args: RuntimeEventMap[K]) => void,
    ): Unsubscribe {
      return emitter.on(event, listener);
    },

    state,

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
      badge.dispose();
      emitter.clear();
      await engine.dispose();
    },
  };
}
