/**
 * Module: runtime/content/scan
 * Purpose: Pure DOM → observation mapping for the content script (PROJECT_BIBLE.md
 *          §8.10). Reads a minimal STRUCTURAL view of the DOM (no reliance on the
 *          global `document`) and emits plain-data `WireDomSignal`s + observed URLs.
 *          It performs NO detection — detectors run in the background (§8.10).
 * Restrictions: Runtime layer, isolated world only. Pure function of its input; no
 *          browser globals here (the entry adapts the real DOM to these shapes).
 * Public API: ElementLike, MediaElementLike, DocumentLike, ScanResult, scanDocument.
 */
import { MAX_DOM_SIGNALS, MAX_OBSERVED_URLS } from '@shared/constants';
import type { WireDomSignal } from '@shared/types';
import { getExtension } from '@shared/utils';

/** Minimal structural view of a DOM element the scanner reads. */
export interface ElementLike {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  readonly parentElement?: { readonly tagName: string } | null;
}

/** Structural view of an HTMLMediaElement (video/audio). */
export interface MediaElementLike extends ElementLike {
  readonly currentSrc?: string;
  readonly src?: string;
  readonly duration?: number;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  /** Present (non-null) when Encrypted Media Extensions are attached (EME/DRM, §6). */
  readonly mediaKeys?: unknown;
  /** Present (non-null) when the element is MediaSource/MediaStream backed (§5.4). */
  readonly srcObject?: unknown;
}

/** Structural view of the document root the scanner queries. */
export interface DocumentLike {
  querySelectorAll(selectors: string): Iterable<ElementLike>;
}

export interface ScanResult {
  readonly domSignals: readonly WireDomSignal[];
  readonly observedUrls: readonly string[];
}

const MEDIA_SELECTOR = 'video, audio, source, a[href]';

function attr(element: ElementLike, name: string): string | undefined {
  return element.getAttribute(name) ?? undefined;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function roleFor(tagName: string): 'video' | 'audio' | 'source' | 'link' | undefined {
  switch (tagName.toLowerCase()) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'source':
      return 'source';
    case 'a':
      return 'link';
    default:
      return undefined;
  }
}

function isMediaLink(href: string): boolean {
  const ext = getExtension(href);
  return ext !== undefined;
}

function mediaSignal(element: MediaElementLike, role: 'video' | 'audio'): WireDomSignal {
  const currentSrc = element.currentSrc ?? undefined;
  const src = attr(element, 'src') ?? element.src ?? undefined;
  const type = attr(element, 'type');
  const effective = currentSrc ?? src ?? '';
  const isBlob = effective.startsWith('blob:');
  const width = toNumber(element.videoWidth) ?? toNumber(attr(element, 'width'));
  const height = toNumber(element.videoHeight) ?? toNumber(attr(element, 'height'));
  const durationSec = toNumber(element.duration);
  return {
    role,
    tagName: element.tagName,
    ...(src !== undefined && { src }),
    ...(currentSrc !== undefined && { currentSrc }),
    ...(type !== undefined && { type }),
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(durationSec !== undefined && { durationSec }),
    ...(element.srcObject != null || isBlob ? { mediaSource: true } : {}),
    ...(element.mediaKeys != null ? { encrypted: true } : {}),
  };
}

function sourceSignal(element: ElementLike): WireDomSignal {
  const parentTag = element.parentElement?.tagName;
  const parentRole = parentTag === undefined ? undefined : roleFor(parentTag);
  const src = attr(element, 'src');
  const type = attr(element, 'type');
  return {
    role: 'source',
    tagName: element.tagName,
    ...(src !== undefined && { src }),
    ...(type !== undefined && { type }),
    ...(parentRole !== undefined && { parentRole }),
  };
}

function linkSignal(href: string, element: ElementLike): WireDomSignal {
  return {
    role: 'link',
    tagName: element.tagName,
    href,
  };
}

/**
 * Scan a document for media-relevant signals + observed URLs. Pure.
 *
 * Bounded by design (§9.10, §12.4): a page with thousands of media nodes stops the
 * walk at {@link MAX_DOM_SIGNALS}/{@link MAX_OBSERVED_URLS} rather than building a
 * report the background would truncate to the same bound anyway (§13.8).
 */
export function scanDocument(document: DocumentLike): ScanResult {
  const domSignals: WireDomSignal[] = [];
  const observedUrls = new Set<string>();
  const isFull = (): boolean =>
    domSignals.length >= MAX_DOM_SIGNALS && observedUrls.size >= MAX_OBSERVED_URLS;
  const addUrl = (url: string): void => {
    if (observedUrls.size < MAX_OBSERVED_URLS) {
      observedUrls.add(url);
    }
  };

  for (const element of document.querySelectorAll(MEDIA_SELECTOR)) {
    if (isFull()) {
      break;
    }
    if (domSignals.length >= MAX_DOM_SIGNALS) {
      // Signals are full but URLs are not: keep harvesting URLs only.
      const mediaRole = roleFor(element.tagName);
      if (mediaRole === 'video' || mediaRole === 'audio') {
        const signal = mediaSignal(element as MediaElementLike, mediaRole);
        if (signal.currentSrc !== undefined) {
          addUrl(signal.currentSrc);
        }
        if (signal.src !== undefined) {
          addUrl(signal.src);
        }
      } else if (mediaRole === 'source') {
        const signal = sourceSignal(element);
        if (signal.src !== undefined) {
          addUrl(signal.src);
        }
      } else if (mediaRole === 'link') {
        const href = attr(element, 'href');
        if (href !== undefined && isMediaLink(href)) {
          addUrl(href);
        }
      }
      continue;
    }
    const role = roleFor(element.tagName);
    if (role === 'video' || role === 'audio') {
      const signal = mediaSignal(element as MediaElementLike, role);
      domSignals.push(signal);
      if (signal.currentSrc !== undefined) {
        addUrl(signal.currentSrc);
      }
      if (signal.src !== undefined) {
        addUrl(signal.src);
      }
    } else if (role === 'source') {
      const signal = sourceSignal(element);
      domSignals.push(signal);
      if (signal.src !== undefined) {
        addUrl(signal.src);
      }
    } else if (role === 'link') {
      const href = attr(element, 'href');
      if (href !== undefined && isMediaLink(href)) {
        domSignals.push(linkSignal(href, element));
        addUrl(href);
      }
    }
  }

  return { domSignals, observedUrls: [...observedUrls] };
}
