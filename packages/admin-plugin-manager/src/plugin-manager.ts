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
 * Access is default-deny at two levels, because a panel session is not by
 * itself an operator: both pages are served only when `authorize` resolves to
 * exactly `true`, and every action that changes which code runs (install,
 * update, rollback, uninstall, and enable/disable, which decides whether an
 * installed bundle loads on the next start) additionally requires
 * `authorizeInstall`. With
 * either callback absent, its surface is denied to every session.
 *
 * The `plugins` page renders the discovered plugin list plus, when configured,
 * the curated directory or the raw install form and the per-row
 * enable/disable/uninstall/rollback actions; a `POST` to the same path is
 * dispatched on the submitted `action` field. The admin already enforced its
 * auth gate, a same-origin `Origin`, and a constant-time `_csrf` check before
 * the page's `handlePost` runs, so this plugin owns only its own policy:
 * installs are gated behind the downloads capability (a `false`/`null`
 * `downloads` disables them), refuse code-enabled ids, and carry a mandatory
 * SHA-256 unless `allowUnverified` is set (each unverified install is reported
 * through `onWarning`); the raw URL form is off unless `allowRawInstall` is
 * set, accepts only `https:` URLs, and honors an optional `allowedHosts` list;
 * enable/disable require `managed: true` with a `stateSource`;
 * uninstall/rollback require an `installer`. A successful post 303-redirects
 * to `<path>/plugins?notice=<code>`.
 *
 * The module imports the admin page/builder descriptors and the plugin-system
 * discovery/state/installer modules; it never imports the admin route
 * registrar. Nothing in `@jsails/admin` depends back on this package.
 */

import { join } from 'node:path';

import {
  defineAdminPage,
  defineAdminPlugin,
  type AdminPageAuthorize,
  type AdminPlugin,
} from '@jsails/admin';
import type { Session } from 'jsails';
import { isRecord, JsailsError } from 'jsails/plugin-sdk';
import {
  DEFAULT_PLUGINS_DIR,
  isValidSemverVersion,
  PluginStateStore,
  type PluginInstaller,
  type PluginStateSource,
} from 'jsails/plugins';

import type { PluginDirectory } from './directory/catalog.js';
import { handlePluginSettingsPost, renderPluginSettingsPage } from './plugin-settings-page.js';
import { handlePluginsPost, renderPluginsPage } from './plugins-page.js';

/**
 * An action that changes which plugin code the application runs. Enable and
 * disable count: turning a disabled bundle back on runs its code after the next
 * start, which is exactly what the install gate protects.
 */
export type PluginInstallAction =
  'install' | 'update' | 'rollback' | 'uninstall' | 'enable' | 'disable';

/** Context handed to {@link PluginManagerAdminOptions.authorizeInstall}. */
export interface PluginInstallAuthorizeContext {
  /** The session the panel and page gates already allowed. */
  readonly session: Session;
  /** The code-changing action being attempted (or offered, on render). */
  readonly action: PluginInstallAction;
}

/** Default-deny gate for code-changing actions; exact `true` allows. */
export type PluginInstallAuthorize = (
  context: PluginInstallAuthorizeContext,
) => boolean | Promise<boolean>;

/**
 * Options for {@link pluginManagerAdmin}. The page callbacks capture the
 * validated, frozen copy `pluginManagerAdmin` makes of them.
 */
export interface PluginManagerAdminOptions {
  /**
   * Gate for both plugin manager pages, run after the panel's own `authorize`.
   * Default-deny: absent, every session is refused.
   */
  readonly authorize?: AdminPageAuthorize;
  /**
   * Gate for install, update, rollback, uninstall, enable, and disable, run
   * after `authorize`.
   * Default-deny: absent, those actions are hidden and refused.
   */
  readonly authorizeInstall?: PluginInstallAuthorize;
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
  /**
   * Mount the raw id/version/URL install form. Defaults to `false`: a bundle
   * from an arbitrary URL is opt-in, and never available beside a directory.
   */
  readonly allowRawInstall?: boolean;
  /** When set, the raw install form only accepts bundle URLs on these hosts. */
  readonly allowedHosts?: readonly string[];
  /**
   * Install bundles that carry no SHA-256 checksum. Defaults to `false`
   * (refused); each unverified install is reported through `onWarning`.
   */
  readonly allowUnverified?: boolean;
  /** Receives value-free install warnings. Defaults to `process.emitWarning`. */
  readonly onWarning?: (message: string) => void;
}

