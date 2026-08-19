/**
 * Module: platform/downloads (implementation)
 * Purpose: Implement {@link DownloadsAdapter} over the normalized WebExtension API.
 *          Platform access only — maps native download states to {@link TaskState}
 *          and exposes progress on demand. No queue/retry/manager logic (Phase 5).
 * Restrictions: Platform layer — adapts only.
 * Public API: createDownloadsService.
 */
import type {
  DownloadChange,
  DownloadProgress,
  DownloadsAdapter,
  NativeDownloadOptions,
} from '@platform/downloads';
import type { WebExtApi } from '@platform/browser/webext';
import { DownloadError } from '@shared/result/errors';
import type { TaskState } from '@shared/types';
import { createMultiplexer } from '@shared/utils';

/** Map a native download state string to the domain {@link TaskState}. */
function mapState(raw: string | undefined): TaskState | undefined {
  switch (raw) {
    case 'in_progress':
      return 'active';
    case 'complete':
      return 'completed';
    case 'interrupted':
      return 'failed';
    default:
      return undefined;
  }
}

/** Create the downloads service over a resolved WebExtension API. */
export function createDownloadsService(api: WebExtApi): DownloadsAdapter {
  const changes = createMultiplexer<[DownloadChange]>((emit) => {
    const listener = (delta: { id: number; state?: { current?: string } }): void => {
      emit({ id: delta.id, state: mapState(delta.state?.current) });
    };
    api.downloads.onChanged.addListener(listener);
    return () => {
      api.downloads.onChanged.removeListener(listener);
    };
  });

  return {
    async start(options: NativeDownloadOptions): Promise<number> {
      try {
        return await api.downloads.download({
          url: options.url,
          filename: options.filename,
          conflictAction: options.conflictAction,
          saveAs: options.saveAs,
        });
      } catch (cause) {
        throw new DownloadError('Failed to start native download', {
          code: 'download-start-failed',
          messageKey: 'error.download.start',
          retryable: true,
          cause,
        });
      }
    },

    async cancel(downloadId: number): Promise<void> {
      try {
        await api.downloads.cancel(downloadId);
      } catch (cause) {
        throw new DownloadError('Failed to cancel native download', {
          code: 'download-cancel-failed',
          messageKey: 'error.download.cancel',
          cause,
        });
      }
    },

    async getProgress(downloadId: number): Promise<DownloadProgress | undefined> {
      let items;
      try {
        items = await api.downloads.search({ id: downloadId });
      } catch (cause) {
        throw new DownloadError('Failed to read download progress', {
          code: 'download-search-failed',
          messageKey: 'error.download.progress',
          cause,
        });
      }
      const item = items[0];
      if (item === undefined) {
        return undefined;
      }
      return {
        id: item.id,
        state: mapState(item.state),
        bytesReceived: item.bytesReceived,
        bytesTotal: item.totalBytes,
      };
    },

    onChanged(listener: (change: DownloadChange) => void) {
      return changes.subscribe(listener);
    },
  };
}
