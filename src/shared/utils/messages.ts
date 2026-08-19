/**
 * Module: shared/utils (message resolution)
 * Purpose: Resolve a message key against a catalogue and substitute `{name}`
 *          placeholders (PROJECT_BIBLE.md §19.1). Each surface owns its catalogue;
 *          this is the shared mechanism they all use, so there is exactly one
 *          substitution rule in the product.
 * Responsibilities: Pure lookup + substitution. No I/O, no locale negotiation —
 *          picking the catalogue is the composition root's job (§19.2).
 * Restrictions: Leaf layer — no internal dependencies, no side effects (§8.16).
 * Dependencies: none.
 * Public API: MessageResolver, formatMessage, createMessageResolver.
 */

/** Resolves a message key, substituting `{name}` placeholders. */
export type MessageResolver<K extends string> = (
  key: K,
  values?: Readonly<Record<string, string>>,
) => string;

/**
 * Substitute `{name}` placeholders in a template. A placeholder with no supplied
 * value is left intact rather than rendered as `undefined` (§2.8).
 */
export function formatMessage(template: string, values?: Readonly<Record<string, string>>): string {
  if (values === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * Build a resolver over a catalogue, falling back to `fallback` for any key the
 * catalogue has not translated (§19.2). A placeholder with no supplied value is
 * left intact rather than rendered as `undefined`.
 */
export function createMessageResolver<K extends string>(
  catalog: Readonly<Record<K, string>>,
  fallback: Readonly<Record<K, string>> = catalog,
): MessageResolver<K> {
  return (key, values) => formatMessage(catalog[key] ?? fallback[key], values);
}
