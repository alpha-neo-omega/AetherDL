/**
 * Module: platform/messaging
 * Purpose: Typed, validated cross-context message bus (PROJECT_BIBLE.md §8.5).
 *          Implementation in ./service wraps runtime messaging and validates every
 *          payload at the boundary (§13.8).
 * Restrictions: Platform layer — depends only on shared/ (§8.4). No domain logic.
 * Dependencies: shared/types (MessageMap), shared/utils (Unsubscribe).
 * Public API: MessageHandler, SendOptions, BroadcastListener, MessageBus.
 */
import type { MessageMap, MessageType } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

export type { Unsubscribe } from '@shared/utils';

/** Handler for an inbound request of a given type. */
export type MessageHandler<T extends MessageType> = (
  request: MessageMap[T]['request'],
) => MessageMap[T]['response'] | Promise<MessageMap[T]['response']>;

export interface SendOptions {
  /** Reject with a MessagingError if no response arrives within this window. */
  readonly timeoutMs?: number;
}

export type BroadcastListener = (payload: unknown) => void;

export interface MessageBus {
  /** Send a typed request and await its typed response (§8.5). */
  send<T extends MessageType>(
    type: T,
    request: MessageMap[T]['request'],
    options?: SendOptions,
  ): Promise<MessageMap[T]['response']>;
  /** Register the responder for a request type. Returns an unsubscribe. */
  on<T extends MessageType>(type: T, handler: MessageHandler<T>): Unsubscribe;
  /** Fire-and-forget a one-way message to other extension contexts (§8.5). */
  broadcast(type: string, payload: unknown): Promise<void>;
  /** Subscribe to broadcasts of a given type. Returns an unsubscribe. */
  onBroadcast(type: string, listener: BroadcastListener): Unsubscribe;
  /** Detach the underlying runtime listener and clear all handlers (cleanup). */
  dispose(): void;
}
