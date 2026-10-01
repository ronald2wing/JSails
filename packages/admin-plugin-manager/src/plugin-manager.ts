/**
 * The plugin manager admin contribution: the admin plugin that mounts the
 * plugin install/enable/disable/uninstall/rollback surface under the admin
 * panel.
 *
 * `pluginManagerAdmin(options)` returns an {@link AdminPlugin} (id
 * `admin-plugin-manager`) whose `register` contributes the `plugins` and
 * `plugin-settings` admin pages. They are mounted by `adminPlugin` under the
 * panel path exactly like any other admin page, so the plugin manager is
 * ordinary panel composition, not a special route registrar inside the admin,
 * and not a framework plugin of its own.
 *
 * The `plugins` page renders the discovered plugin list plus, when configured,
 * the install form and the per-row enable/disable/uninstall/rollback actions; a
 * `POST` to the same path is dispatched on the submitted `action` field. The
 * admin already enforced the default-deny auth gate, a same-origin `Origin`,
 * and a constant-time `_csrf` check before the page's `handlePost` runs, so
 * this plugin owns only its own policy: installs are gated behind
 * the downloads capability (a `false`/`null` `downloads` disables
 * them) and refuse code-enabled ids; enable/disable require `managed: true`
 * with a `stateSource`; uninstall/rollback require an `installer`. A successful
 * post 303-redirects to `<path>/plugins?notice=<code>`.
 *
 * The module imports the admin page/builder descriptors and the plugin-system
 * discovery/state/installer modules; it never imports the admin route
 * registrar. Nothing in `@jsails/admin` depends back on this package.
 */

import { defineAdminPage, defineAdminPlugin, type AdminPlugin } from '@jsails/admin';
import { isRecord, JsailsError } from 'jsails/plugin-sdk';
import { isValidSemverVersion, type PluginInstaller, type PluginStateSource } from 'jsails/plugins';

import type { PluginDirectory } from './directory/catalog.js';
import { handlePluginSettingsPost, renderPluginSettingsPage } from './plugin-settings-page.js';
import { handlePluginsPost, renderPluginsPage } from './plugins-page.js';

/**
 * Options for {@link pluginManagerAdmin}. The page callbacks capture the
 * validated, frozen copy `pluginManagerAdmin` makes of them.
 */
export interface PluginManagerAdminOptions {
  /** Explicit enable allow-list passed to discovery. */
  readonly enabled?: readonly string[];
  /** Storage-backed plugins folder. Defaults to `<cwd>/storage/plugins`. */
  readonly pluginsDir?: string;
  /** When `true` with a `stateSource`, enable/disable actions are mounted. */
  readonly managed?: boolean;
  /** Download capability; `false` disables installs. Defaults to enabled. */
  readonly downloads?: boolean | null;
  /** Persisted plugin state source (JSON store or database-backed). */
  readonly stateSource?: PluginStateSource;
  /** Installer surface for install/uninstall/rollback actions. */
  readonly installer?: PluginInstaller;
  /** Curated plugin directory; when set, it replaces the raw install form. */
  readonly directory?: PluginDirectory;
  /** Framework version for directory compatibility checks (valid semver). */
  readonly frameworkVersion?: string;
}

/** Stable machine code carried by every {@link PluginManagerError}. */
export type PluginManagerErrorCode = 'invalid_options';

/** Raised for invalid {@link PluginManagerAdminOptions}; messages are value-free. */
export class PluginManagerError extends JsailsError {
  constructor(
    readonly code: PluginManagerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Raise the value-free options error. */
function invalid(message: string): PluginManagerError {
  return new PluginManagerError('invalid_options', message);
}

/**
 * Build the admin-plugin-manager admin plugin. The options are validated and frozen
 * eagerly; the returned descriptor is inert until the admin plugin invokes its
 * `register` during application assembly.
 */
export function pluginManagerAdmin(options: PluginManagerAdminOptions = {}): AdminPlugin {
  const resolved = resolveOptions(options);
  return defineAdminPlugin({
    id: 'admin-plugin-manager',
    register(builder) {
      builder.addPage(
        defineAdminPage({
          slug: 'plugins',
          label: 'Plugins',
          render: (context) => renderPluginsPage(context, resolved),
          handlePost: (context) => handlePluginsPost(context, resolved),
        }),
      );
      builder.addPage(
        defineAdminPage({
          slug: 'plugin-settings',
          label: 'Plugin Settings',
          render: (context) => renderPluginSettingsPage(context, resolved),
          handlePost: (context) => handlePluginSettingsPost(context, resolved),
        }),
      );
    },
  });
}

/** Validate {@link PluginManagerAdminOptions} and return a frozen copy. */
function resolveOptions(options: PluginManagerAdminOptions): PluginManagerAdminOptions {
  // Checked as `unknown` so the predicate does not narrow the declared type.
  const candidate: unknown = options;
  if (!isRecord(candidate)) {
    throw invalid('pluginManagerAdmin requires an options object');
  }
  if (options.enabled !== undefined) {
    if (!Array.isArray(options.enabled)) {
      throw invalid('enabled must be an array of plugin ids');
    }
    for (const id of options.enabled) {
      if (typeof id !== 'string' || id.length === 0) {
        throw invalid('enabled must be an array of plugin ids');
      }
    }
  }
  if (options.pluginsDir !== undefined) {
    if (typeof options.pluginsDir !== 'string' || options.pluginsDir.length === 0) {
      throw invalid('pluginsDir must be a non-empty string');
    }
  }
  if (options.managed !== undefined && typeof options.managed !== 'boolean') {
    throw invalid('managed must be a boolean');
  }
  if (
    options.downloads !== undefined &&
    options.downloads !== null &&
    typeof options.downloads !== 'boolean'
  ) {
    throw invalid('downloads must be a boolean');
  }
  if (options.stateSource !== undefined && !hasMethods(options.stateSource, ['load', 'save'])) {
    throw invalid('stateSource must be a plugin state source');
  }
  if (
    options.installer !== undefined &&
    !hasMethods(options.installer, ['install', 'uninstall', 'rollback'])
  ) {
    throw invalid('installer must be a plugin installer');
  }
  if (options.directory !== undefined && !isDirectory(options.directory)) {
    throw invalid('directory must be a plugin directory');
  }
  if (options.frameworkVersion !== undefined) {
    if (
      typeof options.frameworkVersion !== 'string' ||
      !isValidSemverVersion(options.frameworkVersion)
    ) {
      throw invalid('frameworkVersion must be a valid semver version');
    }
  }
  const resolved: PluginManagerAdminOptions = {
    ...(options.enabled === undefined ? {} : { enabled: Object.freeze([...options.enabled]) }),
    ...(options.pluginsDir === undefined ? {} : { pluginsDir: options.pluginsDir }),
    ...(options.managed === undefined ? {} : { managed: options.managed }),
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
    ...(options.stateSource === undefined ? {} : { stateSource: options.stateSource }),
    ...(options.installer === undefined ? {} : { installer: options.installer }),
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.frameworkVersion === undefined
      ? {}
      : { frameworkVersion: options.frameworkVersion }),
  };
  return Object.freeze(resolved);
}

/** Whether `value` is an object carrying every named method. */
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return isRecord(value) && methods.every((method) => typeof value[method] === 'function');
}

/** Whether `value` is shaped like a {@link PluginDirectory}. */
function isDirectory(value: unknown): value is PluginDirectory {
  return (
    isRecord(value) &&
    Array.isArray(value['entries']) &&
    Array.isArray(value['categories']) &&
    hasMethods(value, ['get', 'list', 'search'])
  );
}
