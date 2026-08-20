/**
 * Module: core/download/stream (DASH)
 * Purpose: Parse a DASH manifest (MPD) into something assembly can act on
 *          (PROJECT_BIBLE.md §10.6, §5.5). Pure: handed text, returns a description.
 *          It never fetches and never writes.
 * Restrictions: Domain layer — no browser globals, no adapters. `DOMParser` is
 *          deliberately NOT used: a Chromium MV3 service worker does not have it, so
 *          this module carries its own bounded tag scanner and extracts only the few
 *          elements assembly needs, refusing anything it cannot read confidently.
 *          ENCRYPTION IS A HARD REFUSAL: any ContentProtection, cenc usage or pssh
 *          ends parsing, and no key id, pssh payload or licence URL is ever read or
 *          returned (§6, ADR-005).
 * Dependencies: shared/utils (URL parsing).
 * Public API: DASH_MAX_TEXT_BYTES, DASH_MAX_SEGMENTS, DashSegment,
 *          DashRepresentation, DashManifest, parseDashManifest.
 */
import { parseUrl } from '@shared/utils';

export const DASH_MAX_TEXT_BYTES = 8 * 1024 * 1024;
export const DASH_MAX_SEGMENTS = 20_000;

export interface DashSegment {
  readonly url: string;
  readonly range?: { readonly offset: number; readonly length: number };
}

export interface DashRepresentation {
  readonly id: string;
  readonly mimeType?: string;
  readonly codecs?: string;
  readonly bandwidth?: number;
  readonly width?: number;
  readonly height?: number;
  readonly initSegment?: DashSegment;
  readonly segments: readonly DashSegment[];
}

export type DashManifest =
  | {
      readonly kind: 'static';
      readonly representations: readonly DashRepresentation[];
      /** Index into `representations`: highest bandwidth that looks sane. */
      readonly defaultIndex: number;
    }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly code: string };

const refused = (reason: string, code: string): DashManifest => ({
  kind: 'refused',
  reason,
  code,
});

interface Tag {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

const TAG_PATTERN = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseTagAttributes(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    out[name] = match[3] ?? match[4] ?? '';
  }
  return out;
}

