/**
 * Module: core/download/progress (implementation)
 * Purpose: Per-job and overall progress with derived transfer rate and ETA
 *          (PROJECT_BIBLE.md §10.5). Honest: unknown totals yield no ratio/ETA, and
 *          rate is computed only from two real samples over elapsed time.
 * Restrictions: Domain layer — pure; clock injected for deterministic rate/ETA.
 * Public API: createProgressTracker.
 */
import type { OverallProgress, ProgressSnapshot, ProgressTracker } from '@core/download/progress';

interface Sample {
  received: number;
  total: number | undefined;
  at: number;
  prevReceived: number | undefined;
  prevAt: number | undefined;
}

export function createProgressTracker(clock: () => number = () => Date.now()): ProgressTracker {
  const samples = new Map<string, Sample>();

  const rate = (sample: Sample): number | undefined => {
    if (sample.prevReceived === undefined || sample.prevAt === undefined) {
      return undefined;
    }
    const elapsed = (sample.at - sample.prevAt) / 1000;
    const bytes = sample.received - sample.prevReceived;
    if (elapsed <= 0 || bytes <= 0) {
      return undefined;
    }
    return bytes / elapsed;
  };

  return {
    record(taskId: string, received: number, total?: number): void {
      const prev = samples.get(taskId);
      samples.set(taskId, {
        received,
        total,
        at: clock(),
        prevReceived: prev?.received,
        prevAt: prev?.at,
      });
    },

    snapshot(taskId: string): ProgressSnapshot | undefined {
      const sample = samples.get(taskId);
      if (sample === undefined) {
        return undefined;
      }
      const bytesPerSec = rate(sample);
      const ratio =
        sample.total !== undefined && sample.total > 0
          ? Math.min(sample.received / sample.total, 1)
          : undefined;
      const etaSec =
        sample.total !== undefined && bytesPerSec !== undefined && bytesPerSec > 0
          ? Math.max(0, (sample.total - sample.received) / bytesPerSec)
          : undefined;
      return {
        taskId,
        received: sample.received,
        ...(sample.total !== undefined && { total: sample.total }),
        ...(ratio !== undefined && { ratio }),
        ...(bytesPerSec !== undefined && { bytesPerSec }),
        ...(etaSec !== undefined && { etaSec }),
      };
    },

    overall(): OverallProgress {
      let received = 0;
      let total = 0;
      let totalKnown = true;
      for (const sample of samples.values()) {
        received += sample.received;
        if (sample.total === undefined) {
          totalKnown = false;
        } else {
          total += sample.total;
        }
      }
      const knownTotal = totalKnown && total > 0 ? total : undefined;
      return {
        received,
        ...(knownTotal !== undefined && {
          total: knownTotal,
          ratio: Math.min(received / knownTotal, 1),
        }),
        jobs: samples.size,
      };
    },

    remove(taskId: string): void {
      samples.delete(taskId);
    },

    clear(): void {
      samples.clear();
    },
  };
}
