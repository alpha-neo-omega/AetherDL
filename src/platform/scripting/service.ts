/**
 * Module: platform/scripting (implementation)
 * Purpose: Implement {@link ScriptingAdapter} over the normalized `scripting`
 *          namespace. Isolated world only (§13.6); world is never set to MAIN.
 * Restrictions: Platform layer — adapts only; no product logic. The `scripting`
 *          namespace is absent in content-script contexts, so every call guards it.
 * Public API: createScriptingService.
 */
import type {
  ContentScriptFilter,
  InjectionResult,
  RegisteredContentScript,
  ScriptInjection,
  ScriptingAdapter,
} from '@platform/scripting';
import type {
  WebExtApi,
  WebExtRegisteredContentScript,
  WebExtScripting,
} from '@platform/browser/webext';
import { RuntimeError } from '@shared/result/errors';

function requireScripting(api: WebExtApi): WebExtScripting {
  const scripting = api.scripting;
  if (scripting === undefined) {
    throw new RuntimeError('Scripting API is unavailable in this context', {
      code: 'scripting-unavailable',
      messageKey: 'error.runtime.unavailable',
    });
  }
  return scripting;
}

function toNativeScript(script: RegisteredContentScript): WebExtRegisteredContentScript {
  // Isolated world is enforced here — the runtime cannot request MAIN (§13.6).
  return {
    id: script.id,
    matches: [...script.matches],
    world: 'ISOLATED',
    ...(script.js !== undefined && { js: [...script.js] }),
    ...(script.runAt !== undefined && { runAt: script.runAt }),
    ...(script.allFrames !== undefined && { allFrames: script.allFrames }),
    ...(script.persistAcrossSessions !== undefined && {
      persistAcrossSessions: script.persistAcrossSessions,
    }),
  };
}

/** Create the scripting service over a resolved WebExtension API. */
export function createScriptingService(api: WebExtApi): ScriptingAdapter {
  return {
    async executeScript(injection: ScriptInjection): Promise<readonly InjectionResult[]> {
      try {
        const results = await requireScripting(api).executeScript({
          target: {
            tabId: injection.target.tabId,
            ...(injection.target.allFrames !== undefined && {
              allFrames: injection.target.allFrames,
            }),
            ...(injection.target.frameIds !== undefined && {
              frameIds: [...injection.target.frameIds],
            }),
          },
          files: [...injection.files],
        });
        return results.map((result) => ({
          frameId: result.frameId,
          ...(result.result !== undefined && { result: result.result }),
        }));
      } catch (cause) {
        throw new RuntimeError('Script injection failed', {
          code: 'scripting-execute-failed',
          messageKey: 'error.runtime.scripting',
          cause,
        });
      }
    },

    async registerContentScripts(scripts: readonly RegisteredContentScript[]): Promise<void> {
      try {
        await requireScripting(api).registerContentScripts(scripts.map(toNativeScript));
      } catch (cause) {
        throw new RuntimeError('Content-script registration failed', {
          code: 'scripting-register-failed',
          messageKey: 'error.runtime.scripting',
          cause,
        });
      }
    },

    async unregisterContentScripts(filter?: ContentScriptFilter): Promise<void> {
      try {
        await requireScripting(api).unregisterContentScripts(
          filter?.ids === undefined ? undefined : { ids: [...filter.ids] },
        );
      } catch (cause) {
        throw new RuntimeError('Content-script unregistration failed', {
          code: 'scripting-unregister-failed',
          messageKey: 'error.runtime.scripting',
          cause,
        });
      }
    },
  };
}
