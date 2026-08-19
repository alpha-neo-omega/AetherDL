/**
 * Test fixtures for the detection engine: builders for DomSignal and DetectionContext
 * that mirror what the content script will produce. Not a test file.
 */
import type { DetectionContext, DomSignal, DomSignalRole } from '@core/detection/pipeline';

export function signal(
  props: { role: DomSignalRole } & Partial<Omit<DomSignal, 'role'>>,
): DomSignal {
  return { tagName: props.role.toUpperCase(), ...props };
}

export function context(props: Partial<DetectionContext> = {}): DetectionContext {
  return {
    tabId: 1,
    pageUrl: 'https://example.com/watch',
    domSignals: [],
    observedUrls: [],
    source: 'dom',
    timestamp: 1000,
    ...props,
  };
}
