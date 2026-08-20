/**
 * Test double: an in-memory WebExtension namespace implementing the structural
 * {@link WebExtApi}. Used to verify the platform layer against both a Firefox-like
 * API (with `runtime.getBrowserInfo`) and a Chromium-like API (without), plus a
 * single-process message hub for request/response round-trips.
 *
 * Not a test file — imported by the platform specs.
 */
import type {
  WebExtApi,
  WebExtActionBadgeColor,
  WebExtActionBadgeText,
  WebExtActionTitle,
  WebExtContentScriptFilter,
  WebExtDownloadDelta,
  WebExtDownloadItem,
  WebExtDownloadOptions,
  WebExtInstalledDetails,
  WebExtManifest,
  WebExtMenuCreateProperties,
  WebExtMenuOnClickData,
  WebExtMessageListener,
  WebExtNotificationOptions,
  WebExtPermissionSet,
  WebExtRegisteredContentScript,
  WebExtScriptInjection,
  WebExtStorageArea,
  WebExtTab,
  WebExtTabActiveInfo,
  WebExtTabAttachInfo,
  WebExtTabChangeInfo,
  WebExtTabDetachInfo,
  WebExtTabRemoveInfo,
  WebExtWindow,
} from '@platform/browser/webext';

/** Recorded toolbar-action writes, keyed by tabId (or 'global' when unscoped). */
export interface FakeActionState {
  readonly badgeText: Map<number | 'global', string>;
  readonly badgeColor: Map<number | 'global', string>;
  readonly title: Map<number | 'global', string>;
  readonly enabled: Map<number | 'global', boolean>;
}

/** Recorded scripting operations. */
export interface FakeScriptingState {
  readonly executed: WebExtScriptInjection[];
  readonly registered: WebExtRegisteredContentScript[];
  readonly unregistered: (WebExtContentScriptFilter | undefined)[];
}

export class FakeEvent<L extends (...args: never[]) => unknown> {
  private readonly registered = new Set<L>();

  addListener(listener: L): void {
    this.registered.add(listener);
  }

  removeListener(listener: L): void {
    this.registered.delete(listener);
  }

  hasListener(listener: L): boolean {
    return this.registered.has(listener);
  }

  get size(): number {
    return this.registered.size;
  }

  listeners(): readonly L[] {
    return [...this.registered];
  }

  trigger(...args: Parameters<L>): void {
    for (const listener of [...this.registered]) {
      (listener as (...a: Parameters<L>) => unknown)(...args);
    }
  }
}

class FakeStorageArea implements WebExtStorageArea {
  readonly data = new Map<string, unknown>();

