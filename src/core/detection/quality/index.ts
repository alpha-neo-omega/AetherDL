/**
 * Module: core/detection/quality
 * Purpose: Quality/variant detection contract for adaptive, non-DRM manifests
 *          (PROJECT_BIBLE.md §9.8, §5.5).
 * Restrictions: Domain layer — pure (§8.4). No DRM handling (§6).
 * Dependencies: shared/types.
 * Public API: QualityParser.
 */
import type { MediaVariant, QualityLabel } from '@shared/types';

export interface QualityParser {
  classify(bitrateKbps: number | undefined, height: number | undefined): QualityLabel;
  parseVariants(manifest: string): readonly MediaVariant[];
}
