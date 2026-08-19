/**
 * The slice of the WebExtension namespace the e2e suite touches from inside the
 * browser. Declared locally rather than pulling in a types package: the suite calls
 * a handful of APIs, and the extension's own code never uses these globals outside
 * `src/platform/` (§8.4). Not a test file.
 */
interface E2eDownloadItem {
  readonly state: string;
  readonly bytesReceived: number;
  readonly url: string;
}

interface E2eTab {
  readonly id?: number;
  readonly url?: string;
}

declare const chrome: {
  readonly runtime: {
    getManifest(): Record<string, unknown> & {
      manifest_version: number;
      permissions?: readonly string[];
      host_permissions?: readonly string[];
    };
    sendMessage(message: unknown): Promise<unknown>;
  };
  readonly tabs: {
    query(filter: Record<string, unknown>): Promise<readonly E2eTab[]>;
  };
  readonly action: {
    getBadgeText(details: { tabId: number }): Promise<string>;
    openPopup(): Promise<void>;
  };
  readonly downloads: {
    search(filter: Record<string, unknown>): Promise<readonly E2eDownloadItem[]>;
  };
  readonly permissions: {
    request(request: { permissions: readonly string[] }): Promise<boolean>;
    remove(request: { permissions: readonly string[] }): Promise<boolean>;
    getAll(): Promise<{ permissions?: readonly string[]; origins?: readonly string[] }>;
  };
};
