/**
 * Module: core/detection/detectors
 * Purpose: The detector plugin contract (PROJECT_BIBLE.md §9.2; ADR-004). New media
 *          sources are added as detectors implementing this interface, without
 *          changing the core.
 * Restrictions: Detectors depend ONLY on this contract, the pipeline input types,
 *          and shared/ (§9.2) — never on each other, browser globals, or DRM logic.
 * Dependencies: shared/types, core/detection/pipeline (context/candidate types).
 * Public API: DetectorMetadata, Detector.
 *
 * Contract note (pending ADR-007): the frozen §9.2 members — `id`, `name`,
 * `priority`, `canDetect`, `detect` — are preserved verbatim. `enabled`,
 * `initialize`, `cleanup`, and `metadata` are ADDITIVE and OPTIONAL, so a minimal
 * §9.2 detector remains valid. The Owner's requested `supports()` predicate is
 * `canDetect()`.
 */
import type { MediaKind } from '@shared/types';
import type { DetectionContext, RawCandidate } from '@core/detection/pipeline';

/** Diagnostic descriptor a detector may expose (additive). */
export interface DetectorMetadata {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly supportedKinds: readonly MediaKind[];
}

export interface Detector {
  /** Stable unique id, kebab-case, e.g. `html5-video`. */
  readonly id: string;
  /** Human-readable name for diagnostics (localized separately). */
  readonly name: string;
  /** Higher runs earlier and wins priority ties (§9.4). */
  readonly priority: number;
  /** Whether this detector participates in detection (additive; default true). */
  readonly enabled?: boolean;
  /** Optional one-time setup before first use (additive lifecycle). */
  initialize?(): void | Promise<void>;
  /** Optional teardown when the detector is unregistered/disposed (additive). */
  cleanup?(): void | Promise<void>;
  /** Fast, cheap predicate: should this detector run for this context? (== supports) */
  canDetect(context: DetectionContext): boolean;
  /** Produce raw candidates. Side-effect free and bounded (§9.2). */
  detect(context: DetectionContext): Promise<readonly RawCandidate[]>;
  /** Optional diagnostic metadata (additive). */
  metadata?(): DetectorMetadata;
}
