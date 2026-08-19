/**
 * Module: shared/logging
 * Purpose: Dev-only logging abstraction (PROJECT_BIBLE.md §20.6). This is the single
 *          sanctioned `console` boundary in the codebase.
 * Responsibilities: Provide a Logger contract and a factory. Logs are developer
 *          diagnostics only; they never leave the device and carry no PII (§14).
 *          Production composition roots create loggers with `enabled: false` so
 *          output is suppressed.
 * Restrictions: Leaf layer — no internal dependencies (§8.16).
 * Dependencies: none.
 * Public API: LogLevel, Logger, createLogger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...details: readonly unknown[]): void;
  info(message: string, ...details: readonly unknown[]): void;
  warn(message: string, ...details: readonly unknown[]): void;
  error(message: string, ...details: readonly unknown[]): void;
}

const NOOP: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Create a scoped logger. When `enabled` is false (production), a no-op logger is
 * returned so no diagnostics are emitted.
 */
export function createLogger(scope: string, enabled = true): Logger {
  if (!enabled) {
    return NOOP;
  }
  const prefix = `[AetherDL:${scope}]`;
  return {
    debug: (message, ...details) => console.debug(prefix, message, ...details),
    info: (message, ...details) => console.info(prefix, message, ...details),
    warn: (message, ...details) => console.warn(prefix, message, ...details),
    error: (message, ...details) => console.error(prefix, message, ...details),
  };
}
