/**
 * Module: ui/popup
 * Purpose: The popup application — detected media, actions, queue, states
 *          (PROJECT_BIBLE.md §11.1). Mounted by runtime/popup.
 * Responsibilities: Render results/empty/loading/error, issue intents to the
 *          background through the injected runtime port, and display queue and
 *          progress pushed by the runtime.
 * Restrictions: UI layer — reads domain state from the runtime, never platform/
 *          directly (§8.4); owns no domain state (§8.7).
 * Public API: PopupApp (+ props), the runtime client port, the message catalogue,
 *          and the error presentation helpers.
 */
export { PopupApp, type PopupAppProps } from './app';
export {
  RuntimeClientProvider,
  useRuntimeClient,
  type PopupRuntimeClient,
  type RuntimeClientProviderProps,
} from './runtime-client';
export { QueuePanel, type QueuePanelLabels, type QueuePanelProps } from './queue-panel';
export {
  describeRendition,
  QualityChooserDialog,
  type QualityChooserLabels,
  type QualityChooserProps,
} from './quality-chooser';
export {
  createTranslator,
  EN_MESSAGES,
  resolveCatalog,
  toCatalogName,
  type MessageKey,
  type Translate,
} from './strings';
export { describeError, toAppError, type ErrorDescription } from './errors';
export { useThemeSettings, type AppearanceSettings } from './use-theme-settings';
export {
  usePopupRuntime,
  type PopupRuntimeActions,
  type PopupRuntimeData,
  type PopupStatus,
  type QualityChooser,
} from './use-popup-runtime';
