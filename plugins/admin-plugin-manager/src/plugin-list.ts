/**
 * The plugin list page: its render side and its POST handler.
 *
 * The render side is asynchronous: it discovers plugins (honoring the
 * configured `enabled` allow-list and `pluginsDir`) and merges in the persisted
 * plugin state, then renders the list table, a restart notice (from the
 * `notice` query parameter), an install form gated behind
 * {@link resolveDownloadsCapability} plus a configured installer, and the
 * per-row enable/disable/uninstall/rollback actions. Discovery and state-load
 * failures degrade to an empty listing rather than a 500.
 *
 * The POST side dispatches on the submitted `action` field. The core admin
 * panel has already enforced the auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check, so this module only applies the plugin manager's
 * own policy and its value-free error responses.
 */

import { h, type ComponentChild, type ComponentChildren } from 'preact';

import type { AdminPagePostContext, AdminPageRenderContext } from '@jsails/admin';
import { adminRedirectResponse, renderAdminDocumentWithTheme } from '@jsails/admin';
import { resolveDownloadsCapability, type DownloadsCapability } from 'jsails/plugins';
import type { PluginInstaller } from 'jsails/plugins';
import { PLUGIN_ID_PATTERN } from 'jsails/plugins';
import { PLUGIN_STATE_VERSION, isValidSemverVersion, type PluginState } from 'jsails/plugins';
import type { PluginStateEntry } from 'jsails/plugins';
import {
  compareVersions,
  DirectoryError,
  InstallPlanError,
  planPluginInstall,
  planPluginRollback,
  planPluginUpdate,
  type InstallPlan,
  type InstalledPlugin,
  type PluginDirectory,
  type PluginDirectoryEntry,
} from './directory/index.js';
import { loadPluginData, stateEntry } from './plugin-data.js';
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
import {
  adminBadRequestResponse,
  conflictResponse,
  forbiddenWithReasonResponse,
  installFailureResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
} from './plugin-manager-responses.js';
import type { ResolvedPluginManagerOptions } from './plugin.js';

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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Render the plugins page: notice, install form, table, and back link. */
export async function renderPluginsPage(
  context: AdminPageRenderContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<string> {
  const rows = await loadPluginRows(resolved);
  const notice = readPluginNotice(context.url.searchParams.get('notice'));
  const csrf = context.session.csrfToken;
  const path = context.path;

  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });
  const installer = resolved.installer;

  const body: ComponentChild[] = [h('h1', null, 'Plugins')];
  if (notice !== undefined) {
    body.push(renderPluginNotice(notice));
  }
  if (resolved.directory !== undefined) {
    body.push(...(await renderDirectorySection(context, resolved, path)));
  } else {
    if (capability.enabled && installer !== undefined) {
      body.push(renderInstallForm(path, csrf));
    } else {
      body.push(renderInstallDisabled(capability, installer));
    }
  }
  body.push(renderTable(rows, resolved, path, csrf));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    { title: 'Plugins', theme: context.theme, themeCustomization: context.themeCustomization },
    ...body,
  );
}

