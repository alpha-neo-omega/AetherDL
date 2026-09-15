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
import type { DetectionContext } from '@core/detection/pipeline';
import type { ResourceProbe } from '@core/detection/probe';
import {
  buildDetectionContext,
  frameOriginsFrom,
  isDetectionReport,
  observedResourcesFrom,
} from '@runtime/background/context';
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
  /**
   * Identifies resources the page fetched, by reading their first bytes (§9.1,
   * ADR-012). Omitted, detection works exactly as it did before: from the DOM alone,
   * which cannot see a stream a player fetched with script.
   */
  readonly probe?: ResourceProbe;
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
  /** Page URL whose frames have already been reached, per tab. */
  /**
   * Tabs whose frames have been injected for the page they are currently on. A SET,
   * not a url map: the guard is about the tab's page, and keying it on the url of
   * whichever frame reported made two frames alternate forever — see `observeFrames`.
   */
  const framesObserved = new Set<number>();
  /**
   * The set of identified resources the last enriched pass ran over, per tab. Compared
   * rather than recomputed, so an unchanged set costs nothing (§12.1).
   */
  const enrichSignatures = new Map<number, string>();
  const bumpToken = (tabId: number): number => {
    const next = (runTokens.get(tabId) ?? 0) + 1;
    runTokens.set(tabId, next);
    return next;
  };

  /**
   * Whether a second pass actually changed anything.
   *
   * By identity, not by count: a probe that replaces one item with another leaves the
   * count alone, and the surface still needs to hear about it (§9.5).
   */
  const sameItems = (left: readonly MediaItem[], right: readonly MediaItem[]): boolean => {
    if (left.length !== right.length) {
      return false;
    }
    const ids = new Set(right.map((item) => item.id));
    return left.every((item) => ids.has(item.id));
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
    const changed = state.setReport(tabId, report);
    observeFrames(tabId, report);
    const token = bumpToken(tabId);
    // What was identified for this page earlier is part of what the page HAS, even
    // when the timeline it was read from has since evicted it (§4.1). Supplying it
    // to the first pass is also what keeps a stream card from blinking out and back
    // every time the popup is opened.
    const known = state.getResources(tabId);
    const base = buildDetectionContext(report, tabId, source, clock());
    const context = known.length > 0 ? { ...base, networkResources: known } : base;

    // A page that is merely PLAYING mutates several times a second — a ticking time
    // display is a childList mutation — and the content script re-reports on each. An
    // identical report cannot yield a different DOM result, and the pipeline measured
    // at 7 ms median / 36 ms worst was being run twice for every one of them, on the
    // user's machine, next to the video that is decoding (§12.1, §12.4).
    //
    // The probe still gets its turn: it works through a few URLs per pass, so repeated
    // reports are how a long list eventually gets identified. What is skipped is only
    // the part that provably cannot have changed.
    if (!changed && source === 'dom' && state.getTab(tabId)?.status === 'detected') {
      const settled = state.getItems(tabId);
      void enrich(tabId, report, context, settled, token);
      return settled;
    }

    state.setStatus(tabId, 'running');
    state.beginOperation(tabId);
    try {
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
      // What the page FETCHED is only a list of URLs until something reads the bytes:
      // a disguised playlist is indistinguishable from a stylesheet by name alone
      // (ADR-012). That means network requests, so it happens AFTER the DOM result has
      // already been committed and broadcast — detection latency is a budget (§12.1,
      // §12.9) and must not wait on a third-party host.
      void enrich(tabId, report, context, items, token);
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
   * Second pass: identify what the page fetched, and re-run detection if that adds
   * anything.
   *
   * Deliberately fire-and-forget. It commits only if its tab's token is still current,
   * so a navigation or a newer report discards it exactly like any other stale run
   * (§10.2). A probe that finds nothing costs one re-run of nothing: the pass returns
   * early rather than re-detecting on an unchanged context.
   */
  const enrich = async (
    tabId: number,
    report: DetectionReport,
    context: DetectionContext,
    previous: readonly MediaItem[],
    token: number,
  ): Promise<void> => {
    const probe = deps.probe;
    if (probe === undefined || runTokens.get(tabId) !== token) {
      return;
    }
    const observed = observedResourcesFrom(report, context.pageUrl);
    if (observed.length === 0) {
      return;
    }
    try {
      const found = await probe.identify(observed);
      if (found.length === 0 || runTokens.get(tabId) !== token) {
        return;
      }
      state.rememberResources(tabId, found);
      const networkResources = state.getResources(tabId);
      // The probe answers from its cache for a URL it has already read, so `found` is
      // non-empty on every pass once anything has been identified — including the
      // thousands of passes where it identified nothing NEW. Detecting again on those
      // is the second half of the same waste the first pass just avoided (§12.1).
      const signature = networkResources.map((resource) => resource.url).join('\n');
      if (enrichSignatures.get(tabId) === signature) {
        return;
      }
      enrichSignatures.set(tabId, signature);
      // The cache is keyed per tab and would answer with the first pass's result; the
      // enriched context is a different question (§9.9).
      engine.invalidate(tabId);
      const items = await engine.detect({ ...context, networkResources });
      if (runTokens.get(tabId) !== token || sameItems(items, previous)) {
        return;
      }
      state.setItems(tabId, items);
      void badge.set(tabId, supportedCount(items));
      broadcastFinished(tabId, items);
    } catch (cause) {
      // Identification is best-effort. A host that refuses is the normal case, not a
      // fault, and must not reach the user as an error (§20.7).
      emitter.emit('error', toAppError(cause));
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
      // The top document first, and awaited: it is the fast, always-permitted case, and
      // the caller's refresh should not wait on anything slower.
      await browser.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      });
      // Frames are reached separately, and only when a page turns out to have any —
      // see `observeFrames`.
    } catch (cause) {
      // A tab the extension may not touch (browser UI pages, the store, a tab that
      // closed mid-flight) simply yields no observations; the refresh still answers
      // from what is already known (§20.7).
      emitter.emit('error', toAppError(cause));
    }
  };

  /**
   * Reach into a page's frames, once per page, and only when the page said it has any.
   *
   * A video host routinely wraps its player in an `/embed/` iframe: the top document
   * then holds no `<video>` at all, and the playlist is fetched inside the frame where
   * the top frame's Resource Timing cannot see it (§8.10, ADR-012). Reaching into
   * frames is markedly slower on some engines, though, and paying it on every page —
   * the overwhelming majority of which have no frames worth reading — measurably
   * starved the rest of the runtime, so it is asked for only when it can pay off.
   *
   * Best effort by design: frames the extension may not touch are skipped by the
   * browser, and a frame's observations arrive as their own report when they arrive.
   *
   * "Once per page" is keyed on the TAB's page, not on the url of whichever frame
   * happened to report. Keyed on the frame, two frames that each contain an iframe
   * alternate — and every alternation re-injected into every frame in the tab. Because
   * re-injection also asks each running frame to report again, each injection produced
   * the next alternating report: a closed loop that pegged a core for as long as the
   * page kept reporting, which is the whole time a video plays (§12.1).
   */
  const observeFrames = (tabId: number, report: DetectionReport): void => {
    if ((report.frameCount ?? 0) <= 0) {
      return;
    }
    if (framesObserved.has(tabId)) {
      return;
    }
    framesObserved.add(tabId);
    void browser.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: [CONTENT_SCRIPT_FILE] })
      .catch(() => undefined);
  };

  const clearTab = (tabId: number): void => {
    bumpToken(tabId);
    enrichSignatures.delete(tabId);
    engine.invalidate(tabId);
    state.clearDetection(tabId);
    void badge.clear(tabId);
  };

  /** Fully drop a gone tab: invalidate its in-flight run, cache, state, and badge. */
  const dropTab = (tabId: number): void => {
    framesObserved.delete(tabId);
    enrichSignatures.delete(tabId);
    runTokens.delete(tabId); // a still-in-flight run for this tab fails its token check
    engine.invalidate(tabId);
    state.removeTab(tabId);
    badge.forget(tabId);
  };

  const onNavigate = (tabId: number, url: string | undefined): void => {
    // A new page means new resources; what was identified for the old one is noise.
    deps.probe?.forget();
    framesObserved.delete(tabId);
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
        //
        // Frames are re-entered on a refresh even if this page's frames were already
        // tried: the usual reason a surface refreshes is that something CHANGED about
        // what may be entered — the user just opted a site in — and the once-per-page
        // guard exists to keep automatic passes cheap, not to outlast a new grant.
        framesObserved.delete(tabId);
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
      // Answered for the offscreen document, which assembles streams without reaching
      // the permissions API itself (§7.4). A read, never a request: nothing is granted
      // by asking, and the answer only decides whether a failure is worth retrying.
      bus.on('permissions/contains', async (request) => {
        const origins =
          typeof request === 'object' && request !== null
            ? (request as Record<string, unknown>)['origins']
            : undefined;
        if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
          return false;
        }
        try {
          return await browser.permissions.containsHosts(origins as readonly string[]);
        } catch {
          return false;
        }
      }),
      // The origins this tab embeds players from, for a surface to offer (§13.7).
      // Answering names an origin; it grants nothing and requests nothing.
      bus.on('detection/embeds', (request) => {
        const tabId = extractTabId(request);
        if (tabId === undefined) {
          return [];
        }
        const report = state.getReport(tabId);
        return report === undefined ? [] : frameOriginsFrom(report);
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
