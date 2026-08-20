/**
 * Module: ui/settings (application)
 * Purpose: The settings surface — Appearance, Downloads, Detection, Notifications,
 *          History, Permissions and About (PROJECT_BIBLE.md §11.2), over the
 *          ratified settings catalogue (§4.9) and the local history view (§11.3).
 * Restrictions: UI layer — a view over runtime state. It validates nothing itself
 *          and stores nothing; the core services own defaults, validation, retention
 *          and persistence (§8.7, §13.2). Optional permissions are requested only
 *          from the user's click and never pre-emptively (§13.1, §13.3). There is no
 *          "send diagnostics" control here, because no such setting exists (§4.9,
 *          §3). All copy resolves from the catalogue (§19.1) and all styling from
 *          design-system tokens (§11.17).
 * Public API: SettingsAppProps, SettingsApp.
 */
import { useMemo, type ReactNode } from 'react';
import type { Settings } from '@shared/types';
import { Button, StatusView } from '@ui/components';
import { ThemeProvider, type MediaPreferences } from '@ui/design-system';
import { HistoryView, type HistoryViewLabels } from '@ui/history';
import { describeSettingsError } from './errors';
import { NumberField, SelectField, TextField, ToggleField } from './fields';
import {
  createSettingsTranslator,
  type SettingsMessageKey,
  type TranslateSettings,
} from './strings';
import {
  SettingsClientProvider,
  useSettingsClient,
  type OptionalPermission,
  type SettingsRuntimeClient,
} from './runtime-client';
import { useSettingsRuntime } from './use-settings-runtime';

/** The keyboard shortcut declared in the manifest, shown for discoverability (§4.14). */
const OPEN_POPUP_SHORTCUT = 'Ctrl+Shift+Y';

function option(value: string, label: string): { readonly value: string; readonly label: string } {
  return { value, label };
}

function historyLabels(t: TranslateSettings): HistoryViewLabels {
  return {
    title: t('history.title'),
    searchLabel: t('history.searchLabel'),
    searchPlaceholder: t('history.searchPlaceholder'),
    outcomeLabel: t('history.outcomeLabel'),
    outcomes: {
      all: t('history.outcome.all'),
      completed: t('history.outcome.completed'),
      failed: t('history.outcome.failed'),
    },
    sortLabel: t('history.sortLabel'),
    sorts: {
      newest: t('history.sort.newest'),
      oldest: t('history.sort.oldest'),
      title: t('history.sort.title'),
      size: t('history.sort.size'),
    },
    count: (total) =>
      total === 1 ? t('history.count.one') : t('history.count.other', { count: String(total) }),
    empty: t('history.empty'),
    noMatches: t('history.noMatches'),
    disabled: t('history.disabled'),
    delete: t('history.delete'),
    clear: t('history.clear'),
    clearHint: t('history.clearHint'),
    export: t('history.export'),
    exportHint: t('history.exportHint'),
    listLabel: t('history.list.label'),
    fields: {
      outcome: t('history.field.outcome'),
      size: t('history.field.size'),
      host: t('history.field.host'),
      when: t('history.field.when'),
      filename: t('history.field.filename'),
    },
  };
}

function PermissionRow(props: {
  readonly label: string;
  readonly help: string;
  readonly granted: boolean;
  readonly t: TranslateSettings;
  readonly onGrant: () => void;
  readonly onRevoke: () => void;
}): ReactNode {
  const { t } = props;
  return (
    <div className="adl-permission">
      <div className="adl-permission__text">
        <p className="adl-permission__label">{props.label}</p>
        <p className="adl-field-row__help">{props.help}</p>
      </div>
      <p className="adl-permission__state">
        {props.granted ? t('permissions.granted') : t('permissions.notGranted')}
      </p>
      {props.granted ? (
        <Button
          variant="text"
          onClick={props.onRevoke}
          ariaLabel={`${t('permissions.revoke')}: ${props.label}`}
        >
          {t('permissions.revoke')}
        </Button>
      ) : (
        <Button
          variant="tonal"
          onClick={props.onGrant}
          ariaLabel={`${t('permissions.grant')}: ${props.label}`}
        >
          {t('permissions.grant')}
        </Button>
      )}
    </div>
  );
}

