/**
 * Module: runtime/background/state
 * Purpose: Deterministic in-memory runtime state for the background surface
 *          (PROJECT_BIBLE.md §8.7, §8.9): active tabs, per-tab detection status,
 *          last observations (for refresh), connected content scripts, outstanding
 *          detection operations, and runtime health. Reconstructable/ephemeral —
 *          holds no critical durable state (§8.9).
 * Restrictions: Runtime layer. Pure in-memory; clock injected for determinism. No
 *          browser globals.
 * Public API: TabDetectionStatus, TabRuntimeState, RuntimeHealth, RuntimeState,
 *          MAX_TRACKED_TABS, createRuntimeState.
 */
import type { DetectionReport, MediaItem } from '@shared/types';

export type TabDetectionStatus = 'idle' | 'running' | 'detected' | 'failed';

export interface TabRuntimeState {
  readonly tabId: number;
  readonly url: string | undefined;
  readonly status: TabDetectionStatus;
  /** Count of supported media items last detected for this tab (badge source). */
  readonly itemCount: number;
  /** Whether a content script has reported observations for this tab. */
  readonly connected: boolean;
  readonly updatedAt: number;
}

/** Count of items eligible for download (the badge reflects this, §4.7). */
export function supportedCount(items: readonly MediaItem[]): number {
  return items.filter((item) => item.status === 'supported').length;
}

export interface RuntimeHealth {
  readonly startedAt: number;
  readonly tabCount: number;
  readonly connectedCount: number;
  readonly outstanding: number;
  readonly detectionRuns: number;
  readonly errors: number;
  readonly lastErrorAt: number | undefined;
}

interface MutableTab {
  tabId: number;
  url: string | undefined;
  status: TabDetectionStatus;
  itemCount: number;
  connected: boolean;
  /**
   * The most recent report from each FRAME of the tab, keyed by that frame's URL.
   *
   * A page's media is frequently not in its top document: a video host wraps its own
   * player in an `/embed/` iframe, so the top frame holds no `<video>` at all and the
   * playlist is fetched inside the frame, where the top frame's Resource Timing cannot
   * see it. Keyed rather than replaced, because a later report from one frame must not
   * erase what another frame observed (§8.10, ADR-012).
   */
  reportsByFrame: Map<string, DetectionReport>;
  lastReport: DetectionReport | undefined;
  lastItems: readonly MediaItem[];
  updatedAt: number;
}

export interface RuntimeState {
  /** Get or create the record for a tab. */
  ensureTab(tabId: number, url?: string): TabRuntimeState;
  getTab(tabId: number): TabRuntimeState | undefined;
  /** All tabs in insertion order (deterministic). */
  tabs(): readonly TabRuntimeState[];
  removeTab(tabId: number): void;
  setUrl(tabId: number, url: string | undefined): void;
  setStatus(tabId: number, status: TabDetectionStatus): void;
  /** Store the last detected items for a tab (status → 'detected'; badge source). */
  setItems(tabId: number, items: readonly MediaItem[]): void;
  getItems(tabId: number): readonly MediaItem[];
  /** Store the last observations for a tab (used by refresh). */
  /** Record one FRAME's report; frames are kept side by side, not replaced. */
  setReport(tabId: number, report: DetectionReport): void;
  /**
   * Everything the tab's frames have observed, as one report — what detection runs
   * over. The top frame's URL is used as the page URL where one is known, because
   * that is the page the user is on.
   */
  getReport(tabId: number): DetectionReport | undefined;
  /** The individual frame reports, newest last. */
  getFrameReports(tabId: number): readonly DetectionReport[];
  /** Drop a tab's detection results + stored observations (status → 'idle'). */
  clearDetection(tabId: number): void;
  setActiveTab(tabId: number | undefined): void;
  activeTabId(): number | undefined;
  connectedCount(): number;
  /** Mark a detection operation in-flight for a tab. */
  beginOperation(tabId: number): void;
  /** Mark a detection operation finished for a tab. */
  endOperation(tabId: number): void;
  outstandingCount(): number;
  recordRun(): void;
  recordError(): void;
  health(): RuntimeHealth;
}

/**
 * How many tabs may keep their detection payload in memory at once.
 *
 * Each tracked tab can hold its last report — up to 500 DOM signals and 500 observed
 * URLs — plus the items built from it, and entries were only dropped when the tab
 * closed. A long browsing session with many open tabs therefore grew without bound,
 * against the idle-memory budget (§12.1). Beyond this many tabs the
 * least-recently-updated ones are dropped; the active tab is never dropped, and a tab
 * that is dropped simply re-detects when the user next opens the popup on it (§9.9).
 * The number matches the detection cache's own tab bound so the two agree.
 */
