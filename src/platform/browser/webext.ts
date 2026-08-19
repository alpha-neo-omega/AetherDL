/**
 * Module: platform/browser (WebExtension normalization)
 * Purpose: The single, typed boundary to the raw WebExtension namespace
 *          (PROJECT_BIBLE.md §7.3, §8.2). This is the ONLY file that reads the
 *          `chrome` / `browser` globals (§8.4). Everything else consumes the typed
 *          {@link WebExtApi} via dependency injection.
 * Responsibilities: Resolve the namespace (Firefox `browser` or Chromium `chrome`),
 *          detect the target, and expose minimal structural types for exactly the
 *          APIs Phase 2 uses. Both engines expose Promise-based MV3 APIs, so a single
 *          normalized surface serves both; per-target differences are captured as
 *          capabilities (see ./capabilities).
 * Restrictions: Platform layer — depends only on shared/. No product logic.
 * Public API: PlatformTarget, WebExt* structural types, WebExtApi, ResolvedApi,
 *          detectTarget, resolveWebExtApi.
 */
import { RuntimeError } from '@shared/result/errors';

/** The concrete browser family a build runs against. */
export type PlatformTarget = 'chrome' | 'firefox';

/** A WebExtension event source. */
export interface Listenable<L> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
  hasListener?(listener: L): boolean;
}

export interface WebExtStorageArea {
  get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface WebExtStorage {
  local: WebExtStorageArea;
  sync: WebExtStorageArea;
  session?: WebExtStorageArea;
}

export interface WebExtManifest {
  version: string;
  name?: string;
  manifest_version?: number;
  [key: string]: unknown;
}

export interface WebExtInstalledDetails {
  reason?: string;
  previousVersion?: string;
}

export interface WebExtTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  status?: string;
}

export interface WebExtMessageSender {
  tab?: WebExtTab;
  id?: string;
  url?: string;
}

export type WebExtSendResponse = (response?: unknown) => void;

export type WebExtMessageListener = (
  message: unknown,
  sender: WebExtMessageSender,
  sendResponse: WebExtSendResponse,
) => boolean | void | Promise<unknown>;

export interface WebExtRuntime {
  id?: string;
  getManifest(): WebExtManifest;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: Listenable<WebExtMessageListener>;
  onInstalled: Listenable<(details: WebExtInstalledDetails) => void>;
  onStartup: Listenable<() => void>;
  getBrowserInfo?(): Promise<{ name: string; version: string }>;
}

export interface WebExtTabChangeInfo {
  url?: string;
  status?: string;
}

export interface WebExtTabActiveInfo {
  tabId: number;
  windowId: number;
}

export interface WebExtTabRemoveInfo {
  windowId: number;
  isWindowClosing: boolean;
}

export interface WebExtTabAttachInfo {
  newWindowId: number;
  newPosition: number;
}

export interface WebExtTabDetachInfo {
  oldWindowId: number;
  oldPosition: number;
}

export interface WebExtTabs {
  query(query: {
    active?: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
  }): Promise<WebExtTab[]>;
  get(tabId: number): Promise<WebExtTab>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  onActivated: Listenable<(info: WebExtTabActiveInfo) => void>;
  onUpdated: Listenable<(tabId: number, changeInfo: WebExtTabChangeInfo, tab: WebExtTab) => void>;
  // --- Tab lifecycle (ratified additive extension) ---
  onCreated: Listenable<(tab: WebExtTab) => void>;
  onRemoved: Listenable<(tabId: number, removeInfo: WebExtTabRemoveInfo) => void>;
  onAttached: Listenable<(tabId: number, attachInfo: WebExtTabAttachInfo) => void>;
  onDetached: Listenable<(tabId: number, detachInfo: WebExtTabDetachInfo) => void>;
  onReplaced: Listenable<(addedTabId: number, removedTabId: number) => void>;
}

/** Toolbar action (`chrome.action` / `browser.action`) — badge + title + toggle. */
export interface WebExtActionBadgeText {
  text: string;
  tabId?: number;
}

export interface WebExtActionBadgeColor {
  color: string;
  tabId?: number;
}

export interface WebExtActionTitle {
  title: string;
  tabId?: number;
}

export interface WebExtAction {
  setBadgeText(details: WebExtActionBadgeText): Promise<void>;
  setBadgeBackgroundColor(details: WebExtActionBadgeColor): Promise<void>;
  setTitle(details: WebExtActionTitle): Promise<void>;
  enable(tabId?: number): Promise<void>;
  disable(tabId?: number): Promise<void>;
}

/** `chrome.scripting` / `browser.scripting` — programmatic injection + registration. */
export interface WebExtScriptInjection {
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
  files: string[];
}

export interface WebExtInjectionResult {
  frameId: number;
  result?: unknown;
}

export interface WebExtRegisteredContentScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: string;
  allFrames?: boolean;
  world?: string;
  persistAcrossSessions?: boolean;
}

export interface WebExtContentScriptFilter {
  ids?: string[];
}

export interface WebExtScripting {
  executeScript(injection: WebExtScriptInjection): Promise<WebExtInjectionResult[]>;
  registerContentScripts(scripts: WebExtRegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: WebExtContentScriptFilter): Promise<void>;
}