interface SurfaceProps {
  readonly client: SettingsRuntimeClient;
  readonly runtime: ReturnType<typeof useSettingsRuntime>;
  readonly locale?: string;
  readonly messages?: Readonly<Record<SettingsMessageKey, string>>;
}

function SettingsSurface(props: SurfaceProps): ReactNode {
  const { client, runtime } = props;
  const messages = props.messages;
  const t = useMemo(() => createSettingsTranslator(messages), [messages]);
  const { actions, settings } = runtime;
  const notice =
    runtime.notice === undefined ? undefined : describeSettingsError(runtime.notice, t);

  if (runtime.status === 'loading' || settings === undefined) {
    if (runtime.status === 'error') {
      return (
        <StatusView
          kind="error"
          title={t('settings.error.unavailable.title')}
          detail={t('settings.error.unavailable.detail')}
          action={{ label: t('settings.error.retry'), onClick: actions.reload }}
        />
      );
    }
    return <StatusView kind="loading" title={t('settings.loading')} detail={t('settings.title')} />;
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    actions.update({ [key]: value } as Partial<Settings>);
  };
  const permissionRow = (
    permission: OptionalPermission,
    label: string,
    help: string,
  ): ReactNode => (
    <PermissionRow
      label={label}
      help={help}
      granted={runtime.permissions[permission]}
      t={t}
      onGrant={() => {
        actions.grant(permission);
      }}
      onRevoke={() => {
        actions.revoke(permission);
      }}
    />
  );

  return (
    <div className="adl-settings">
      <header className="adl-appbar">
        <h1 className="adl-appbar__brand">{t('settings.title')}</h1>
        {runtime.saved && (
          <p className="adl-settings__saved" role="status" aria-live="polite">
            {t('settings.saved')}
          </p>
        )}
      </header>

      {notice !== undefined && (
        <div className="adl-notice" role="alert">
          <div className="adl-notice__text">
            <p className="adl-notice__title">{notice.title}</p>
            <p className="adl-notice__detail">{notice.detail}</p>
          </div>
          <Button variant="text" onClick={actions.dismissNotice}>
            {t('settings.dismiss')}
          </Button>
        </div>
      )}

      <main className="adl-settings__main">
        <section className="adl-settings__section" aria-labelledby="adl-appearance">
          <h2 className="adl-settings__heading" id="adl-appearance">
            {t('settings.section.appearance')}
          </h2>
          <SelectField
            label={t('settings.theme')}
            help={t('settings.theme.help')}
            value={settings.theme}
            options={[
              option('system', t('settings.theme.system')),
              option('light', t('settings.theme.light')),
              option('dark', t('settings.theme.dark')),
            ]}
            onChange={(value) => {
              set('theme', value as Settings['theme']);
            }}
          />
          <SelectField
            label={t('settings.reducedMotion')}
            help={t('settings.reducedMotion.help')}
            value={settings.reducedMotion}
            options={[
              option('system', t('settings.reducedMotion.system')),
              option('on', t('settings.reducedMotion.on')),
              option('off', t('settings.reducedMotion.off')),
            ]}
            onChange={(value) => {
              set('reducedMotion', value as Settings['reducedMotion']);
            }}
          />
          <SelectField
            label={t('settings.language')}
            help={t('settings.language.help')}
            value={settings.language}
            options={[
              option('system', t('settings.language.system')),
              option('en', t('settings.language.en')),
            ]}
            onChange={(value) => {
              set('language', value);
            }}
          />
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-downloads">
          <h2 className="adl-settings__heading" id="adl-downloads">
            {t('settings.section.downloads')}
          </h2>
          <NumberField
            label={t('settings.maxConcurrentDownloads')}
            help={t('settings.maxConcurrentDownloads.help')}
            value={settings.maxConcurrentDownloads}
            min={1}
            max={10}
            onChange={(value) => {
              set('maxConcurrentDownloads', value);
            }}
          />
          <NumberField
            label={t('settings.maxRetries')}
            help={t('settings.maxRetries.help')}
            value={settings.maxRetries}
            min={0}
            max={10}
            onChange={(value) => {
              set('maxRetries', value);
            }}
          />
          <TextField
            label={t('settings.filenameTemplate')}
            help={t('settings.filenameTemplate.help')}
            value={settings.filenameTemplate}
            onChange={(value) => {
              set('filenameTemplate', value);
            }}
          />
          <TextField
            label={t('settings.downloadSubfolder')}
            help={t('settings.downloadSubfolder.help')}
            value={settings.downloadSubfolder}
            onChange={(value) => {
              set('downloadSubfolder', value);
            }}
          />
          <ToggleField
            label={t('settings.duplicateWarnings')}
            help={t('settings.duplicateWarnings.help')}
            checked={settings.duplicateWarnings}
            onChange={(checked) => {
              set('duplicateWarnings', checked);
            }}
          />
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-detection">
          <h2 className="adl-settings__heading" id="adl-detection">
            {t('settings.section.detection')}
          </h2>
          <SelectField
            label={t('settings.detectionSensitivity')}
            help={t('settings.detectionSensitivity.help')}
            value={settings.detectionSensitivity}
            options={[
              option('conservative', t('settings.detectionSensitivity.conservative')),
              option('balanced', t('settings.detectionSensitivity.balanced')),
              option('aggressive', t('settings.detectionSensitivity.aggressive')),
            ]}
            onChange={(value) => {
              set('detectionSensitivity', value as Settings['detectionSensitivity']);
            }}
          />
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-notifications">
          <h2 className="adl-settings__heading" id="adl-notifications">
            {t('settings.section.notifications')}
          </h2>
          <ToggleField
            label={t('settings.notifications')}
            help={t('settings.notifications.help')}
            checked={settings.notifications}
            onChange={(checked) => {
              set('notifications', checked);
            }}
          />
          {/* The context-menu preference only means something where the browser can
              provide the capability at all (§7.2). */}
          {client.supportsPermission('contextMenus') && (
            <ToggleField
              label={t('settings.contextMenu')}
              help={t('settings.contextMenu.help')}
              checked={settings.contextMenu}
              onChange={(checked) => {
                set('contextMenu', checked);
              }}
            />
          )}
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-history">
          <h2 className="adl-settings__heading" id="adl-history">
            {t('settings.section.history')}
          </h2>
          <ToggleField
            label={t('settings.keepHistory')}
            help={t('settings.keepHistory.help')}
            checked={settings.keepHistory}
            onChange={(checked) => {
              set('keepHistory', checked);
            }}
          />
          <SelectField
            label={t('settings.historyRetention')}
            value={settings.historyRetention}
            options={[
              option('forever', t('settings.historyRetention.forever')),
              option('30d', t('settings.historyRetention.30d')),
              option('90d', t('settings.historyRetention.90d')),
              option('session', t('settings.historyRetention.session')),
            ]}
            onChange={(value) => {
              set('historyRetention', value as Settings['historyRetention']);
            }}
          />
          <HistoryView
            records={runtime.history}
            enabled={settings.keepHistory}
            labels={historyLabels(t)}
            onDelete={actions.deleteRecord}
            onClear={actions.clearHistory}
            onExport={() => {
              actions.exportHistory(t('history.exportFilename'));
            }}
            {...(props.locale !== undefined && { locale: props.locale })}
          />
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-permissions">
          <h2 className="adl-settings__heading" id="adl-permissions">
            {t('settings.section.permissions')}
          </h2>
          {client.supportsPermission('notifications') &&
            permissionRow(
              'notifications',
              t('permissions.notifications'),
              t('permissions.notifications.help'),
            )}
          {/* A browser that cannot offer the permission gets no control for it,
              rather than a button that can never succeed (§7.2, §13.3). */}
          {client.supportsPermission('contextMenus') &&
            permissionRow(
              'contextMenus',
              t('permissions.contextMenus'),
              t('permissions.contextMenus.help'),
            )}

          {/* Site access is the most consequential thing AetherDL asks for — a stream
              download reads from the media host — so the grants are listed here and
              can be withdrawn from here. A grant the user cannot see is one they
              cannot withdraw (§4.15, §13.7). */}
          <div className="adl-permission">
            <div className="adl-permission__text">
              <p className="adl-permission__label">{t('permissions.sites')}</p>
              <p className="adl-field-row__help">{t('permissions.sites.help')}</p>
            </div>
          </div>
          {runtime.siteAccess.length === 0 ? (
            <p className="adl-permission__state">{t('permissions.sites.none')}</p>
          ) : (
            <ul className="adl-sites" aria-label={t('permissions.sites')}>
              {runtime.siteAccess.map((origin) => (
                <li className="adl-sites__item" key={origin}>
                  <span className="adl-sites__origin">{origin}</span>
                  <Button
                    variant="text"
                    ariaLabel={`${t('permissions.revoke')}: ${origin}`}
                    onClick={() => {
                      actions.revokeSite(origin);
                    }}
                  >
                    {t('permissions.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="adl-settings__section" aria-labelledby="adl-about">
          <h2 className="adl-settings__heading" id="adl-about">
            {t('settings.section.about')}
          </h2>
          <p className="adl-settings__about">
            {t('about.version')}: {client.getVersion()}
          </p>
          <p className="adl-settings__about">
            {t('about.shortcut')}: <kbd>{OPEN_POPUP_SHORTCUT}</kbd> — {t('about.shortcutHint')}
          </p>
          <p className="adl-settings__about">{t('about.privacy')}</p>
          <Button
            variant="text"
            onClick={actions.reset}
            ariaLabel={`${t('settings.reset')} — ${t('settings.resetHint')}`}
          >
            {t('settings.reset')}
          </Button>
        </section>
      </main>
    </div>
  );
}

/**
 * Loads the catalogue once, then themes the surface from it: the Appearance
 * settings are applied to this very page the moment they are saved (§4.9, §11.15).
 */
function SettingsRoot(props: {
  readonly media?: MediaPreferences;
  readonly locale?: string;
  readonly messages?: Readonly<Record<SettingsMessageKey, string>>;
}): ReactNode {
  const client = useSettingsClient();
  const runtime = useSettingsRuntime(client);
  return (
    <ThemeProvider
      mode={runtime.settings?.theme ?? 'system'}
      reducedMotion={runtime.settings?.reducedMotion ?? 'system'}
      {...(props.media !== undefined && { media: props.media })}
    >
      <SettingsSurface
        client={client}
        runtime={runtime}
        {...(props.locale !== undefined && { locale: props.locale })}
        {...(props.messages !== undefined && { messages: props.messages })}
      />
    </ThemeProvider>
  );
}

export interface SettingsAppProps {
  readonly client: SettingsRuntimeClient;
  readonly media?: MediaPreferences;
  readonly locale?: string;
  /** Resolved message catalogue; defaults to the built-in English one (§19.2). */
  readonly messages?: Readonly<Record<SettingsMessageKey, string>>;
}

export function SettingsApp(props: SettingsAppProps): ReactNode {
  return (
    <SettingsClientProvider client={props.client}>
      <SettingsRoot
        {...(props.media !== undefined && { media: props.media })}
        {...(props.locale !== undefined && { locale: props.locale })}
        {...(props.messages !== undefined && { messages: props.messages })}
      />
    </SettingsClientProvider>
  );
}
