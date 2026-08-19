/**
 * Module: ui/settings
 * Purpose: The settings application (PROJECT_BIBLE.md §11.2). Mounted by
 *          runtime/settings.
 * Responsibilities: Render and persist the settings catalogue through the runtime,
 *          surface optional permissions at point-of-use, and host the history view.
 * Restrictions: UI layer — no platform/ or runtime/ imports (§8.4); owns no domain
 *          state (§8.7).
 * Public API: SettingsApp (+ props), the runtime client port, the message
 *          catalogue, the form fields, and the error presentation helper.
 */
export { SettingsApp, type SettingsAppProps } from './app';
export {
  SettingsClientProvider,
  useSettingsClient,
  type OptionalPermission,
  type SettingsClientProviderProps,
  type SettingsRuntimeClient,
} from './runtime-client';
export {
  createSettingsTranslator,
  resolveSettingsCatalog,
  SETTINGS_EN_MESSAGES,
  toSettingsCatalogName,
  type SettingsMessageKey,
  type TranslateSettings,
} from './strings';
export { describeSettingsError } from './errors';
export {
  NumberField,
  SelectField,
  TextField,
  ToggleField,
  type NumberFieldProps,
  type SelectFieldProps,
  type TextFieldProps,
  type ToggleFieldProps,
} from './fields';
export {
  useSettingsRuntime,
  type SettingsRuntimeActions,
  type SettingsRuntimeData,
  type SettingsStatus,
} from './use-settings-runtime';
