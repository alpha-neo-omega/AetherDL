/**
 * Module: shared/utils
 * Purpose: Pure, side-effect-free utility functions available to every layer
 *          (PROJECT_BIBLE.md §8.16, §15.8).
 * Responsibilities: Provide small, foundational helpers. No I/O, no browser APIs.
 * Restrictions: Leaf layer — no internal dependencies, no side effects (§8.16).
 * Dependencies: none.
 * Public API: assertNever, isDefined, plus the event system (./events), URL
 *          helpers (./url), media helpers (./media), presentation formatters
 *          (./format) and message resolution (./messages) re-exported below.
 */
export * from './events';
export * from './url';
export * from './media';
export * from './format';
export * from './messages';

/**
 * Exhaustiveness helper for discriminated unions (PROJECT_BIBLE.md §15.1). Calling
 * this indicates a case was not handled; the `never` parameter makes unhandled
 * variants a compile-time error.
 */
export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}

/** Narrowing guard that excludes `null` and `undefined`. */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