/** The install form (id/version/url + optional checksum). */
function renderInstallForm(path: string, csrf: string): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/plugins` },
    h('input', { type: 'hidden', name: '_csrf', value: csrf }),
    h('input', { type: 'hidden', name: 'action', value: 'install' }),
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

// ---------------------------------------------------------------------------
// Directory surface
// ---------------------------------------------------------------------------

/** The install operation a directory entry maps to against its installed state. */
type DirectoryOperation = 'install' | 'update' | 'rollback' | 'none';

/**
 * Derive the operation a directory entry maps to: `install` when absent,
 * `update` when the active version is behind `latestVersion`, `rollback` when
 * the active version is ahead of it (the curated latest is the known previous
 * version), and `none` otherwise. A malformed active version yields `none`
 * rather than a speculative action.
 */
function describeDirectoryEntry(
  entry: PluginDirectoryEntry,
  installed: PluginStateEntry | undefined,
): DirectoryOperation {
  if (installed === undefined) {
    return 'install';
  }
  const active = installed.active;
  if (!isValidSemverVersion(active)) {
    return 'none';
  }
  const comparison = compareVersions(entry.latestVersion, active);
  if (comparison > 0) return 'update';
  if (comparison < 0) return 'rollback';
  return 'none';
}

/** Render the curated directory section (search, category filter, entries). */
async function renderDirectorySection(
  context: AdminPageRenderContext,
  resolved: ResolvedPluginManagerOptions,
  path: string,
): Promise<ComponentChild[]> {
  const directory = resolved.directory!;
  const frameworkVersion = resolved.frameworkVersion;
  const csrf = context.session.csrfToken;

  const q = context.url.searchParams.get('q') ?? '';
  const category = context.url.searchParams.get('category') ?? '';

  const entries = listDirectoryEntries(directory, q, category);
  const state = await loadDirectoryState(resolved);

  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });

  const nodes: ComponentChild[] = [h('h2', null, 'Plugin directory')];

  if (frameworkVersion === undefined) {
    nodes.push(
      h('p', null, 'The plugin directory is read-only: framework version is not configured.'),
    );
  }

  nodes.push(renderDirectoryFilter(path, directory, q, category));

  if (entries.length === 0) {
    nodes.push(h('p', null, 'No plugins match.'));
  } else {
    nodes.push(
      ...entries.map((entry) =>
        renderDirectoryEntry(entry, stateEntry(state, entry.id), resolved, capability, path, csrf),
      ),
    );
  }

  return nodes;
}

/**
 * Resolve the directory entries to render: a non-empty `q` searches first and
 * then filters by category; otherwise entries are listed in featured-first
 * order. An unknown category degrades to an empty list rather than a 500.
 */
function listDirectoryEntries(
  directory: PluginDirectory,
  q: string,
  category: string,
): readonly PluginDirectoryEntry[] {
  try {
    const term = q.trim();
    if (term !== '') {
      const searched = directory.search(term);
      return category.trim() === ''
        ? searched
        : searched.filter((entry) => entry.categories.includes(category.trim()));
    }
    return directory.list({
      category: category.trim() === '' ? undefined : category.trim(),
      sort: 'featured',
    });
  } catch (error) {
    if (error instanceof DirectoryError) {
      return Object.freeze([]);
    }
    throw error;
  }
}

/** Render the search form and category filter (both submit as GET parameters). */
function renderDirectoryFilter(
  path: string,
  directory: PluginDirectory,
  q: string,
  category: string,
): ComponentChild {
  return h(
    'form',
    { method: 'get', action: `${path}/plugins` },
    h('label', null, 'Search', h('input', { type: 'text', name: 'q', value: q })),
    h(
      'label',
      null,
      'Category',
      h(
        'select',
        { name: 'category' },
        h('option', { value: '' }, 'All categories'),
        ...directory.categories.map((name) =>
          h('option', { value: name, selected: name === category }, name),
        ),
      ),
    ),
    h('button', { type: 'submit' }, 'Filter'),
  );
}

/** Render one directory entry: name, summary, version, categories, and one action. */
function renderDirectoryEntry(
  entry: PluginDirectoryEntry,
  installed: PluginStateEntry | undefined,
  resolved: ResolvedPluginManagerOptions,
  capability: DownloadsCapability,
  path: string,
  csrf: string,
): ComponentChild {
  const operation = describeDirectoryEntry(entry, installed);
  const text = entry.summary ?? entry.description;

  return h(
    'article',
    null,
    h('h3', null, entry.name, entry.featured ? h('span', null, 'Featured') : null),
    text === undefined ? null : h('p', null, text),
    h('p', null, 'Latest version: ', entry.latestVersion),
    entry.categories.length === 0
      ? null
      : h('p', null, 'Categories: ', entry.categories.join(', ')),
    renderDirectoryAction(entry.id, operation, resolved, capability, path, csrf),
  );
}

/** Render the single action (button) or current-state label for an entry. */
function renderDirectoryAction(
  id: string,
  operation: DirectoryOperation,
  resolved: ResolvedPluginManagerOptions,
  capability: DownloadsCapability,
  path: string,
  csrf: string,
): ComponentChild {
  const actionable =
    resolved.installer !== undefined &&
    resolved.frameworkVersion !== undefined &&
    capability.enabled;

  switch (operation) {
    case 'install':
      return actionable
        ? renderDirectoryActionForm(path, csrf, 'directory-install', id, 'Install')
        : h('p', null, 'Available');
    case 'update':
      return actionable
        ? renderDirectoryActionForm(path, csrf, 'directory-update', id, 'Update')
        : h('p', null, 'Update available');
    case 'rollback':
      return actionable
        ? renderDirectoryActionForm(path, csrf, 'directory-rollback', id, 'Rollback')
        : h('p', null, 'Rollback available');
    case 'none':
      return h('p', null, 'Installed');
  }
}

/** Render a directory action POST form carrying only `_csrf`, `action`, and `id`. */
function renderDirectoryActionForm(
  path: string,
  csrf: string,
  action: string,
  id: string,
  label: string,
): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/plugins` },
    h('input', { type: 'hidden', name: '_csrf', value: csrf }),
    h('input', { type: 'hidden', name: 'action', value: action }),
    h('input', { type: 'hidden', name: 'id', value: id }),
    h('button', { type: 'submit' }, label),
  );
}

