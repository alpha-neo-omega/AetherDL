/**
 * Module: core/download/stream
 * Purpose: Non-DRM HLS/DASH stream-assembly contract (PROJECT_BIBLE.md §10.6, §5.5).
 * Restrictions: Domain layer. Assembly MUST abort and reclassify as unsupported on
 *          ANY encryption/DRM signal — no key handling, no decryption, ever
 *          (PROJECT_BIBLE.md §6; ADR-005). Permanent, non-approvable boundary.
 * Dependencies: none.
 * Public API: StreamAssembler.
 */
export interface StreamAssembler {
  /** Whether the (non-DRM) manifest is assemblable within the security model. */
  supports(manifestUrl: string): boolean;
}