  async get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) {
      return Object.fromEntries(this.data);
    }
    const list = typeof keys === 'string' ? [keys] : [...keys];
    const out: Record<string, unknown> = {};
    for (const key of list) {
      if (this.data.has(key)) {
        out[key] = this.data.get(key);
      }
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, value);
    }
  }

  async remove(keys: string | readonly string[]): Promise<void> {
    const list = typeof keys === 'string' ? [keys] : [...keys];
    for (const key of list) {
      this.data.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export interface FakeWebExtOptions {
  readonly firefox?: boolean;
  readonly withSession?: boolean;
  readonly manifestVersion?: string;
  readonly extensionId?: string;
  readonly menus?: boolean;
  readonly contextMenus?: boolean;
  readonly notifications?: boolean;
  readonly commands?: boolean;
  /**
   * Optional permissions the manifest declares. Defaults to the shipped set for the
   * target: Chromium offers `contextMenus` optionally, Firefox does not (§13.3).
   */
  readonly optionalPermissions?: readonly string[];
  /** Seed the i18n catalogue; omit the option entirely to drop the namespace. */
  readonly messages?: Readonly<Record<string, string>>;
  readonly uiLanguage?: string;
}

export interface FakeWebExt {
  readonly api: WebExtApi;
  readonly onInstalled: FakeEvent<(details: WebExtInstalledDetails) => void>;
  readonly onStartup: FakeEvent<() => void>;
  readonly onActivated: FakeEvent<(info: WebExtTabActiveInfo) => void>;
  readonly onUpdated: FakeEvent<
    (tabId: number, changeInfo: WebExtTabChangeInfo, tab: WebExtTab) => void
  >;
  readonly onTabCreated: FakeEvent<(tab: WebExtTab) => void>;
  readonly onTabRemoved: FakeEvent<(tabId: number, removeInfo: WebExtTabRemoveInfo) => void>;
  readonly onTabAttached: FakeEvent<(tabId: number, attachInfo: WebExtTabAttachInfo) => void>;
  readonly onTabDetached: FakeEvent<(tabId: number, detachInfo: WebExtTabDetachInfo) => void>;
  readonly onTabReplaced: FakeEvent<(addedTabId: number, removedTabId: number) => void>;
  readonly onDownloadChanged: FakeEvent<(delta: WebExtDownloadDelta) => void>;
  readonly onMessage: FakeEvent<WebExtMessageListener>;
  readonly local: FakeStorageArea;
  readonly sync: FakeStorageArea;
  readonly session: FakeStorageArea | undefined;
  readonly downloadItems: Map<number, WebExtDownloadItem>;
  readonly grantedPermissions: Set<string>;
  readonly grantedOrigins: Set<string>;
  readonly action: FakeActionState;
  readonly scripting: FakeScriptingState;
  /** Menu entries currently registered, keyed by id. */
  readonly menuItems: Map<string, WebExtMenuCreateProperties>;
  readonly onMenuClicked: FakeEvent<(info: WebExtMenuOnClickData, tab?: WebExtTab) => void>;
  /** Notifications currently shown, keyed by id. */
  readonly notifications: Map<string, WebExtNotificationOptions>;
  readonly onNotificationClicked: FakeEvent<(notificationId: string) => void>;
  readonly onCommand: FakeEvent<(command: string) => void>;
  /** When true, the next menu create/remove throws. */
  failMenus: boolean;
  /** When true, the next notification create rejects. */
  failNotifications: boolean;
  /** When true, every permission request is declined, as a user can decline. */
  denyPermissions: boolean;
  setTabs(tabs: readonly WebExtTab[]): void;
  setCurrentWindow(window: WebExtWindow): void;
}

export function createFakeWebExt(options: FakeWebExtOptions = {}): FakeWebExt {
  const onInstalled = new FakeEvent<(details: WebExtInstalledDetails) => void>();
  const onStartup = new FakeEvent<() => void>();
  const onActivated = new FakeEvent<(info: WebExtTabActiveInfo) => void>();
  const onUpdated = new FakeEvent<
    (tabId: number, changeInfo: WebExtTabChangeInfo, tab: WebExtTab) => void
  >();
  const onTabCreated = new FakeEvent<(tab: WebExtTab) => void>();
  const onTabRemoved = new FakeEvent<(tabId: number, removeInfo: WebExtTabRemoveInfo) => void>();
  const onTabAttached = new FakeEvent<(tabId: number, attachInfo: WebExtTabAttachInfo) => void>();
  const onTabDetached = new FakeEvent<(tabId: number, detachInfo: WebExtTabDetachInfo) => void>();
  const onTabReplaced = new FakeEvent<(addedTabId: number, removedTabId: number) => void>();
  const onDownloadChanged = new FakeEvent<(delta: WebExtDownloadDelta) => void>();
  const onMessage = new FakeEvent<WebExtMessageListener>();

  const actionState: FakeActionState = {
    badgeText: new Map<number | 'global', string>(),
    badgeColor: new Map<number | 'global', string>(),
    title: new Map<number | 'global', string>(),
    enabled: new Map<number | 'global', boolean>(),
  };
  const scriptingState: FakeScriptingState = { executed: [], registered: [], unregistered: [] };
  const actionKey = (tabId?: number): number | 'global' => tabId ?? 'global';

  const local = new FakeStorageArea();
  const sync = new FakeStorageArea();
  const session = options.withSession === true ? new FakeStorageArea() : undefined;

  const downloadItems = new Map<number, WebExtDownloadItem>();
  let nextDownloadId = 1;

  const grantedPermissions = new Set<string>();
  const grantedOrigins = new Set<string>();

  let tabs: WebExtTab[] = [];
  let currentWindow: WebExtWindow = { id: 1, focused: true };

  const manifest: WebExtManifest = {
    version: options.manifestVersion ?? '0.1.0',
    name: 'AetherDL',
    manifest_version: 3,
    optional_permissions:
      options.optionalPermissions ??
      (options.firefox === true ? ['notifications'] : ['notifications', 'contextMenus']),
  };

  const runtime: WebExtApi['runtime'] = {
    id: options.extensionId ?? 'fake-extension-id',
    getManifest: () => manifest,
    getURL: (path: string) => `chrome-extension://fake/${path.replace(/^\/+/, '')}`,
    sendMessage: (message: unknown) =>
      new Promise<unknown>((resolve) => {
        let settled = false;
        let expectAsync = false;
        const respond = (response?: unknown): void => {
          if (!settled) {
            settled = true;
            resolve(response);
          }
        };
        for (const listener of onMessage.listeners()) {
          const result = listener(message, { id: 'fake-sender' }, respond);
          if (result === true) {
            expectAsync = true;
          } else if (isThenable(result)) {
            expectAsync = true;
            void result.then((value) => {
              respond(value);
            });
          }
        }
        if (!expectAsync) {
          resolve(undefined);
        }
      }),
    onMessage,
    onInstalled,
    onStartup,
  };

  if (options.firefox === true) {
    runtime.getBrowserInfo = () => Promise.resolve({ name: 'Firefox', version: '128.0' });
  }

  const api: WebExtApi = {
    runtime,
    tabs: {
      query: async () => tabs.filter((tab) => tab.active !== false),
      get: async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab === undefined) {
          throw new Error(`No tab ${tabId}`);
        }
        return tab;
      },
      sendMessage: async () => undefined,
      onActivated,
      onUpdated,
      onCreated: onTabCreated,
      onRemoved: onTabRemoved,
      onAttached: onTabAttached,
      onDetached: onTabDetached,
      onReplaced: onTabReplaced,
    },
    action: {
      setBadgeText: async (details: WebExtActionBadgeText) => {
        actionState.badgeText.set(actionKey(details.tabId), details.text);
      },
      setBadgeBackgroundColor: async (details: WebExtActionBadgeColor) => {
        actionState.badgeColor.set(actionKey(details.tabId), details.color);
      },
      setTitle: async (details: WebExtActionTitle) => {
        actionState.title.set(actionKey(details.tabId), details.title);
      },
      enable: async (tabId?: number) => {
        actionState.enabled.set(actionKey(tabId), true);
      },
      disable: async (tabId?: number) => {
        actionState.enabled.set(actionKey(tabId), false);
      },
    },
    scripting: {
      executeScript: async (injection: WebExtScriptInjection) => {
        scriptingState.executed.push(injection);
        return [{ frameId: 0 }];
      },
      registerContentScripts: async (scripts: WebExtRegisteredContentScript[]) => {
        scriptingState.registered.push(...scripts);
      },
      unregisterContentScripts: async (filter?: WebExtContentScriptFilter) => {
        scriptingState.unregistered.push(filter);
      },
    },
    windows: {
      getCurrent: async () => currentWindow,
      getLastFocused: async () => currentWindow,
    },
    downloads: {
      download: async (downloadOptions: WebExtDownloadOptions) => {
        const id = nextDownloadId;
        nextDownloadId += 1;
        downloadItems.set(id, {
          id,
          state: 'in_progress',
          bytesReceived: 0,
          totalBytes: 100,
          filename: downloadOptions.filename ?? 'download',
        });
        return id;
      },
      cancel: async (downloadId: number) => {
        const item = downloadItems.get(downloadId);
        if (item !== undefined) {
          downloadItems.set(downloadId, { ...item, state: 'interrupted' });
        }
      },
      search: async (query: { id: number }) => {
        const item = downloadItems.get(query.id);
        return item === undefined ? [] : [item];
      },
      onChanged: onDownloadChanged,
    },
    storage: session === undefined ? { local, sync } : { local, sync, session },
    permissions: {
      contains: async (set: WebExtPermissionSet) =>
        (set.permissions ?? []).every((perm) => grantedPermissions.has(perm)) &&
        (set.origins ?? []).every((origin) => grantedOrigins.has(origin)),
      request: async (set: WebExtPermissionSet) => {
        if (flags.denyPermissions) {
          return false;
        }
        for (const perm of set.permissions ?? []) {
          grantedPermissions.add(perm);
        }
        for (const origin of set.origins ?? []) {
          grantedOrigins.add(origin);
        }
        return true;
      },
      remove: async (set: WebExtPermissionSet) => {
        for (const perm of set.permissions ?? []) {
          grantedPermissions.delete(perm);
        }
        for (const origin of set.origins ?? []) {
          grantedOrigins.delete(origin);
        }
        return true;
      },
      getAll: async () => ({
        permissions: [...grantedPermissions],
        origins: [...grantedOrigins],
      }),
    },
  };

  const menuItems = new Map<string, WebExtMenuCreateProperties>();
  const onMenuClicked = new FakeEvent<(info: WebExtMenuOnClickData, tab?: WebExtTab) => void>();
  const notifications = new Map<string, WebExtNotificationOptions>();
  const onNotificationClicked = new FakeEvent<(notificationId: string) => void>();
  const onCommand = new FakeEvent<(command: string) => void>();
  const flags = { failMenus: false, failNotifications: false, denyPermissions: false };

  const menusNamespace = {
    create(properties: WebExtMenuCreateProperties, callback?: () => void): void {
      if (flags.failMenus) {
        throw new Error('menu create failed');
      }
      menuItems.set(properties.id, properties);
      callback?.();
    },
    async remove(menuItemId: string): Promise<void> {
      if (flags.failMenus) {
        throw new Error('menu remove failed');
      }
      menuItems.delete(menuItemId);
    },
    async removeAll(): Promise<void> {
      menuItems.clear();
    },
    onClicked: onMenuClicked,
  };

  if (options.menus === true) {
    api.menus = menusNamespace;
  }
  if (options.contextMenus === true) {
    api.contextMenus = menusNamespace;
  }
  if (options.notifications === true) {
    api.notifications = {
      async create(notificationId: string, opts: WebExtNotificationOptions): Promise<string> {
        if (flags.failNotifications) {
          throw new Error('notification create failed');
        }
        notifications.set(notificationId, opts);
        return notificationId;
      },
      async clear(notificationId: string): Promise<boolean> {
        return notifications.delete(notificationId);
      },
      onClicked: onNotificationClicked,
    };
  }
  if (options.commands === true) {
    api.commands = { onCommand };
  }
  if (options.messages !== undefined) {
    const catalogue = options.messages;
    api.i18n = {
      getMessage: (name: string) => catalogue[name] ?? '',
      getUILanguage: () => options.uiLanguage ?? 'en',
    };
  }

  return {
    api,
    onInstalled,
    onStartup,
    onActivated,
    onUpdated,
    onTabCreated,
    onTabRemoved,
    onTabAttached,
    onTabDetached,
    onTabReplaced,
    onDownloadChanged,
    onMessage,
    local,
    sync,
    session,
    downloadItems,
    grantedPermissions,
    grantedOrigins,
    action: actionState,
    scripting: scriptingState,
    menuItems,
    onMenuClicked,
    notifications,
    onNotificationClicked,
    onCommand,
    get failMenus(): boolean {
      return flags.failMenus;
    },
    set failMenus(value: boolean) {
      flags.failMenus = value;
    },
    get failNotifications(): boolean {
      return flags.failNotifications;
    },
    get denyPermissions(): boolean {
      return flags.denyPermissions;
    },
    set denyPermissions(value: boolean) {
      flags.denyPermissions = value;
    },
    set failNotifications(value: boolean) {
      flags.failNotifications = value;
    },
    setTabs: (next: readonly WebExtTab[]) => {
      tabs = [...next];
    },
    setCurrentWindow: (window: WebExtWindow) => {
      currentWindow = window;
    },
  };
}
