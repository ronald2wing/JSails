/**
 * The curated plugin directory section of the plugins page: its render side
 * (search, category filter, one card per entry with the single applicable
 * install/update/rollback action) and the `directory-*` POST handlers.
 *
 * Each action is planned by the pure directory planners (`./directory/`) against
 * the installed state before the installer runs, so compatibility and version
 * checks happen before any download. Every failure is a value-free response.
 */

import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
  type AdminPageRenderContext,
} from '@jsails/admin';
import {
  isValidSemverVersion,
  PLUGIN_ID_PATTERN,
  PLUGIN_STATE_VERSION,
  type DownloadsCapability,
  type PluginInstaller,
  type PluginState,
  type PluginStateEntry,
} from 'jsails/plugins';

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
import { downloadsCapability, stateEntry } from './installed-plugins.js';
import {
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  type PluginNoticeCode,
} from './plugin-notices.js';
import type { PluginManagerAdminOptions } from './plugin-manager.js';
import { conflictResponse, installFailureResponse } from './responses.js';

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
export async function renderDirectorySection(
  directory: PluginDirectory,
  context: AdminPageRenderContext,
  options: PluginManagerAdminOptions,
): Promise<ComponentChild[]> {
  const path = context.path;
  const frameworkVersion = options.frameworkVersion;
  const csrf = context.session.csrfToken;

  const q = context.url.searchParams.get('q') ?? '';
  const category = context.url.searchParams.get('category') ?? '';

  const entries = listDirectoryEntries(directory, q, category);
  const state = await loadDirectoryState(options);

  const capability = downloadsCapability(options);

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
        renderDirectoryEntry(entry, stateEntry(state, entry.id), options, capability, path, csrf),
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
  options: PluginManagerAdminOptions,
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
    renderDirectoryAction(entry.id, operation, options, capability, path, csrf),
  );
}

/** Render the single action (button) or current-state label for an entry. */
function renderDirectoryAction(
  id: string,
  operation: DirectoryOperation,
  options: PluginManagerAdminOptions,
  capability: DownloadsCapability,
  path: string,
  csrf: string,
): ComponentChild {
  const actionable =
    options.installer !== undefined && options.frameworkVersion !== undefined && capability.enabled;

  const form = (action: string, label: string): ComponentChild =>
    actionForm({ path: `${path}/plugins`, csrf, action, id, label });

  switch (operation) {
    case 'install':
      return actionable ? form('directory-install', 'Install') : h('p', null, 'Available');
    case 'update':
      return actionable ? form('directory-update', 'Update') : h('p', null, 'Update available');
    case 'rollback':
      return actionable
        ? form('directory-rollback', 'Rollback')
        : h('p', null, 'Rollback available');
    case 'none':
      return h('p', null, 'Installed');
  }
}

/** Load installed state for the directory, defaulting to empty when absent/failed. */
async function loadDirectoryState(options: PluginManagerAdminOptions): Promise<PluginState> {
  if (options.stateSource === undefined) {
    return { version: PLUGIN_STATE_VERSION, plugins: {} };
  }
  try {
    return await options.stateSource.load();
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
      return adminForbiddenResponse('plugin is not compatible with this framework');
    }
    return adminBadRequestResponse();
  }
  if (error instanceof DirectoryError) {
    return adminBadRequestResponse();
  }
  throw error;
}

/**
 * Resolve the shared directory-action preconditions (directory configured,
 * framework version present, downloads enabled, installer present, id valid).
 * Returns a value-free error response, or `undefined` to continue.
 */
function checkDirectoryAction(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
):
  | { directory: PluginDirectory; frameworkVersion: string; installer: PluginInstaller; id: string }
  | Response {
  const directory = options.directory;
  if (directory === undefined) {
    return adminBadRequestResponse();
  }
  const frameworkVersion = options.frameworkVersion;
  if (frameworkVersion === undefined) {
    return adminForbiddenResponse('framework version is not configured');
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
  return { directory, frameworkVersion, installer, id };
}

/** Look up a directory entry; a code-enabled id is refused before any install. */
function resolveDirectoryEntry(
  directory: PluginDirectory,
  options: PluginManagerAdminOptions,
  id: string,
): PluginDirectoryEntry | Response {
  const entry = directory.get(id);
  if (entry === undefined) {
    return adminNotFoundResponse();
  }
  if ((options.enabled ?? []).includes(id)) {
    return conflictResponse();
  }
  return entry;
}

/** Install a directory entry at its curated latest version. */
export async function handleDirectoryInstall(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, options);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, options, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(options);

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
export async function handleDirectoryUpdate(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, options);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, options, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(options);
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
export async function handleDirectoryRollback(
  body: Record<string, string>,
  options: PluginManagerAdminOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const preconditions = checkDirectoryAction(body, options);
  if (preconditions instanceof Response) return preconditions;
  const { directory, frameworkVersion, installer, id } = preconditions;

  const entry = resolveDirectoryEntry(directory, options, id);
  if (entry instanceof Response) return entry;

  const state = await loadDirectoryState(options);
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