export const MAX_TRACKED_TABS = 50;

export interface RuntimeStateDeps {
  readonly clock: () => number;
  /** Overrides {@link MAX_TRACKED_TABS}; for tests and tuning. */
  readonly maxTabs?: number;
}

/** Frames tracked per tab; past this the oldest is dropped (§10.9). */
const MAX_FRAMES_PER_TAB = 12;

/**
 * Fold every frame's observations into the one report detection runs over.
 *
 * Signals and URLs are already absolute — each frame resolved them against its own
 * document — so a union is meaningful. The top frame supplies the page URL and title
 * where it reported at all; otherwise the first frame does, so a page whose only media
 * lives in a frame still gets a sensible name.
 */
function mergedReport(tab: MutableTab | undefined): DetectionReport | undefined {
  if (tab === undefined || tab.reportsByFrame.size === 0) {
    return undefined;
  }
  const all = [...tab.reportsByFrame.values()];
  const top = all.find((report) => report.pageUrl === tab.url);
  // Only the tab's own page and its FRAMES are merged. A report from anything else —
  // an `about:blank` context, a surface driving the runtime directly — is kept for
  // whoever asks for it by frame, but folding it into the page's observations would
  // attribute media to a page that never had it (§4.1 detection is per tab AND page).
  const reports =
    top === undefined
      ? all
      : all.filter((report) => report === top || /^https?:\/\//i.test(report.pageUrl));
  if (reports.length <= 1) {
    return reports[0] ?? all[0];
  }
  const primary = top ?? reports[0];
  const urls = new Set<string>();
  const resources = new Map<string, NonNullable<DetectionReport['observedResources']>[number]>();
  const signals: DetectionReport['domSignals'][number][] = [];
  const origins = new Set<string>();
  let frames = 0;
  for (const report of reports) {
    signals.push(...report.domSignals);
    frames += report.frameCount ?? 0;
    for (const origin of report.frameOrigins ?? []) {
      origins.add(origin);
    }
    for (const url of report.observedUrls) {
      urls.add(url);
    }
    for (const resource of report.observedResources ?? []) {
      if (!resources.has(resource.url)) {
        resources.set(resource.url, resource);
      }
    }
  }
  return {
    pageUrl: primary?.pageUrl ?? reports[0]?.pageUrl ?? '',
    ...(primary?.documentTitle !== undefined && { documentTitle: primary.documentTitle }),
    domSignals: signals,
    observedUrls: [...urls],
    ...(resources.size > 0 && { observedResources: [...resources.values()] }),
    // Carried through the merge, not dropped by it: a refresh runs from the merged
    // report, and a page whose frame count vanished on the way would never have its
    // frames re-entered — which is exactly the moment a fresh grant needs them to be.
    ...(frames > 0 && { frameCount: frames }),
    ...(origins.size > 0 && { frameOrigins: [...origins] }),
  };
}

export function createRuntimeState(deps: RuntimeStateDeps): RuntimeState {
  const { clock } = deps;
  const maxTabs = Math.max(1, deps.maxTabs ?? MAX_TRACKED_TABS);
  const tabs = new Map<number, MutableTab>();
  const outstanding = new Map<number, number>();
  let activeTabId: number | undefined;
  const startedAt = clock();
  let detectionRuns = 0;
  let errors = 0;
  let lastErrorAt: number | undefined;

  const view = (tab: MutableTab): TabRuntimeState => ({
    tabId: tab.tabId,
    url: tab.url,
    status: tab.status,
    itemCount: tab.itemCount,
    connected: tab.connected,
    updatedAt: tab.updatedAt,
  });

  /**
   * Drop the least-recently-updated tabs once the map is over its bound. The active
   * tab and any tab with work in flight are kept: evicting either would discard state
   * the user is looking at or an operation is about to write to.
   */
  const evictIfNeeded = (): void => {
    if (tabs.size <= maxTabs) {
      return;
    }
    const candidates = [...tabs.values()]
      .filter((tab) => tab.tabId !== activeTabId && (outstanding.get(tab.tabId) ?? 0) === 0)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const tab of candidates) {
      if (tabs.size <= maxTabs) {
        return;
      }
      tabs.delete(tab.tabId);
    }
  };

  const ensure = (tabId: number, url?: string): MutableTab => {
    let tab = tabs.get(tabId);
    if (tab === undefined) {
      tab = {
        tabId,
        url,
        status: 'idle',
        itemCount: 0,
        connected: false,
        reportsByFrame: new Map<string, DetectionReport>(),
        lastReport: undefined,
        lastItems: [],
        updatedAt: clock(),
      };
      tabs.set(tabId, tab);
      evictIfNeeded();
    } else if (url !== undefined) {
      tab.url = url;
      tab.updatedAt = clock();
    }
    return tab;
  };

  return {
    ensureTab(tabId: number, url?: string): TabRuntimeState {
      return view(ensure(tabId, url));
    },

    getTab(tabId: number): TabRuntimeState | undefined {
      const tab = tabs.get(tabId);
      return tab === undefined ? undefined : view(tab);
    },

    tabs(): readonly TabRuntimeState[] {
      return [...tabs.values()].map(view);
    },

    removeTab(tabId: number): void {
      tabs.delete(tabId);
      outstanding.delete(tabId);
      if (activeTabId === tabId) {
        activeTabId = undefined;
      }
    },

    setUrl(tabId: number, url: string | undefined): void {
      const tab = ensure(tabId);
      tab.url = url;
      tab.updatedAt = clock();
    },

    setStatus(tabId: number, status: TabDetectionStatus): void {
      const tab = ensure(tabId);
      tab.status = status;
      tab.updatedAt = clock();
    },

    setItems(tabId: number, items: readonly MediaItem[]): void {
      const tab = ensure(tabId);
      tab.lastItems = items;
      tab.itemCount = supportedCount(items);
      tab.status = 'detected';
      tab.updatedAt = clock();
    },

    getItems(tabId: number): readonly MediaItem[] {
      return tabs.get(tabId)?.lastItems ?? [];
    },

    setReport(tabId: number, report: DetectionReport): void {
      const tab = ensure(tabId);
      // One slot per frame, keyed by the frame's own URL. Bounded so a page that
      // creates frames endlessly cannot grow this without limit (§10.9).
      if (
        tab.reportsByFrame.size >= MAX_FRAMES_PER_TAB &&
        !tab.reportsByFrame.has(report.pageUrl)
      ) {
        const oldest = tab.reportsByFrame.keys().next().value;
        if (oldest !== undefined) {
          tab.reportsByFrame.delete(oldest);
        }
      }
      tab.reportsByFrame.set(report.pageUrl, report);
      tab.lastReport = report;
      tab.connected = true;
      tab.updatedAt = clock();
    },

    getReport(tabId: number): DetectionReport | undefined {
      return mergedReport(tabs.get(tabId));
    },

    getFrameReports(tabId: number): readonly DetectionReport[] {
      return [...(tabs.get(tabId)?.reportsByFrame.values() ?? [])];
    },

    clearDetection(tabId: number): void {
      const tab = ensure(tabId);
      tab.lastItems = [];
      tab.reportsByFrame.clear();
      tab.lastReport = undefined;
      tab.itemCount = 0;
      tab.status = 'idle';
      tab.updatedAt = clock();
    },

    setActiveTab(tabId: number | undefined): void {
      activeTabId = tabId;
    },

    activeTabId(): number | undefined {
      return activeTabId;
    },

    connectedCount(): number {
      let count = 0;
      for (const tab of tabs.values()) {
        if (tab.connected) {
          count += 1;
        }
      }
      return count;
    },

    beginOperation(tabId: number): void {
      outstanding.set(tabId, (outstanding.get(tabId) ?? 0) + 1);
    },

    endOperation(tabId: number): void {
      const current = outstanding.get(tabId) ?? 0;
      if (current <= 1) {
        outstanding.delete(tabId);
      } else {
        outstanding.set(tabId, current - 1);
      }
    },

    outstandingCount(): number {
      let total = 0;
      for (const count of outstanding.values()) {
        total += count;
      }
      return total;
    },

    recordRun(): void {
      detectionRuns += 1;
    },

    recordError(): void {
      errors += 1;
      lastErrorAt = clock();
    },

    health(): RuntimeHealth {
      let connected = 0;
      for (const tab of tabs.values()) {
        if (tab.connected) {
          connected += 1;
        }
      }
      let outstandingTotal = 0;
      for (const count of outstanding.values()) {
        outstandingTotal += count;
      }
      return {
        startedAt,
        tabCount: tabs.size,
        connectedCount: connected,
        outstanding: outstandingTotal,
        detectionRuns,
        errors,
        lastErrorAt,
      };
    },
  };
}
