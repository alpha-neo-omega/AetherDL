/**
 * Module: platform/scripting
 * Purpose: Programmatic content-script injection + registration abstraction over
 *          `chrome.scripting` / `browser.scripting` (PROJECT_BIBLE.md §8.10, §13.7).
 *          Ratified additive platform capability; the ONLY home for `scripting`
 *          access (§8.4). Injection POLICY (when/where) is decided by the runtime,
 *          not here — this is a capability only (no automatic/global injection).
 * Restrictions: Platform layer — depends only on shared/. No product logic.
 * Public API: ScriptTarget, ScriptInjection, InjectionResult,
 *          RegisteredContentScript, ContentScriptFilter, ScriptingAdapter.
 */

/** The tab (and optionally frames) an injection targets. */
export interface ScriptTarget {
  readonly tabId: number;
  readonly allFrames?: boolean;
  readonly frameIds?: readonly number[];
}

/** A one-off script injection request (files only; no arbitrary code strings, §13). */
export interface ScriptInjection {
  readonly target: ScriptTarget;
  readonly files: readonly string[];
}

/** Per-frame result of an injection. */
export interface InjectionResult {
  readonly frameId: number;
  readonly result?: unknown;
}

/** A persistently registered content script (isolated world only, §13.6). */
export interface RegisteredContentScript {
  readonly id: string;
  readonly matches: readonly string[];
  readonly js?: readonly string[];
  readonly runAt?: 'document_start' | 'document_end' | 'document_idle';
  readonly allFrames?: boolean;
  readonly persistAcrossSessions?: boolean;
}

/** Filter for unregistering scripts; omitted removes all registered by this ext. */
export interface ContentScriptFilter {
  readonly ids?: readonly string[];
}

export interface ScriptingAdapter {
  /** Inject files into a target tab/frames; resolves with per-frame results. */
  executeScript(injection: ScriptInjection): Promise<readonly InjectionResult[]>;
  /** Register persistent content scripts (isolated world). */
  registerContentScripts(scripts: readonly RegisteredContentScript[]): Promise<void>;
  /** Unregister previously registered content scripts. */
  unregisterContentScripts(filter?: ContentScriptFilter): Promise<void>;
}
