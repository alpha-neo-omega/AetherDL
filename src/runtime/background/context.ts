/**
 * Module: runtime/background/context
 * Purpose: Validate an untrusted content-script `DetectionReport` at the trust
 *          boundary (PROJECT_BIBLE.md §13.8) and map it into the detection engine's
 *          `DetectionContext` (§9.3). This is the ONLY bridge from the shared wire
 *          shape to the core input; the engine is used exactly as implemented.
 * Restrictions: Runtime layer — pure mapping/validation; no browser globals. Bounds
 *          untrusted input (caps counts) and drops malformed signals.
 * Public API: MAX_SIGNALS, MAX_URLS, isDetectionReport, buildDetectionContext.
 */
import { MAX_DOM_SIGNALS, MAX_OBSERVED_URLS } from '@shared/constants';
import type { DetectionReport, WireDomSignal } from '@shared/types';
import type { DetectionContext, DomSignal, DomSignalRole } from '@core/detection/pipeline';

/**
 * Upper bounds on untrusted collections (defense in depth, §13.8). The same numbers
 * bound the content script's scan, so a pathological page is capped at the source
 * as well as here (§9.10, §12.4).
 */
export const MAX_SIGNALS = MAX_DOM_SIGNALS;
export const MAX_URLS = MAX_OBSERVED_URLS;

/**
 * Validate the top-level shape of an untrusted `detection/run` payload (§13.8).
 * Element-level validation of signals/URLs happens in {@link buildDetectionContext}.
 */
export function isDetectionReport(value: unknown): value is DetectionReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['pageUrl'] === 'string' &&
    Array.isArray(record['domSignals']) &&
    Array.isArray(record['observedUrls'])
  );
}

const ROLES: ReadonlySet<string> = new Set<DomSignalRole>(['video', 'audio', 'source', 'link']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function role(value: unknown): DomSignalRole | undefined {
  return typeof value === 'string' && ROLES.has(value) ? (value as DomSignalRole) : undefined;
}

/**
 * Resolve a URL from an untrusted report against the page it came from. The content
 * script resolves what it reads, but the payload is untrusted and an older content
 * script may still be running after an update, so relative values are resolved here
 * too rather than refused later as malformed (§13.8).
 */
function resolveAgainst(url: string | undefined, pageUrl: string): string | undefined {
  if (url === undefined || pageUrl === '') {
    return url;
  }
  try {
    return new URL(url, pageUrl).toString();
  } catch {
    return url;
  }
}

/** Normalize one untrusted wire signal into a core DomSignal, or drop it. */
function toDomSignal(value: unknown, pageUrl: string): DomSignal | undefined {
  // Element-level guard: an array element may be null/primitive (untrusted, §13.8).
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Partial<WireDomSignal>;
  const signalRole = role(raw.role);
  if (signalRole === undefined) {
    return undefined;
  }
  const tagName = str(raw.tagName) ?? signalRole.toUpperCase();
  const parentRole = role(raw.parentRole);
  const src = resolveAgainst(str(raw.src), pageUrl);
  const currentSrc = resolveAgainst(str(raw.currentSrc), pageUrl);
  const href = resolveAgainst(str(raw.href), pageUrl);
  const type = str(raw.type);
  const width = num(raw.width);
  const height = num(raw.height);
  const durationSec = num(raw.durationSec);
  const title = str(raw.title);
  const codecs = str(raw.codecs);
  return {
    role: signalRole,
    tagName,
    ...(src !== undefined && { src }),
    ...(currentSrc !== undefined && { currentSrc }),
    ...(href !== undefined && { href }),
    ...(type !== undefined && { type }),
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(durationSec !== undefined && { durationSec }),
    ...(parentRole !== undefined && { parentRole }),
    ...(title !== undefined && { title }),
    ...(codecs !== undefined && { codecs }),
    ...(raw.mediaSource === true && { mediaSource: true }),
    ...(raw.encrypted === true && { encrypted: true }),
  };
}

/**
 * Build a validated {@link DetectionContext} for `tabId` from a report. Malformed
 * signals are dropped; collections are capped; only string URLs are kept.
 */
export function buildDetectionContext(
  report: DetectionReport,
  tabId: number,
  source: DetectionContext['source'],
  timestamp: number,
): DetectionContext {
  // Defensive: tolerate a non-array field even though the boundary guard rejects it.
  const rawSignals = Array.isArray(report.domSignals) ? report.domSignals : [];
  const rawUrls = Array.isArray(report.observedUrls) ? report.observedUrls : [];
  const pageUrl = str(report.pageUrl) ?? '';
  const domSignals: DomSignal[] = [];
  for (const raw of rawSignals.slice(0, MAX_SIGNALS)) {
    const signal = toDomSignal(raw, pageUrl);
    if (signal !== undefined) {
      domSignals.push(signal);
    }
  }
  const observedUrls = rawUrls
    .filter((url): url is string => typeof url === 'string' && url !== '')
    .slice(0, MAX_URLS)
    .map((url) => resolveAgainst(url, pageUrl) ?? url);

  const title = str(report.documentTitle);
  const frameId = num(report.frameId);
  return {
    tabId,
    pageUrl,
    domSignals,
    observedUrls,
    source,
    timestamp,
    ...(title !== undefined && { documentTitle: title }),
    ...(frameId !== undefined && { frameId }),
  };
}