export interface WebExtWindow {
  id?: number;
  focused?: boolean;
}

export interface WebExtWindows {
  getCurrent(): Promise<WebExtWindow>;
  getLastFocused(): Promise<WebExtWindow>;
}

export interface WebExtDownloadOptions {
  url: string;
  filename?: string;
  conflictAction?: string;
  saveAs?: boolean;
}

export interface WebExtDownloadItem {
  id: number;
  state?: string;
  bytesReceived?: number;
  totalBytes?: number;
  filename?: string;
  error?: string;
}

export interface WebExtDownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

export interface WebExtDownloads {
  download(options: WebExtDownloadOptions): Promise<number>;
  cancel(downloadId: number): Promise<void>;
  search(query: { id: number }): Promise<WebExtDownloadItem[]>;
  onChanged: Listenable<(delta: WebExtDownloadDelta) => void>;
}

export interface WebExtPermissionSet {
  permissions?: readonly string[];
  origins?: readonly string[];
}

export interface WebExtPermissions {
  contains(permissions: WebExtPermissionSet): Promise<boolean>;
  request(permissions: WebExtPermissionSet): Promise<boolean>;
  remove(permissions: WebExtPermissionSet): Promise<boolean>;
  getAll(): Promise<WebExtPermissionSet>;
}

/** Menu item creation properties shared by `contextMenus` and `menus` (§7.4). */
export interface WebExtMenuCreateProperties {
  id: string;
  title: string;
  contexts: readonly string[];
}

/** The click payload both engines deliver to a menu listener. */
export interface WebExtMenuOnClickData {
  menuItemId: string | number;
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
}

/** `chrome.contextMenus` / `browser.menus` — normalized in platform/menus. */
export interface WebExtMenus {
  create(properties: WebExtMenuCreateProperties, callback?: () => void): void;
  remove(menuItemId: string): Promise<void>;
  removeAll(): Promise<void>;
  onClicked: Listenable<(info: WebExtMenuOnClickData, tab?: WebExtTab) => void>;
}

export interface WebExtNotificationOptions {
  type: string;
  title: string;
  message: string;
  iconUrl?: string;
}

export interface WebExtNotifications {
  create(notificationId: string, options: WebExtNotificationOptions): Promise<string>;
  clear(notificationId: string): Promise<boolean>;
  onClicked: Listenable<(notificationId: string) => void>;
}

export interface WebExtCommands {
  onCommand: Listenable<(command: string) => void>;
}

/** `i18n` — the WebExtension message catalogue (§19.1). Needs no permission. */
export interface WebExtI18n {
  getMessage(messageName: string, substitutions?: readonly string[]): string;
  getUILanguage?(): string;
}

/** The normalized WebExtension surface consumed by platform services. */
export interface WebExtApi {
  runtime: WebExtRuntime;
  tabs: WebExtTabs;
  windows: WebExtWindows;
  downloads: WebExtDownloads;
  storage: WebExtStorage;
  permissions: WebExtPermissions;
  // Toolbar action + scripting (ratified additive extension). Present in extension
  // contexts (background/popup); absent in content scripts — consumers feature-check.
  action?: WebExtAction;
  scripting?: WebExtScripting;
  // Optional namespaces: probed by capability detection and adapted in Phase 7.
  // They are absent until their optional permission is granted (§13.3), so every
  // consumer feature-checks before use.
  notifications?: WebExtNotifications;
  contextMenus?: WebExtMenus;
  menus?: WebExtMenus;
  commands?: WebExtCommands;
  i18n?: WebExtI18n;
}

/** Result of resolving the ambient namespace. */
export interface ResolvedApi {
  readonly api: WebExtApi;
  readonly target: PlatformTarget;
}

interface GlobalWithWebExt {
  browser?: unknown;
  chrome?: unknown;
}

/**
 * Detect the target family. Firefox exposes `runtime.getBrowserInfo`; Chromium
 * does not. This is capability-based, not user-agent sniffing (§7.2).
 */
export function detectTarget(api: WebExtApi): PlatformTarget {
  return typeof api.runtime.getBrowserInfo === 'function' ? 'firefox' : 'chrome';
}

/**
 * Resolve the ambient WebExtension namespace into a typed {@link WebExtApi}.
 * Prefers Firefox's promise-native `browser`; falls back to Chromium's `chrome`
 * (promise-based in MV3). Throws {@link RuntimeError} when unavailable.
 */
export function resolveWebExtApi(): ResolvedApi {
  const globalScope = globalThis as GlobalWithWebExt;
  const namespace = globalScope.browser ?? globalScope.chrome;
  if (namespace === null || typeof namespace !== 'object') {
    throw new RuntimeError('WebExtension APIs are unavailable in this context', {
      code: 'runtime-no-webext',
      messageKey: 'error.runtime.unavailable',
    });
  }
  const api = namespace as WebExtApi;
  if (typeof api.runtime?.getManifest !== 'function') {
    throw new RuntimeError('WebExtension runtime API is unavailable', {
      code: 'runtime-no-runtime-api',
      messageKey: 'error.runtime.unavailable',
    });
  }
  return { api, target: detectTarget(api) };
}
