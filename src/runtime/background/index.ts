/**
 * Module: runtime/background (entry)
 * Purpose: Background surface entry point and composition root (PROJECT_BIBLE.md
 *          §8.9). Injects the concrete platform facade into the detection engine,
 *          the settings and history services, the background detection, download and
 *          settings runtimes, and the context-menu and notification integrations
 *          (dependency inversion, §8.4 rule 3). Every listener is registered
 *          synchronously at top level so it survives service-worker re-spawn (§8.9).
 *          The background is the sole owner of the Download Manager, the queue, the
 *          durable stores, and the settings/history services (§8.7, §10.1).
 * Restrictions: Thin surface — wiring/lifecycle only; no domain logic (§8.1).
 *          Coverage-excluded (touches the ambient browser namespace); the runtime
 *          logic lives in ./runtime, ./downloads, ./settings, ./contextmenu,
 *          ./notifications, ./state, ./download-state, ./badge, ./context and is
 *          unit-tested.
 */
import { createDetectionEngine } from '@core/detection/factory';
import { createHistoryService } from '@core/history/history';
import { createSettingsService } from '@core/settings/settings';
import {
  createHistoryRepository,
  HISTORY_DATABASE_NAME,
  HISTORY_STORE_NAME,
} from '@core/storage/history-repository';
import { createSettingsRepository } from '@core/storage/settings-repository';
import { QUEUE_DATABASE_NAME, QUEUE_STORE_NAME } from '@core/storage/queue-repository';
import { createBrowser } from '@platform/browser/factory';
import { createHttpClient } from '@platform/http/service';
import { createIndexedDbObjectStore } from '@platform/storage/indexeddb';
import type { AppError } from '@shared/result';
import { formatMessage } from '@shared/utils';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundSettingsRuntime } from '@runtime/background/settings';
import { createContextMenuRuntime } from '@runtime/background/contextmenu';
import { createNotificationRuntime } from '@runtime/background/notifications';

const browser = createBrowser();
const startedAt = Date.now();

// Storage failures from the core services reach the settings runtime's error
// stream; the indirection avoids a construction cycle between them.
let report: (error: AppError) => void = () => undefined;
const onError = (error: AppError): void => {
  report(error);
};

const settings = createSettingsService({
  repository: createSettingsRepository(browser.storage.local),
  onError,
});
const history = createHistoryService({
  repository: createHistoryRepository({
    store: createIndexedDbObjectStore({
      databaseName: HISTORY_DATABASE_NAME,
      storeName: HISTORY_STORE_NAME,
    }),
  }),
  settings,
  clock: () => Date.now(),
  sessionStartedAt: startedAt,
  onError,
});

const engine = createDetectionEngine();
const detection = createBackgroundRuntime({ browser, engine });
detection.start();

const downloads = createBackgroundDownloadRuntime({
  browser,
  resolver: createDetectionItemResolver(detection.state),
  store: createIndexedDbObjectStore({
    databaseName: QUEUE_DATABASE_NAME,
    storeName: QUEUE_STORE_NAME,
  }),
  history,
  // The settings service is the single source; the download runtime keeps no copy
  // and applies the download-related values to the system it owns (§4.9, §8.7).
  getSettings: () => settings.get(),
  // Reads a manifest — and only a manifest — so the popup can offer the qualities a
  // stream actually has (§10.6). The same single network door every other read uses.
  http: createHttpClient(),
});
downloads.start();

const settingsRuntime = createBackgroundSettingsRuntime({ browser, settings, history });
settingsRuntime.start();
report = settingsRuntime.reportError;

const message = (name: string, values?: Readonly<Record<string, string>>): string =>
  formatMessage(browser.i18n.getMessage(name), values);

const contextMenu = createContextMenuRuntime({
  browser,
  getSettings: () => settings.get(),
  getActiveItems: () => {
    const tabId = detection.state.activeTabId();
    return tabId === undefined ? [] : detection.state.getItems(tabId);
  },
  enqueue: (itemIds) => downloads.enqueue(itemIds),
  entryTitle: (item) => message('contextMenuDownload', { title: item.title }),
  onError,
});
contextMenu.start();

const notifications = createNotificationRuntime({
  browser,
  downloads,
  getSettings: () => settings.get(),
  copy: {
    completed: (task) => ({
      title: message('notificationCompletedTitle'),
      message: message('notificationCompletedMessage', { filename: task.filename }),
    }),
    failed: (task) => ({
      title: message('notificationFailedTitle'),
      message: message('notificationFailedMessage', { filename: task.filename }),
    }),
    queueCompleted: (summary) => ({
      title: message('notificationQueueTitle'),
      message: message('notificationQueueMessage', {
        completed: String(summary.completed),
        failed: String(summary.failed),
        canceled: String(summary.canceled),
      }),
    }),
  },
  onError,
});
notifications.start();

// The menu mirrors the active tab's supported media and the user's choice, so it is
// reconciled whenever either could have changed (§4.13).
settingsRuntime.on('settings:changed', (applied) => {
  // Concurrency, retries, filename template and subfolder take effect immediately on
  // the running Download System (§4.9); the menu follows the same event (§4.13).
  downloads.applySettings(applied);
  void contextMenu.sync();
});
detection.on('detection:finished', () => {
  void contextMenu.sync();
});
detection.on('tab:changed', () => {
  void contextMenu.sync();
});
void contextMenu.sync();
