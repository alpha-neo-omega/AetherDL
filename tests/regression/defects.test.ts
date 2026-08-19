/**
 * Regression suite (PROJECT_BIBLE.md §16.5): one test per fixed defect, each
 * reproducing the original failure. The suite only grows — a test here is never
 * deleted to make something pass (§16.5, AGENT_RULES T5/T6).
 *
 * Each case records the phase the defect was found in and what the user saw.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { createIndexedDbObjectStore } from '@platform/storage/indexeddb';
import { createDetectionEngine } from '@core/detection/factory';
import {
  createHistoryRepository,
  HISTORY_DATABASE_NAME,
  HISTORY_STORE_NAME,
} from '@core/storage/history-repository';
import {
  createQueueRepository,
  QUEUE_DATABASE_NAME,
  QUEUE_STORE_NAME,
} from '@core/storage/queue-repository';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { ValidationError } from '@shared/result/errors';
import { EN_MESSAGES } from '@ui/popup';
import {
  createSettingsTranslator,
  describeSettingsError,
  SETTINGS_EN_MESSAGES,
} from '@ui/settings';
import { createFakeIndexedDb } from '../unit/platform/_fake-indexeddb';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { downloadTask, mediaItem } from '../unit/core/storage/_fixtures';

describe('regression: the content script was never injected (Phase 9)', () => {
  /**
   * The shipped extension declared no `content_scripts` and never called
   * `scripting.executeScript`, so `content.js` shipped but never ran: DOM detection
   * could not happen in any browser. Fixed by injecting on the gesture-backed
   * `detection/refresh` (§8.10, §13.7).
   */
  it('injects the observer into the tab a surface asks to refresh', async () => {
    const fake = createFakeWebExt();
    fake.setTabs([{ id: 4, active: true, url: 'https://example.com/watch', windowId: 1 }]);
    const browser = createBrowserFrom(fake.api, 'chrome');
    const runtime = createBackgroundRuntime({ browser, engine: createDetectionEngine({}) });
    runtime.start();
    const client = createMessageBus(fake.api);

    await client.send('detection/refresh', { tabId: 4 });

    expect(fake.scripting.executed).toEqual([{ target: { tabId: 4 }, files: ['content.js'] }]);

    client.dispose();
    await runtime.dispose();
    browser.messaging.dispose();
  });
});

describe('regression: history silently recorded nothing (Phase 9)', () => {
  /**
   * The queue and the history both opened the database `aetherdl` at version 1 with
   * different object stores. `onupgradeneeded` fires only when the version rises, so
   * whichever adapter opened second found its store missing and every write failed —
   * completed downloads never reached history, with no visible error. Fixed by
   * giving each store its own database and by having the adapter create a missing
   * store (and release the database for someone else's upgrade).
   */
  it('persists the queue and history side by side', async () => {
    const idb = createFakeIndexedDb();
    const queue = createQueueRepository({
      store: createIndexedDbObjectStore({
        databaseName: QUEUE_DATABASE_NAME,
        storeName: QUEUE_STORE_NAME,
        factory: idb.factory,
      }),
      onError: (error) => {
        throw new Error(`the queue must persist: ${error.code}`);
      },
    });
    const history = createHistoryRepository({
      store: createIndexedDbObjectStore({
        databaseName: HISTORY_DATABASE_NAME,
        storeName: HISTORY_STORE_NAME,
        factory: idb.factory,
      }),
    });

    await queue.save([downloadTask({ id: 'job-1', item: mediaItem() })]);
    await history.append({
      id: 'rec-1',
      title: 'Holiday Clip',
      kind: 'video',
      originHost: 'example.com',
      timestamp: 1,
      outcome: 'completed',
      filename: 'clip.mp4',
    });

    expect((await queue.load()).map((task) => task.id)).toEqual(['job-1']);
    expect((await history.load()).map((record) => record.id)).toEqual(['rec-1']);
  });

  it('keeps the two stores in separate databases', () => {
    expect(HISTORY_DATABASE_NAME).not.toBe(QUEUE_DATABASE_NAME);
  });
});

describe('regression: settings validation errors lost their category (Phase 7)', () => {
  /**
   * The message bus normalizes an error to `internal` on the wire, so a rejected
   * settings value reached the page as a generic internal failure and the user was
   * told to retry instead of being told the value was invalid. Fixed by recognizing
   * the stable validation codes in the surface's error mapper.
   */
  it('describes a wire-normalized validation failure as a validation problem', () => {
    const t = createSettingsTranslator();
    const wireError = new ValidationError('Invalid value', {
      code: 'settings-invalid-maxRetries',
      messageKey: 'error.internal',
    }).toAppError();

    const described = describeSettingsError({ ...wireError, category: 'internal' }, t);

    expect(described.detail).toBe(t('settings.error.invalid'));
    expect(described.detail).not.toBe(t('settings.error.internal'));
  });
});

describe('regression: the settings catalogue overwrote popup copy (Phase 7)', () => {
  /**
   * Both catalogues defined `error.*` keys; generating the locale file let the
   * settings text overwrite the popup's, so the popup showed settings wording.
   * Fixed by namespacing the settings keys under `settings.error.*`.
   */
  it('shares no message key between the popup and settings catalogues', () => {
    const shared = Object.keys(EN_MESSAGES).filter((key) => key in SETTINGS_EN_MESSAGES);
    expect(shared).toEqual([]);
  });
});
