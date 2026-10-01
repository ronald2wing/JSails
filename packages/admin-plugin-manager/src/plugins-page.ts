/**
 * The plugins page: the discovered plugin list, the raw install form, and their
 * POST handlers. When a curated directory is configured it replaces the raw
 * install form (`directory-section.ts`).
 *
 * The render side is asynchronous: it discovers plugins (honoring the
 * configured `enabled` allow-list and `pluginsDir`) and merges in the persisted
 * plugin state, then renders the list table, a restart notice (from the
 * `notice` query parameter), the raw install form (only with
 * `allowRawInstall`, {@link downloadsCapability}, a configured installer, and
 * the install permission), and the per-row enable/disable/uninstall/rollback
 * actions, each only for a session the install permission allows it.
 * Discovery and state-load failures degrade to an empty listing rather than a
 * 500.
 *
 * The POST side dispatches on the submitted `action` field. The core admin
 * panel has already enforced its auth gates, a same-origin `Origin`, and a
 * constant-time `_csrf` check, so this module applies the plugin manager's own
 * policy (the install permission for code-changing actions, `https:`-only raw
 * URLs on the allowed hosts, a mandatory checksum) and its value-free error
 * responses. Every state mutation runs under {@link withStateLock}.
 */

import { h, type ComponentChild, type ComponentChildren } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  csrfInput,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { PLUGIN_ID_PATTERN, type DownloadsCapability, type PluginState } from 'jsails/plugins';

import { integrityFor, reportInstallWarnings, SHA256_PATTERN } from './bundle-integrity.js';

import {
  handleDirectoryInstall,
  handleDirectoryRollback,
  handleDirectoryUpdate,
  renderDirectorySection,
} from './directory-section.js';
import { allowedInstallActions, allowsInstallAction } from './install-access.js';
import {
  downloadsCapability,
  invalidateInstalledPlugins,
  loadInstalledPlugins,
  stateEntry,
} from './installed-plugins.js';
import {
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_UNINSTALLED,
  readPluginNotice,
  renderPluginNotice,
  type PluginNoticeCode,
} from './plugin-notices.js';
import type { PluginInstallAction, ResolvedPluginManagerOptions } from './plugin-manager.js';
import { conflictResponse, installFailureResponse } from './responses.js';
import { withStateLock } from './state-lock.js';

/** A plugin row rendered on the plugins page. */
interface PluginManagerRow {
  readonly id: string;
  readonly version: string;
  readonly provenance: string;
  readonly status: string;
  /** Whether the plugin is currently enabled (drives the toggle button label). */
  readonly enabled: boolean;
  /** Whether the row renders an enable/disable action. */
  readonly manageable: boolean;
  /** Whether the plugin has a persisted state entry (installed). */
  readonly installed: boolean;
}

/** Render the plugins page: notice, install form, table, and back link. */
export async function renderPluginsPage(
  context: AdminPageRenderContext,
  options: ResolvedPluginManagerOptions,
): Promise<string> {
  const rows = await loadPluginRows(options);
  const notice = readPluginNotice(context.url.searchParams.get('notice'));
  const csrf = context.session.csrfToken;
  const path = context.path;

  const allowed = await allowedInstallActions(options, context.session);

  const body: ComponentChild[] = [h('h1', null, 'Plugins')];
  if (notice !== undefined) {
    body.push(renderPluginNotice(notice));
  }
  if (options.directory !== undefined) {
    body.push(...(await renderDirectorySection(options.directory, context, options, allowed)));
  } else {
    const refusal = rawInstallRefusal(options, allowed.has('install'));
    body.push(
      refusal === undefined
        ? renderInstallForm(path, csrf, options.allowUnverified === true)
        : h('p', null, refusal),
    );
  }
  body.push(renderTable(rows, { options, allowed, path, csrf }));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Plugins'), ...body);
}

/**
 * Why the raw install form is unavailable, as a fixed message, or `undefined`
 * when it may be offered. The POST handler applies the same checks.
 */
