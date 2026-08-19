/**
 * Module: platform/network
 * Purpose: Least-privilege media-request observation contract for detection
 *          (PROJECT_BIBLE.md §7.5, §12.6). Observation only — never modifies or
 *          intercepts protected content. Implementation lands in Phase 3/4.
 * Restrictions: Platform layer — depends only on shared/ (§8.4).
 * Dependencies: none.
 * Public API: ObservedRequest, NetworkObserver.
 */
export interface ObservedRequest {
  readonly url: string;
  readonly mimeType?: string;
  readonly tabId: number;
}

export interface NetworkObserver {
  observe(listener: (request: ObservedRequest) => void): () => void;
}