/** Element name without its namespace prefix, lowercased. */
function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `PT1H2M3.5S` → seconds. Only the forms MPDs actually use. */
function parseIsoDuration(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (match === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  const total =
    (Number(days ?? 0) || 0) * 86_400 +
    (Number(hours ?? 0) || 0) * 3_600 +
    (Number(minutes ?? 0) || 0) * 60 +
    (Number(seconds ?? 0) || 0);
  return total > 0 ? total : undefined;
}

function resolve(uri: string, base: string): string | undefined {
  try {
    return new URL(uri, base).toString();
  } catch {
    return undefined;
  }
}

/** Expand `$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$` and `$$`. */
function expandTemplate(
  template: string,
  values: {
    readonly number?: number | undefined;
    readonly time?: number | undefined;
    readonly id: string;
    readonly bandwidth?: number | undefined;
  },
): string {
  return template.replace(/\$(\$|[A-Za-z]+)(%0(\d+)d)?\$/g, (_match, name: string, _pad, width) => {
    if (name === '$') {
      return '$';
    }
    const raw =
      name === 'Number'
        ? values.number
        : name === 'Time'
          ? values.time
          : name === 'Bandwidth'
            ? values.bandwidth
            : undefined;
    if (name === 'RepresentationID') {
      return values.id;
    }
    if (raw === undefined) {
      return '';
    }
    const digits = String(Math.trunc(raw));
    const pad = numeric(width as string | undefined);
    return pad === undefined ? digits : digits.padStart(pad, '0');
  });
}

interface SegmentSource {
  readonly template?: Readonly<Record<string, string>>;
  readonly timeline: { readonly t?: number; readonly d: number; readonly r: number }[];
  readonly list: { readonly media: string; readonly range?: string }[];
  readonly initialization?: { readonly sourceURL?: string; readonly range?: string };
  readonly baseUrl?: string;
}

function emptySource(): SegmentSource {
  return { timeline: [], list: [] };
}

function parseRange(value: string | undefined): DashSegment['range'] {
  if (value === undefined) {
    return undefined;
  }
  const [first, last] = value.split('-');
  const offset = numeric(first?.trim());
  const end = numeric(last?.trim());
  if (offset === undefined || end === undefined || end < offset) {
    return undefined;
  }
  return { offset, length: end - offset + 1 };
}

/** Build the segment list a representation implies, or `undefined` if unreadable. */
function buildSegments(
  source: SegmentSource,
  base: string,
  id: string,
  bandwidth: number | undefined,
  periodDurationSec: number | undefined,
): { readonly init?: DashSegment; readonly segments: readonly DashSegment[] } | undefined {
  const initFromElement = source.initialization;
  let init: DashSegment | undefined;
  if (initFromElement?.sourceURL !== undefined) {
    const url = resolve(expandTemplate(initFromElement.sourceURL, { id, bandwidth }), base);
    if (url !== undefined) {
      const range = parseRange(initFromElement.range);
      init = { url, ...(range !== undefined && { range }) };
    }
  } else if (source.template?.['initialization'] !== undefined) {
    const url = resolve(expandTemplate(source.template['initialization'], { id, bandwidth }), base);
    if (url !== undefined) {
      init = { url };
    }
  } else if (initFromElement?.range !== undefined) {
    const range = parseRange(initFromElement.range);
    if (range !== undefined) {
      init = { url: base, range };
    }
  }

  // SegmentList: the URLs are stated outright.
  if (source.list.length > 0) {
    const segments: DashSegment[] = [];
    for (const entry of source.list) {
      if (segments.length >= DASH_MAX_SEGMENTS) {
        return undefined;
      }
      const url = resolve(entry.media, base);
      if (url === undefined) {
        return undefined;
      }
      const range = parseRange(entry.range);
      segments.push({ url, ...(range !== undefined && { range }) });
    }
    return { ...(init !== undefined && { init }), segments };
  }

  const template = source.template;
  const media = template?.['media'];
  if (media === undefined) {
    return undefined;
  }
  const startNumber = numeric(template?.['startnumber']) ?? 1;
  const timescale = numeric(template?.['timescale']) ?? 1;

  // SegmentTimeline: each S contributes 1 + @r entries, with @t restarting the clock.
  if (source.timeline.length > 0) {
    const segments: DashSegment[] = [];
    let number = startNumber;
    let time = source.timeline[0]?.t ?? 0;
    for (const entry of source.timeline) {
      if (entry.t !== undefined) {
        time = entry.t;
      }
      const repeats = Math.max(0, Math.trunc(entry.r)) + 1;
      for (let index = 0; index < repeats; index += 1) {
        if (segments.length >= DASH_MAX_SEGMENTS) {
          return undefined;
        }
        const url = resolve(expandTemplate(media, { number, time, id, bandwidth }), base);
        if (url === undefined) {
          return undefined;
        }
        segments.push({ url });
        time += entry.d;
        number += 1;
      }
    }
    return { ...(init !== undefined && { init }), segments };
  }

  // Fixed-duration template: the count comes from the period's own duration.
  const duration = numeric(template?.['duration']);
  if (duration === undefined || duration <= 0 || periodDurationSec === undefined) {
    return undefined;
  }
  const segmentSeconds = duration / timescale;
  if (segmentSeconds <= 0) {
    return undefined;
  }
  const count = Math.ceil(periodDurationSec / segmentSeconds);
  if (count > DASH_MAX_SEGMENTS) {
    return undefined;
  }
  const segments: DashSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = resolve(
      expandTemplate(media, { number: startNumber + index, time: index * duration, id, bandwidth }),
      base,
    );
    if (url === undefined) {
      return undefined;
    }
    segments.push({ url });
  }
  return { ...(init !== undefined && { init }), segments };
}

