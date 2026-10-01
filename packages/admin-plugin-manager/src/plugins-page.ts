/**
 * The plugins page: the discovered plugin list, the raw install form, and their
 * POST handlers. When a curated directory is configured it replaces the raw
 * install form (`directory-section.ts`).
 *
 * The render side is asynchronous: it discovers plugins (honoring the
 * configured `enabled` allow-list and `pluginsDir`) and merges in the persisted
 * plugin state, then renders the list table, a restart notice (from the
 * `notice` query parameter), an install form gated behind
 * {@link downloadsCapability} plus a configured installer, and the
 * per-row enable/disable/uninstall/rollback actions. Discovery and state-load
 * failures degrade to an empty listing rather than a 500.
 *
 * The POST side dispatches on the submitted `action` field. The core admin
 * panel has already enforced the auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check, so this module only applies the plugin manager's
 * own policy and its value-free error responses.
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
import {
  PLUGIN_ID_PATTERN,
  type DownloadsCapability,
  type PluginInstaller,
  type PluginState,
} from 'jsails/plugins';

import {
  handleDirectoryInstall,
  handleDirectoryRollback,
  handleDirectoryUpdate,
  renderDirectorySection,
} from './directory-section.js';
import { downloadsCapability, loadInstalledPlugins, stateEntry } from './installed-plugins.js';
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
import type { PluginManagerAdminOptions } from './plugin-manager.js';
import { conflictResponse, installFailureResponse } from './responses.js';

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
  options: PluginManagerAdminOptions,
): Promise<string> {
  const rows = await loadPluginRows(options);
  const notice = readPluginNotice(context.url.searchParams.get('notice'));
  const csrf = context.session.csrfToken;
  const path = context.path;

  const capability = downloadsCapability(options);
  const installer = options.installer;

  const body: ComponentChild[] = [h('h1', null, 'Plugins')];
  if (notice !== undefined) {
    body.push(renderPluginNotice(notice));
  }
  if (options.directory !== undefined) {
    body.push(...(await renderDirectorySection(options.directory, context, options)));
  } else if (capability.enabled && installer !== undefined) {
    body.push(renderInstallForm(path, csrf));
  } else {
    body.push(renderInstallDisabled(capability, installer));
  }
  body.push(renderTable(rows, options, path, csrf));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Plugins'), ...body);
}

/** The install form (id/version/url + optional checksum). */
function renderInstallForm(path: string, csrf: string): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/plugins` },
    csrfInput(csrf),
    hiddenInput('action', 'install'),
    h('label', null, 'Plugin id', h('input', { type: 'text', name: 'id' })),
    h('label', null, 'Version', h('input', { type: 'text', name: 'version' })),
    h('label', null, 'Bundle URL', h('input', { type: 'text', name: 'url' })),
    h('label', null, 'SHA-256 (optional)', h('input', { type: 'text', name: 'sha256' })),
    h('button', { type: 'submit' }, 'Install'),
  );
}

/** The install-disabled note, with the capability reason or a missing installer. */
function renderInstallDisabled(
  capability: DownloadsCapability,
  installer: PluginInstaller | undefined,
): ComponentChild {
  const reason =
    installer === undefined
      ? 'plugin installation is not configured'
      : (capability.reason ?? 'downloads are unavailable');
  return h('p', null, reason);
}

/** The plugin list table: id, version, provenance, status, and actions. */
function renderTable(
  rows: readonly PluginManagerRow[],
  options: PluginManagerAdminOptions,
  path: string,
  csrf: string,
): ComponentChild {
  if (rows.length === 0) {
    return h('p', null, 'No plugins discovered.');
  }
  const installer = options.installer;
  const anyActions = rows.some(
    (row) => row.manageable || (row.installed && installer !== undefined),
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
          ...(anyActions ? [h('td', null, renderRowActions(row, path, csrf, installer))] : []),
        ),
      ),
    ),
  );
}

/** Render the per-row action forms (toggle, uninstall, rollback). */
function renderRowActions(
  row: PluginManagerRow,
  path: string,
  csrf: string,
  installer: PluginInstaller | undefined,
): ComponentChildren {
  const target = `${path}/plugins`;
  const actions: ComponentChild[] = [];
  if (row.manageable) {
    const enable = !row.enabled;
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
  if (row.installed && installer !== undefined) {
    actions.push(
      actionForm({ path: target, csrf, action: 'uninstall', id: row.id, label: 'Uninstall' }),
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

/** Dispatch the page POST on the submitted `action` field. */
export async function handlePluginsPost(
  context: AdminPagePostContext,
  options: PluginManagerAdminOptions,
): Promise<Response> {
  const action = context.body['action'];
  const redirect = (code: PluginNoticeCode): Response =>
    adminRedirectResponse(`${context.path}/plugins?notice=${code}`);

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
      return adminBadRequestResponse();
  }
}

/** Install a plugin bundle from the submitted id/version/url (and checksum). */
async function handleInstall(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
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
  const version = body['version'];
  if (version === undefined || version.trim() === '') {
    return adminBadRequestResponse();
  }
  const url = body['url'];
  if (url === undefined || url.trim() === '') {
    return adminBadRequestResponse();
  }

  // A plugin enabled in code is managed by the application config, never by the
  // admin installer.
  if ((options.enabled ?? []).includes(id)) {
    return conflictResponse();
  }

  const sha256 = body['sha256'];
  const checksums =
    sha256 === undefined || sha256.trim() === ''
      ? undefined
      : { [artifactName(url)]: sha256.trim() };

  try {
    await installer.install({ id, version: version.trim(), url: url.trim(), checksums });
  } catch {
    return installFailureResponse();
  }

  return redirect(PLUGIN_NOTICE_INSTALLED);
}

/** The inputs of one enable/disable toggle. */
interface ToggleRequest {
  readonly body: Record<string, string>;
  readonly options: PluginManagerAdminOptions;
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

  let state: PluginState;
  try {
    state = await stateSource.load();
  } catch {
    return adminServerErrorResponse();
  }

  if (!Object.hasOwn(state.plugins, id)) {
    return adminNotFoundResponse();
  }

  const entry = state.plugins[id]!;
  const next: PluginState = {
    version: state.version,
    plugins: {
      ...state.plugins,
      [id]: { ...entry, enabled },
    },
  };

  try {
    await stateSource.save(next);
  } catch {
    return adminServerErrorResponse();
  }

  return redirect(enabled ? PLUGIN_NOTICE_ENABLED : PLUGIN_NOTICE_DISABLED);
}

/** Uninstall a plugin via the configured installer. */
async function handleUninstall(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
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
    await installer.uninstall(id);
  } catch {
    return adminServerErrorResponse();
  }
  return redirect(PLUGIN_NOTICE_UNINSTALLED);
}

/** Roll back a plugin to an already-installed version. */
async function handleRollback(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
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
    await installer.rollback(id, version.trim());
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
  options: PluginManagerAdminOptions,
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

/** Derive the bundle artifact name from a URL's path basename (query/fragment stripped). */
function artifactName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
