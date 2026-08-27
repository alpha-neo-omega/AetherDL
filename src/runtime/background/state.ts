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
 *          MAX_TRACKED_TABS, MAX_REMEMBERED_RESOURCES, createRuntimeState.
 */
import type { DetectionReport, MediaItem } from '@shared/types';
import type { NetworkResource } from '@core/detection/pipeline';

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
  /** Signature of each frame's last report, for deciding whether anything changed. */
  signaturesByFrame: Map<string, string>;
  /**
   * Media resources IDENTIFIED for this page, kept until it navigates.
   *
   * A page's Resource Timing buffer is a cache, not a record: a 34-minute stream
   * fetches hundreds of segments, and the playlist entry that started it is evicted
   * long before the user opens the popup again. Re-reading the timeline then reports
   * a page with no playlist in it, and a stream that WAS offered — and downloaded —
   * silently became an unfetchable `blob:` card on the next look.
   *
   * What was identified is therefore remembered here rather than re-derived. It is
   * scoped to the page: navigation clears it, because then it really is gone (§4.1).
   */
  resources: Map<string, NetworkResource>;
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
  /**
   * Record one FRAME's report; frames are kept side by side, not replaced. Answers
   * whether this frame's view of the page actually CHANGED — a page that mutates
   * continuously re-reports the same observations several times a second, and running
   * the pipeline again for an identical report cannot produce a different result
   * (§12.1, §12.4).
   */
  setReport(tabId: number, report: DetectionReport): boolean;
  /**
   * Everything the tab's frames have observed, as one report — what detection runs
   * over. The top frame's URL is used as the page URL where one is known, because
   * that is the page the user is on.
   */
  getReport(tabId: number): DetectionReport | undefined;
  /** The individual frame reports, newest last. */
  getFrameReports(tabId: number): readonly DetectionReport[];
  /**
   * Keep media resources identified for this page, so a later pass that cannot see
   * them any more still detects them. Bounded; cleared when the tab navigates.
   */
  rememberResources(tabId: number, resources: readonly NetworkResource[]): void;
  /** What has been identified for this page so far. */
  getResources(tabId: number): readonly NetworkResource[];
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

/**
 * Identified media resources remembered per page.
 *
 * A page offers a handful of streams, not dozens; this is a bound on a memory that
 * outlives the timeline it came from, not a working set (§10.9, §12.1).
 */
export const MAX_REMEMBERED_RESOURCES = 32;

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
/**
 * A frame's report reduced to a comparable string.
 *
 * Cheap next to what it saves: serialising a couple of hundred observations costs tens
 * of microseconds, and it stands in for a detection pass measured at 7 ms median and
 * 36 ms worst — paid twice per report, several times a second, on a page that is
 * merely playing a video (§12.1).
 */
function signatureOf(report: DetectionReport): string {
  return JSON.stringify([
    report.pageUrl,
    report.documentTitle ?? '',
    report.frameCount ?? 0,
    report.frameOrigins ?? [],
    report.domSignals,
    report.observedUrls,
    report.observedResources ?? [],
  ]);
}

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
        signaturesByFrame: new Map<string, string>(),
        resources: new Map<string, NetworkResource>(),
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

    setReport(tabId: number, report: DetectionReport): boolean {
      const tab = ensure(tabId);
      const signature = signatureOf(report);
      const changed = tab.signaturesByFrame.get(report.pageUrl) !== signature;
      tab.signaturesByFrame.set(report.pageUrl, signature);
      // One slot per frame, keyed by the frame's own URL. Bounded so a page that
      // creates frames endlessly cannot grow this without limit (§10.9).
      if (
        tab.reportsByFrame.size >= MAX_FRAMES_PER_TAB &&
        !tab.reportsByFrame.has(report.pageUrl)
      ) {
        const oldest = tab.reportsByFrame.keys().next().value;
        if (oldest !== undefined) {
          tab.reportsByFrame.delete(oldest);
          tab.signaturesByFrame.delete(oldest);
        }
      }
      tab.reportsByFrame.set(report.pageUrl, report);
      tab.lastReport = report;
      tab.connected = true;
      tab.updatedAt = clock();
      return changed;
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
      tab.signaturesByFrame.clear();
      tab.resources.clear();
      tab.lastReport = undefined;
      tab.itemCount = 0;
      tab.status = 'idle';
      tab.updatedAt = clock();
    },

    rememberResources(tabId: number, resources: readonly NetworkResource[]): void {
      const tab = ensure(tabId);
      for (const resource of resources) {
        if (tab.resources.size >= MAX_REMEMBERED_RESOURCES && !tab.resources.has(resource.url)) {
          const oldest = tab.resources.keys().next().value;
          if (oldest !== undefined) {
            tab.resources.delete(oldest);
          }
        }
        tab.resources.set(resource.url, resource);
      }
      tab.updatedAt = clock();
    },

    getResources(tabId: number): readonly NetworkResource[] {
      return [...(tabs.get(tabId)?.resources.values() ?? [])];
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
