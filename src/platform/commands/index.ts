/**
 * Module: platform/commands
 * Purpose: Keyboard command registration contract (PROJECT_BIBLE.md §4.14).
 *          Implementation lands in Phase 7.
 * Restrictions: Platform layer — depends only on shared/ (§8.4).
 * Dependencies: none.
 * Public API: CommandsAdapter.
 */
export interface CommandsAdapter {
  onCommand(listener: (command: string) => void): () => void;
}