/** Load installed state for the directory, defaulting to empty when absent/failed. */
async function loadDirectoryState(resolved: ResolvedPluginManagerOptions): Promise<PluginState> {
  if (resolved.stateSource === undefined) {
    return { version: PLUGIN_STATE_VERSION, plugins: {} };
  }
  try {
    return await resolved.stateSource.load();
  } catch {
    return { version: PLUGIN_STATE_VERSION, plugins: {} };
  }
}

/** Map an installed state entry to the planner's {@link InstalledPlugin} shape. */
function installedPluginFromState(state: PluginState, id: string): InstalledPlugin | undefined {
  const entry = stateEntry(state, id);
  if (entry === undefined) return undefined;
  return { version: entry.active };
}

/**
 * Map a directory planning failure to a value-free response: an unknown plugin
 * is a 404, an incompatible/invalid framework is a value-free 403, and every
 * other plan condition is a generic value-free 400. Raw input is never echoed.
 */
function mapDirectoryPlanFailure(error: unknown): Response {
  if (error instanceof InstallPlanError) {
    if (error.code === 'unknown_plugin') return adminNotFoundResponse();
    if (error.code === 'incompatible_version' || error.code === 'invalid_framework') {
      return forbiddenWithReasonResponse('plugin is not compatible with this framework');
    }
    return adminBadRequestResponse();
  }
  if (error instanceof DirectoryError) {
    return adminBadRequestResponse();
  }
  throw error;
}

/** The plugin list table: id, version, provenance, status, and actions. */
function renderTable(
  rows: readonly PluginManagerRow[],
  resolved: ResolvedPluginManagerOptions,
  path: string,
  csrf: string,
): ComponentChild {
  if (rows.length === 0) {
    return h('p', null, 'No plugins discovered.');
  }
  const installer = resolved.installer;
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
  const actions: ComponentChild[] = [];
  if (row.manageable) {
    const enable = !row.enabled;
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: enable ? 'enable' : 'disable' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('button', { type: 'submit' }, enable ? 'Enable' : 'Disable'),
      ),
    );
  }
  if (row.installed && installer !== undefined) {
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: 'uninstall' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('button', { type: 'submit' }, 'Uninstall'),
      ),
    );
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: 'rollback' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('input', { type: 'text', name: 'version', placeholder: 'version' }),
        h('button', { type: 'submit' }, 'Rollback'),
      ),
    );
  }
  return actions.length === 0 ? '' : actions;
}

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

/** Dispatch the page POST on the submitted `action` field. */
export async function handlePluginsPost(
  context: AdminPagePostContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<Response> {
  const action = context.body['action'];
  const redirect = (code: PluginNoticeCode): Response =>
    adminRedirectResponse(`${context.path}/plugins?notice=${code}`);

  switch (action) {
    case 'install':
      return handleInstall(context.body, resolved, redirect);
    case 'enable':
      return handleToggle(context.body, resolved, true, redirect);
    case 'disable':
      return handleToggle(context.body, resolved, false, redirect);
    case 'uninstall':
      return handleUninstall(context.body, resolved, redirect);
    case 'rollback':
      return handleRollback(context.body, resolved, redirect);
    case 'directory-install':
      return handleDirectoryInstall(context.body, resolved, redirect);
    case 'directory-update':
      return handleDirectoryUpdate(context.body, resolved, redirect);
    case 'directory-rollback':
      return handleDirectoryRollback(context.body, resolved, redirect);
    default:
      return adminBadRequestResponse();
  }
}

/** Install a plugin bundle from the submitted id/version/url (and checksum). */
async function handleInstall(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });
  if (!capability.enabled) {
    return forbiddenWithReasonResponse(capability.reason ?? 'downloads are unavailable');
  }
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
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
  if ((resolved.enabled ?? []).includes(id)) {
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

/** Flip one managed plugin's `enabled` flag. */
async function handleToggle(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  enable: boolean,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const stateSource = resolved.stateSource;
  if (resolved.managed !== true || stateSource === undefined) {
    return forbiddenWithReasonResponse('plugin state is not managed');
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
      [id]: { ...entry, enabled: enable },
    },
  };

  try {
    await stateSource.save(next);
  } catch {
    return adminServerErrorResponse();
  }

  return redirect(enable ? PLUGIN_NOTICE_ENABLED : PLUGIN_NOTICE_DISABLED);
}