/**
 * The validated options plus what the pages derive from them once: the state
 * source every read and write goes through (the configured one, else the
 * default JSON store over `pluginsDir`, matching the installer's default) and
 * the warning sink.
 */
export interface ResolvedPluginManagerOptions extends PluginManagerAdminOptions {
  readonly state: PluginStateSource;
  readonly warn: (message: string) => void;
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

/** The page gate used when the app configured none. */
const denyAll = (): boolean => false;

/** The default warning sink: Node's process warning channel (stderr). */
function emitWarning(message: string): void {
  process.emitWarning(message, { code: 'JSAILS_PLUGIN_MANAGER' });
}

/**
 * Build the admin-plugin-manager admin plugin. The options are validated and frozen
 * eagerly; the returned descriptor is inert until the admin plugin invokes its
 * `register` during application assembly.
 */
export function pluginManagerAdmin(options: PluginManagerAdminOptions = {}): AdminPlugin {
  const resolved = resolveOptions(options);
  const authorize = resolved.authorize ?? denyAll;
  return defineAdminPlugin({
    id: 'admin-plugin-manager',
    register(builder) {
      builder.addPage(
        defineAdminPage({
          slug: 'plugins',
          label: 'Plugins',
          authorize,
          render: (context) => renderPluginsPage(context, resolved),
          handlePost: (context) => handlePluginsPost(context, resolved),
        }),
      );
      builder.addPage(
        defineAdminPage({
          slug: 'plugin-settings',
          label: 'Plugin Settings',
          authorize,
          render: (context) => renderPluginSettingsPage(context, resolved),
          handlePost: (context) => handlePluginSettingsPost(context, resolved),
        }),
      );
    },
  });
}

/** Validate {@link PluginManagerAdminOptions} and return a frozen resolved copy. */
function resolveOptions(options: PluginManagerAdminOptions): ResolvedPluginManagerOptions {
  // Checked as `unknown` so the predicate does not narrow the declared type.
  const candidate: unknown = options;
  if (!isRecord(candidate)) {
    throw invalid('pluginManagerAdmin requires an options object');
  }
  for (const key of ['authorize', 'authorizeInstall', 'onWarning'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw invalid(`${key} must be a function`);
    }
  }
  for (const key of ['managed', 'allowRawInstall', 'allowUnverified'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw invalid(`${key} must be a boolean`);
    }
  }
  if (options.enabled !== undefined && !isNonEmptyStringArray(options.enabled)) {
    throw invalid('enabled must be an array of plugin ids');
  }
  if (options.allowedHosts !== undefined && !isNonEmptyStringArray(options.allowedHosts)) {
    throw invalid('allowedHosts must be an array of host names');
  }
  if (options.pluginsDir !== undefined) {
    if (typeof options.pluginsDir !== 'string' || options.pluginsDir.length === 0) {
      throw invalid('pluginsDir must be a non-empty string');
    }
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
  const pluginsDir = options.pluginsDir ?? join(process.cwd(), DEFAULT_PLUGINS_DIR);
  const resolved: ResolvedPluginManagerOptions = {
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    ...(options.authorizeInstall === undefined
      ? {}
      : { authorizeInstall: options.authorizeInstall }),
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
    ...(options.allowRawInstall === undefined ? {} : { allowRawInstall: options.allowRawInstall }),
    ...(options.allowedHosts === undefined
      ? {}
      : {
          allowedHosts: Object.freeze(options.allowedHosts.map((host) => host.toLowerCase())),
        }),
    ...(options.allowUnverified === undefined ? {} : { allowUnverified: options.allowUnverified }),
    state: options.stateSource ?? new PluginStateStore({ pluginsDir }),
    warn: options.onWarning ?? emitWarning,
  };
  return Object.freeze(resolved);
}

/** Whether `value` is an array of non-empty strings. */
function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string' && item.length > 0)
  );
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