function rawInstallRefusal(
  options: ResolvedPluginManagerOptions,
  permitted: boolean,
): string | undefined {
  if (options.allowRawInstall !== true || options.directory !== undefined) {
    return 'installing a plugin bundle from a URL is disabled';
  }
  const capability: DownloadsCapability = downloadsCapability(options);
  if (!capability.enabled) {
    return capability.reason ?? 'downloads are unavailable';
  }
  if (options.installer === undefined) {
    return 'plugin installation is not configured';
  }
  if (!permitted) {
    return 'you are not allowed to install plugins';
  }
  return undefined;
}

/** The install form (id/version/https URL + checksum, optional only when unverified installs are allowed). */
function renderInstallForm(path: string, csrf: string, allowUnverified: boolean): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/plugins` },
    csrfInput(csrf),
    hiddenInput('action', 'install'),
    h('label', null, 'Plugin id', h('input', { type: 'text', name: 'id' })),
    h('label', null, 'Version', h('input', { type: 'text', name: 'version' })),
    h('label', null, 'Bundle URL (https)', h('input', { type: 'url', name: 'url' })),
    h(
      'label',
      null,
      allowUnverified ? 'SHA-256 (optional)' : 'SHA-256',
      h('input', { type: 'text', name: 'sha256', ...(allowUnverified ? {} : { required: true }) }),
    ),
    h('button', { type: 'submit' }, 'Install'),
  );
}

/** What the plugin table needs beyond its rows. */
interface TableContext {
  readonly options: ResolvedPluginManagerOptions;
  /** The code-changing actions the session may be offered. */
  readonly allowed: ReadonlySet<PluginInstallAction>;
  readonly path: string;
  readonly csrf: string;
}

/** The plugin list table: id, version, provenance, status, and actions. */
function renderTable(rows: readonly PluginManagerRow[], table: TableContext): ComponentChild {
  if (rows.length === 0) {
    return h('p', null, 'No plugins discovered.');
  }
  const installer = table.options.installer;
  const codeActions: RowActionAccess = {
    enable: table.allowed.has('enable'),
    disable: table.allowed.has('disable'),
    uninstall: installer !== undefined && table.allowed.has('uninstall'),
    rollback: installer !== undefined && table.allowed.has('rollback'),
  };
  const anyActions = rows.some(
    (row) =>
      (row.manageable && (row.enabled ? codeActions.disable : codeActions.enable)) ||
      (row.installed && (codeActions.uninstall || codeActions.rollback)),
  );
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'Plugin'),
        h('th', null, 'Version'),
        h('th', null, 'Provenance'),
        h('th', null, 'Status'),
        ...(anyActions ? [h('th', null, 'Actions')] : []),
      ),
    ),
    h(
      'tbody',
      null,
      ...rows.map((row) =>
        h(
          'tr',
          null,
          h('td', null, row.id),
          h('td', null, row.version),
          h('td', null, row.provenance),
          h('td', null, row.status),
          ...(anyActions
            ? [h('td', null, renderRowActions(row, table.path, table.csrf, codeActions))]
            : []),
        ),
      ),
    ),
  );
}

/** Which per-row actions the session may be offered. */
interface RowActionAccess {
  readonly enable: boolean;
  readonly disable: boolean;
  readonly uninstall: boolean;
  readonly rollback: boolean;
}

/** Render the per-row action forms (toggle, uninstall, rollback). */
function renderRowActions(
  row: PluginManagerRow,
  path: string,
  csrf: string,
  codeActions: RowActionAccess,
): ComponentChildren {
  const target = `${path}/plugins`;
  const actions: ComponentChild[] = [];
  const enable = !row.enabled;
  if (row.manageable && (enable ? codeActions.enable : codeActions.disable)) {
    actions.push(
      actionForm({
        path: target,
        csrf,
        action: enable ? 'enable' : 'disable',
        id: row.id,
        label: enable ? 'Enable' : 'Disable',
      }),
    );
  }
  if (row.installed && codeActions.uninstall) {
    actions.push(
      actionForm({ path: target, csrf, action: 'uninstall', id: row.id, label: 'Uninstall' }),
    );
  }
  if (row.installed && codeActions.rollback) {
    actions.push(
      actionForm({
        path: target,
        csrf,
        action: 'rollback',
        id: row.id,
        controls: [h('input', { type: 'text', name: 'version', placeholder: 'version' })],
        label: 'Rollback',
      }),
    );
  }
  return actions.length === 0 ? '' : actions;
}

/** The install permission each code-changing POST action needs. */
const INSTALL_ACTION_OF: Readonly<Record<string, PluginInstallAction>> = {
  install: 'install',
  'directory-install': 'install',
  'directory-update': 'update',
  rollback: 'rollback',
  'directory-rollback': 'rollback',
  uninstall: 'uninstall',
  enable: 'enable',
  disable: 'disable',
};

/** Dispatch the page POST on the submitted `action` field. */
export async function handlePluginsPost(
  context: AdminPagePostContext,
  options: ResolvedPluginManagerOptions,
): Promise<Response> {
  const action = context.body['action'];
  const redirect = (code: PluginNoticeCode): Response =>
    adminRedirectResponse(`${context.path}/plugins?notice=${code}`);

  const required =
    action !== undefined && Object.hasOwn(INSTALL_ACTION_OF, action)
      ? INSTALL_ACTION_OF[action]
      : undefined;
  if (required !== undefined && !(await allowsInstallAction(options, context.session, required))) {
    return adminForbiddenResponse('you are not allowed to manage plugin code');
  }

  try {
    return await dispatchPluginsPost(context, options, redirect);
  } finally {
    // Every action here can change which bundles are on disk or how they are
    // listed; even a failed install may have left a partial version behind.
    invalidateInstalledPlugins(options);
  }
}

/** Run one already-authorized plugins page POST action. */
function dispatchPluginsPost(
  context: AdminPagePostContext,
  options: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const action = context.body['action'];
  switch (action) {
    case 'install':
      return handleInstall(context.body, options, redirect);
    case 'enable':
      return handleToggle({ body: context.body, options, enabled: true, redirect });
    case 'disable':
      return handleToggle({ body: context.body, options, enabled: false, redirect });
    case 'uninstall':
      return handleUninstall(context.body, options, redirect);
    case 'rollback':
      return handleRollback(context.body, options, redirect);
    case 'directory-install':
      return handleDirectoryInstall(context.body, options, redirect);
    case 'directory-update':
      return handleDirectoryUpdate(context.body, options, redirect);
    case 'directory-rollback':
      return handleDirectoryRollback(context.body, options, redirect);
    default:
      return Promise.resolve(adminBadRequestResponse());
  }
}

/** Install a plugin bundle from the submitted id/version/url and checksum. */
async function handleInstall(
  body: Record<string, string>,
  options: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  if (options.allowRawInstall !== true || options.directory !== undefined) {
    return adminForbiddenResponse('installing a plugin bundle from a URL is disabled');
  }
  const capability = downloadsCapability(options);
  if (!capability.enabled) {
    return adminForbiddenResponse(capability.reason ?? 'downloads are unavailable');
  }
  const installer = options.installer;
  if (installer === undefined) {
    return adminForbiddenResponse('plugin installation is not configured');
  }

  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }
  // A plugin enabled in code is managed by the application config, never by the
  // admin installer.
  if ((options.enabled ?? []).includes(id)) {
    return conflictResponse();
  }
  const version = body['version'];
  if (version === undefined || version.trim() === '') {
    return adminBadRequestResponse();
  }
  const url = parseBundleUrl(body['url']);
  if (url === undefined) {
    return adminBadRequestResponse();
  }
  if (options.allowedHosts !== undefined && !options.allowedHosts.includes(url.hostname)) {
    return adminForbiddenResponse('the bundle host is not allowed');
  }
  const submittedSha = body['sha256']?.trim() ?? '';
  if (submittedSha !== '' && !SHA256_PATTERN.test(submittedSha)) {
    return adminBadRequestResponse();
  }
  const integrity = integrityFor(url.href, submittedSha === '' ? undefined : submittedSha, options);
  if (integrity === undefined) {
    return adminForbiddenResponse('a SHA-256 checksum is required to install a plugin');
  }

  try {
    const result = await withStateLock(options.state, () =>
      installer.install({
        id,
        version: version.trim(),
        url: url.href,
        ...integrity,
        // The check above covers only the submitted URL; the installer applies
        // the same host list to every redirect the download follows.
        ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
      }),
    );
    reportInstallWarnings(result, options);
  } catch {
    return installFailureResponse();
  }

  return redirect(PLUGIN_NOTICE_INSTALLED);
}

/** The inputs of one enable/disable toggle. */
interface ToggleRequest {
  readonly body: Record<string, string>;
  readonly options: ResolvedPluginManagerOptions;
  /** The `enabled` flag to persist. */
  readonly enabled: boolean;
  readonly redirect: (code: PluginNoticeCode) => Response;
}

/** Flip one managed plugin's `enabled` flag. */
async function handleToggle(request: ToggleRequest): Promise<Response> {
  const { body, options, enabled, redirect } = request;
  const stateSource = options.stateSource;
  if (options.managed !== true || stateSource === undefined) {
    return adminForbiddenResponse('plugin state is not managed');
  }

  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }

  return withStateLock(stateSource, async () => {
    let state: PluginState;
    try {
      state = await stateSource.load();
    } catch {
      return adminServerErrorResponse();
    }

    if (!Object.hasOwn(state.plugins, id)) {
      return adminNotFoundResponse();
    }

    // Only this id's row is written: the loaded snapshot may already be stale
    // for every other plugin (another process may have installed one since).
    const entry = state.plugins[id]!;
    try {
      await stateSource.putEntry(id, { ...entry, enabled });
    } catch {
      return adminServerErrorResponse();
    }

    return redirect(enabled ? PLUGIN_NOTICE_ENABLED : PLUGIN_NOTICE_DISABLED);
  });
}

/** Uninstall a plugin via the configured installer. */
async function handleUninstall(
  body: Record<string, string>,
  options: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = options.installer;
  if (installer === undefined) {
    return adminForbiddenResponse('plugin installation is not configured');
  }
  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }
  try {
    await withStateLock(options.state, () => installer.uninstall(id));
  } catch {
    return adminServerErrorResponse();
  }
  return redirect(PLUGIN_NOTICE_UNINSTALLED);
}

/** Roll back a plugin to an already-installed version. */
async function handleRollback(
  body: Record<string, string>,
  options: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = options.installer;
  if (installer === undefined) {
    return adminForbiddenResponse('plugin installation is not configured');
  }
  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }
  const version = body['version'];
  if (version === undefined || version.trim() === '') {
    return adminBadRequestResponse();
  }
  try {
    await withStateLock(options.state, () => installer.rollback(id, version.trim()));
  } catch {
    return adminServerErrorResponse();
  }
  return redirect(PLUGIN_NOTICE_ROLLED_BACK);
}

/**
 * Discover plugins (honoring the `enabled` allow-list and `pluginsDir`) and
 * merge in the persisted plugin state. Active plugins show their manifest
 * version, provenance, and an `enabled`/`disabled` status (disabled when the
 * state records `enabled: false`); skipped ids show their skip reason. A row is
 * manageable only in managed mode and only when the state records an entry for
 * that id; a row is installed when the state records an entry. Discovery and
 * state-load failures degrade to an empty listing rather than a 500.
 */
async function loadPluginRows(
  options: ResolvedPluginManagerOptions,
): Promise<readonly PluginManagerRow[]> {
  const { discovered, state } = await loadInstalledPlugins(options);
  const managed = options.managed === true && options.stateSource !== undefined;

  const active = (discovered?.plugins ?? []).map((plugin) => {
    const entry = stateEntry(state, plugin.id);
    const enabled = entry?.enabled !== false;
    return {
      id: plugin.id,
      version: plugin.version,
      provenance: plugin.source,
      status: enabled ? 'enabled' : 'disabled',
      enabled,
      manageable: managed && entry !== undefined,
      installed: entry !== undefined,
    };
  });
  const skipped = (discovered?.skipped ?? []).map((entry) => ({
    id: entry.id,
    version: '-',
    provenance: '-',
    status: `skipped: ${entry.reason}`,
    enabled: false,
    manageable: false,
    installed: false,
  }));

  return [...active, ...skipped];
}

/**
 * Parse a submitted bundle URL: only an absolute `https:` URL without embedded
 * credentials is accepted, so the raw form cannot reach plain-text or
 * credentialed endpoints. `undefined` for anything else.
 */
function parseBundleUrl(raw: string | undefined): URL | undefined {
  const text = raw?.trim() ?? '';
  if (text === '') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return url;
}
