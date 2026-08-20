/**
 * Module: platform/messaging (implementation)
 * Purpose: Implement {@link MessageBus} over the normalized WebExtension runtime
 *          messaging API (PROJECT_BIBLE.md §8.5). Provides request/response with
 *          timeouts, one-way broadcast, boundary validation (§13.8), and error
 *          propagation. A single runtime listener is installed lazily and detached
 *          on dispose (no leak).
 * Restrictions: Platform layer — adapts only; no domain logic. Foreign/malformed
 *          messages are ignored, never trusted (§13.8).
 * Public API: createMessageBus.
 */
import type {
  BroadcastListener,
  MessageBus,
  MessageHandler,
  SendOptions,
} from '@platform/messaging';
import type {
  WebExtApi,
  WebExtMessageListener,
  WebExtSendResponse,
} from '@platform/browser/webext';
import { MessagingError, PlatformError } from '@shared/result/errors';
import type { MessageMap, MessageType } from '@shared/types';
import { TypedEventEmitter, type Unsubscribe } from '@shared/utils';

const MARKER = '__aetherdl_msg__';
const DEFAULT_TIMEOUT_MS = 5000;

interface WireError {
  readonly message: string;
  readonly code: string;
}

interface RequestEnvelope {
  readonly __aetherdl_msg__: true;
  readonly kind: 'request';
  readonly type: string;
  readonly payload: unknown;
  readonly id: string;
}

interface BroadcastEnvelope {
  readonly __aetherdl_msg__: true;
  readonly kind: 'broadcast';
  readonly type: string;
  readonly payload: unknown;
}

interface ResponseEnvelope {
  readonly __aetherdl_msg__: true;
  readonly kind: 'response';
  readonly id: string;
  readonly ok: boolean;
  readonly payload: unknown;
  readonly error: WireError | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOurEnvelope(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return record !== undefined && record[MARKER] === true;
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record[MARKER] === true &&
    record['kind'] === 'response' &&
    typeof record['id'] === 'string' &&
    typeof record['ok'] === 'boolean'
  );
}

function toWireError(error: unknown): WireError {
  if (error instanceof PlatformError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: 'messaging-handler-error' };
  }
  return { message: String(error), code: 'messaging-handler-error' };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, type: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(
        new MessagingError(`Message "${type}" timed out after ${timeoutMs}ms`, {
          code: 'messaging-timeout',
          messageKey: 'error.messaging.timeout',
          retryable: true,
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Create the message bus over a resolved WebExtension API. */
export function createMessageBus(api: WebExtApi): MessageBus {
  const handlers = new Map<string, (request: unknown) => unknown | Promise<unknown>>();
  const broadcasts = new TypedEventEmitter<Record<string, [unknown]>>();
  let installed = false;

  const router: WebExtMessageListener = (
    message: unknown,
    _sender,
    sendResponse: WebExtSendResponse,
  ): boolean | void => {
    if (!isOurEnvelope(message)) {
      return undefined;
    }
    const kind = message['kind'];

    if (kind === 'request') {
      const type = message['type'];
      const id = message['id'];
      if (typeof type !== 'string' || typeof id !== 'string') {
        return undefined;
      }
      const handler = handlers.get(type);
      if (handler === undefined) {
        return undefined;
      }
      Promise.resolve()
        .then(() => handler(message['payload']))
        .then(
          (result) => {
            const response: ResponseEnvelope = {
              [MARKER]: true,
              kind: 'response',
              id,
              ok: true,
              payload: result,
              error: undefined,
            };
            sendResponse(response);
          },
          (error: unknown) => {
            const response: ResponseEnvelope = {
              [MARKER]: true,
              kind: 'response',
              id,
              ok: false,
              payload: undefined,
              error: toWireError(error),
            };
            sendResponse(response);
          },
        );
      return true;
    }

    if (kind === 'broadcast') {
      const type = message['type'];
      if (typeof type === 'string') {
        broadcasts.emit(type, message['payload']);
      }
      return undefined;
    }

    return undefined;
  };

  const ensureListener = (): void => {
    if (!installed) {
      api.runtime.onMessage.addListener(router);
      installed = true;
    }
  };

  return {
    async send<T extends MessageType>(
      type: T,
      request: MessageMap[T]['request'],
      options?: SendOptions,
    ): Promise<MessageMap[T]['response']> {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const envelope: RequestEnvelope = {
        [MARKER]: true,
        kind: 'request',
        type,
        payload: request,
        id: crypto.randomUUID(),
      };
      let raw: unknown;
      try {
        raw = await withTimeout(api.runtime.sendMessage(envelope), timeoutMs, type);
      } catch (cause) {
        if (cause instanceof MessagingError) {
          throw cause;
        }
        throw new MessagingError(`Transport failed for "${type}"`, {
          code: 'messaging-transport-failed',
          messageKey: 'error.messaging.transport',
          cause,
        });
      }
      if (!isResponseEnvelope(raw)) {
        throw new MessagingError(`No valid response for "${type}"`, {
          code: 'messaging-no-response',
          messageKey: 'error.messaging.noResponse',
        });
      }
      if (!raw.ok) {
        throw new MessagingError(raw.error?.message ?? 'Message handler failed', {
          code: raw.error?.code ?? 'messaging-handler-error',
          messageKey: 'error.messaging.handler',
        });
      }
      return raw.payload as MessageMap[T]['response'];
    },

    on<T extends MessageType>(type: T, handler: MessageHandler<T>): Unsubscribe {
      ensureListener();
      const entry = handler as (request: unknown) => unknown | Promise<unknown>;
      // One responder per type per context (§8.5). A second registration used to
      // replace the first in silence, so a wiring mistake — two runtimes claiming the
      // same message, or a surface started twice — left a handler that would never be
      // called again and no sign of it anywhere.
      if (handlers.has(type)) {
        throw new MessagingError(`A handler for "${type}" is already registered`, {
          code: 'messaging-duplicate-handler',
          messageKey: 'error.messaging.handler',
          context: { type },
        });
      }
      handlers.set(type, entry);
      return () => {
        if (handlers.get(type) === entry) {
          handlers.delete(type);
        }
      };
    },

    async broadcast(type: string, payload: unknown): Promise<void> {
      const envelope: BroadcastEnvelope = { [MARKER]: true, kind: 'broadcast', type, payload };
      try {
        await api.runtime.sendMessage(envelope);
      } catch (error) {
        // Fire-and-forget: "no receiving end" is expected when no context listens (§8.5).
        void error;
      }
    },

    onBroadcast(type: string, listener: BroadcastListener): Unsubscribe {
      ensureListener();
      return broadcasts.on(type, (payload) => {
        listener(payload);
      });
    },

    dispose(): void {
      if (installed) {
        api.runtime.onMessage.removeListener(router);
        installed = false;
      }
      handlers.clear();
      broadcasts.clear();
    },
  };
}