export function parseDashManifest(text: string, manifestUrl: string): DashManifest {
  if (parseUrl(manifestUrl) === undefined) {
    return refused('Manifest URL is not usable', 'dash-manifest-url-invalid');
  }
  if (text.length > DASH_MAX_TEXT_BYTES) {
    return refused('Manifest is larger than the accepted ceiling', 'dash-too-large');
  }
  if (!/<MPD[\s>]/i.test(text)) {
    return refused('Not a DASH manifest (no MPD element)', 'dash-not-a-manifest');
  }
  // Refused before anything else is interpreted: protected content is out of scope,
  // and this parser must never be the thing that reads a pssh or a key id.
  if (/<[^>]*ContentProtection|cenc:pssh|<pssh|urn:mpeg:dash:mp4protection/i.test(text)) {
    return refused(
      'Manifest declares content protection; encrypted media is not downloadable',
      'dash-encrypted',
    );
  }

  const representations: DashRepresentation[] = [];
  let mpdStatic = true;
  let mpdDurationSec: number | undefined;
  let periodDurationSec: number | undefined;

  // BaseURL resolution walks MPD → Period → AdaptationSet → Representation.
  let baseMpd = manifestUrl;
  let basePeriod: string | undefined;
  let baseAdaptation: string | undefined;
  let baseRepresentation: string | undefined;
  let pendingBaseUrlFor: 'mpd' | 'period' | 'adaptation' | 'representation' | undefined;

  let adaptationSource = emptySource();
  let adaptationAttributes: Readonly<Record<string, string>> = {};
  let representationAttributes: Readonly<Record<string, string>> | undefined;
  let representationSource = emptySource();
  let inRepresentation = false;
  let timelineTarget: 'adaptation' | 'representation' | undefined;

  const tags: Tag[] = [];
  const textBetween: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TAG_PATTERN)) {
    textBetween.push(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    tags.push({
      name: match[2] ?? '',
      attributes: parseTagAttributes(match[3] ?? ''),
      closing: match[1] === '/',
      selfClosing: match[4] === '/',
    });
  }

  const currentBase = (): string => baseRepresentation ?? baseAdaptation ?? basePeriod ?? baseMpd;

  const finishRepresentation = (): void => {
    if (!inRepresentation || representationAttributes === undefined) {
      return;
    }
    const attributes = representationAttributes;
    const id = attributes['id'] ?? `rep-${String(representations.length)}`;
    const bandwidth = numeric(attributes['bandwidth']);
    const source: SegmentSource = {
      ...((representationSource.template ?? adaptationSource.template)
        ? { template: { ...adaptationSource.template, ...representationSource.template } }
        : {}),
      timeline:
        representationSource.timeline.length > 0
          ? representationSource.timeline
          : adaptationSource.timeline,
      list:
        representationSource.list.length > 0 ? representationSource.list : adaptationSource.list,
      ...((representationSource.initialization ?? adaptationSource.initialization) !==
        undefined && {
        initialization: representationSource.initialization ?? adaptationSource.initialization,
      }),
    };
    const built = buildSegments(
      source,
      currentBase(),
      id,
      bandwidth,
      periodDurationSec ?? mpdDurationSec,
    );
    if (built !== undefined && built.segments.length > 0) {
      const mimeType = attributes['mimetype'] ?? adaptationAttributes['mimetype'];
      const codecs = attributes['codecs'] ?? adaptationAttributes['codecs'];
      const width = numeric(attributes['width'] ?? adaptationAttributes['width']);
      const height = numeric(attributes['height'] ?? adaptationAttributes['height']);
      representations.push({
        id,
        segments: built.segments,
        ...(built.init !== undefined && { initSegment: built.init }),
        ...(mimeType !== undefined && { mimeType }),
        ...(codecs !== undefined && { codecs }),
        ...(bandwidth !== undefined && { bandwidth }),
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
      });
    }
    inRepresentation = false;
    representationAttributes = undefined;
    representationSource = emptySource();
    baseRepresentation = undefined;
  };

  tags.forEach((tag, index) => {
    const name = localName(tag.name);

    if (pendingBaseUrlFor !== undefined) {
      const value = (textBetween[index] ?? '').trim();
      if (value !== '') {
        const resolved = resolve(value, currentBase());
        if (resolved !== undefined) {
          if (pendingBaseUrlFor === 'mpd') {
            baseMpd = resolved;
          } else if (pendingBaseUrlFor === 'period') {
            basePeriod = resolved;
          } else if (pendingBaseUrlFor === 'adaptation') {
            baseAdaptation = resolved;
          } else {
            baseRepresentation = resolved;
          }
        }
      }
      pendingBaseUrlFor = undefined;
    }

    if (tag.closing) {
      if (name === 'representation') {
        finishRepresentation();
      } else if (name === 'adaptationset') {
        adaptationSource = emptySource();
        adaptationAttributes = {};
        baseAdaptation = undefined;
      } else if (name === 'period') {
        basePeriod = undefined;
        periodDurationSec = undefined;
      }
      return;
    }

    switch (name) {
      case 'mpd': {
        mpdStatic = (tag.attributes['type'] ?? 'static').toLowerCase() !== 'dynamic';
        mpdDurationSec = parseIsoDuration(tag.attributes['mediapresentationduration']);
        break;
      }
      case 'period': {
        periodDurationSec = parseIsoDuration(tag.attributes['duration']) ?? mpdDurationSec;
        break;
      }
      case 'baseurl': {
        pendingBaseUrlFor = inRepresentation
          ? 'representation'
          : baseAdaptation !== undefined || adaptationAttributes['mimetype'] !== undefined
            ? 'adaptation'
            : basePeriod !== undefined || periodDurationSec !== undefined
              ? 'period'
              : 'mpd';
        break;
      }
      case 'adaptationset': {
        adaptationAttributes = tag.attributes;
        adaptationSource = emptySource();
        timelineTarget = 'adaptation';
        break;
      }
      case 'representation': {
        finishRepresentation();
        inRepresentation = true;
        representationAttributes = tag.attributes;
        representationSource = emptySource();
        timelineTarget = 'representation';
        if (tag.selfClosing) {
          finishRepresentation();
        }
        break;
      }
      case 'segmenttemplate': {
        const target = inRepresentation ? representationSource : adaptationSource;
        const merged: SegmentSource = { ...target, template: tag.attributes };
        if (inRepresentation) {
          representationSource = merged;
        } else {
          adaptationSource = merged;
        }
        break;
      }
      case 'segmentlist': {
        const template = tag.attributes;
        const target = inRepresentation ? representationSource : adaptationSource;
        const merged: SegmentSource = { ...target, template: { ...target.template, ...template } };
        if (inRepresentation) {
          representationSource = merged;
        } else {
          adaptationSource = merged;
        }
        break;
      }
      case 'segmenturl': {
        const media = tag.attributes['media'];
        if (media !== undefined) {
          const entry = {
            media,
            ...(tag.attributes['mediarange'] !== undefined && {
              range: tag.attributes['mediarange'],
            }),
          };
          (inRepresentation ? representationSource : adaptationSource).list.push(entry);
        }
        break;
      }
      case 'initialization': {
        const initialization = {
          ...(tag.attributes['sourceurl'] !== undefined && {
            sourceURL: tag.attributes['sourceurl'],
          }),
          ...(tag.attributes['range'] !== undefined && { range: tag.attributes['range'] }),
        };
        if (inRepresentation) {
          representationSource = { ...representationSource, initialization };
        } else {
          adaptationSource = { ...adaptationSource, initialization };
        }
        break;
      }
      case 's': {
        const d = numeric(tag.attributes['d']);
        if (d !== undefined) {
          const entry = {
            ...(numeric(tag.attributes['t']) !== undefined && {
              t: numeric(tag.attributes['t']) as number,
            }),
            d,
            r: numeric(tag.attributes['r']) ?? 0,
          };
          (timelineTarget === 'representation' && inRepresentation
            ? representationSource
            : adaptationSource
          ).timeline.push(entry);
        }
        break;
      }
      default:
        break;
    }
  });
  finishRepresentation();

  if (!mpdStatic) {
    return { kind: 'dynamic', reason: 'A live manifest has no fixed end to assemble' };
  }
  if (representations.length === 0) {
    return refused('No representation could be read from the manifest', 'dash-unreadable');
  }

  // Default: the highest bandwidth whose height is plausible, else highest bandwidth.
  let defaultIndex = 0;
  representations.forEach((representation, index) => {
    const best = representations[defaultIndex];
    const sane = (representation.height ?? 0) <= 4320;
    const better = (representation.bandwidth ?? 0) > (best?.bandwidth ?? 0);
    if (sane && better) {
      defaultIndex = index;
    }
  });

  return { kind: 'static', representations, defaultIndex };
}