/** Uninstall a plugin via the configured installer. */
async function handleUninstall(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
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
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
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

// ---------------------------------------------------------------------------
// Directory POST handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the shared directory-action preconditions (directory configured,
 * framework version present, downloads enabled, installer present, id valid).
 * Returns a value-free error response, or `undefined` to continue.
 */
function checkDirectoryAction(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
):
  | { directory: PluginDirectory; frameworkVersion: string; installer: PluginInstaller; id: string }
  | Response {
  const directory = resolved.directory;
  if (directory === undefined) {
    return adminBadRequestResponse();
  }
  const frameworkVersion = resolved.frameworkVersion;
  if (frameworkVersion === undefined) {
    return forbiddenWithReasonResponse('framework version is not configured');
  }
  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });
  if (!capability.enabled) {
    return forbiddenWithReasonResponse(capability.reason ?? 'downloads are unavailable');
  }
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
  }
  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }
  return { directory, frameworkVersion, installer, id };
}

/** Look up a directory entry; a code-enabled id is refused before any install. */
function resolveDirectoryEntry(
  directory: PluginDirectory,
  resolved: ResolvedPluginManagerOptions,
  id: string,
): PluginDirectoryEntry | Response {
  const entry = directory.get(id);
  if (entry === undefined) {
    return adminNotFoundResponse();
  }
  if ((resolved.enabled ?? []).includes(id)) {
    return conflictResponse();
  }
  return entry;
}

/** Install a directory entry at its curated latest version. */
async function handleDirectoryInstall(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, resolved);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, resolved, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(resolved);

  let plan: InstallPlan;
  try {
    plan = planPluginInstall(entry, state, frameworkVersion);
  } catch (error) {
    return mapDirectoryPlanFailure(error);
  }

  try {
    await installer.install({ id: plan.pluginId, version: plan.toVersion, url: plan.specifier });
  } catch {
    return installFailureResponse();
  }

  return redirect(PLUGIN_NOTICE_INSTALLED);
}

/** Update a directory plugin to its curated latest version. */
async function handleDirectoryUpdate(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, resolved);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, resolved, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(resolved);
  const installed = installedPluginFromState(state, id);

  let plan: InstallPlan;
  try {
    plan = planPluginUpdate(entry, installed, frameworkVersion);
  } catch (error) {
    return mapDirectoryPlanFailure(error);
  }

  try {
    await installer.install({ id: plan.pluginId, version: plan.toVersion, url: plan.specifier });
  } catch {
    return installFailureResponse();
  }

  return redirect(PLUGIN_NOTICE_INSTALLED);
}

/** Roll a directory plugin back to the curated latest version. */
async function handleDirectoryRollback(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, resolved);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, resolved, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(resolved);
  const installed = installedPluginFromState(state, id);

  // The only deterministic rollback target is the curated latest version, which
  // is a valid previous version only when the active version is ahead of it;
  // otherwise the planner raises `no_previous_version` and the action is refused.
  const rollbackTarget =
    installed !== undefined && compareVersions(entry.latestVersion, installed.version) < 0
      ? { ...installed, previousVersion: entry.latestVersion }
      : installed;

  let plan: InstallPlan;
  try {
    plan = planPluginRollback(entry, rollbackTarget, frameworkVersion);
  } catch (error) {
    return mapDirectoryPlanFailure(error);
  }

  try {
    await installer.rollback(plan.pluginId, plan.toVersion);
  } catch {
    return adminServerErrorResponse();
  }

  return redirect(PLUGIN_NOTICE_ROLLED_BACK);
}

// ---------------------------------------------------------------------------
// Plugin list loading
// ---------------------------------------------------------------------------

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
  resolved: ResolvedPluginManagerOptions,
): Promise<readonly PluginManagerRow[]> {
  const { discovered, state } = await loadPluginData(resolved);
  const managed = resolved.managed === true && resolved.stateSource !== undefined;

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
