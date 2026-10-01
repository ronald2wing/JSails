/**
 * The plugin manager's install permission: whether a session may run, or be
 * offered, an action that changes which plugin code the application runs.
 *
 * Reaching the plugin manager pages (`authorize`) is not enough to install,
 * update, roll back, uninstall, enable, or disable a plugin; those need
 * `authorizeInstall` to
 * resolve to exactly `true`. An absent callback, a non-`true` result, and a
 * throw all deny, so a misconfigured gate fails closed.
 */

import type { Session } from 'jsails';

import type { PluginInstallAction, ResolvedPluginManagerOptions } from './plugin-manager.js';

/** Every code-changing action, in the order the render side asks about them. */
const INSTALL_ACTIONS: readonly PluginInstallAction[] = [
  'install',
  'update',
  'rollback',
  'uninstall',
  'enable',
  'disable',
];

/** Whether `session` may perform `action`; default-deny, a throw denies. */
export async function allowsInstallAction(
  options: ResolvedPluginManagerOptions,
  session: Session,
  action: PluginInstallAction,
): Promise<boolean> {
  const authorizeInstall = options.authorizeInstall;
  if (authorizeInstall === undefined) {
    return false;
  }
  try {
    return (await authorizeInstall({ session, action })) === true;
  } catch {
    return false;
  }
}

/** The set of code-changing actions `session` may be offered on render. */
export async function allowedInstallActions(
  options: ResolvedPluginManagerOptions,
  session: Session,
): Promise<ReadonlySet<PluginInstallAction>> {
  const allowed = new Set<PluginInstallAction>();
  for (const action of INSTALL_ACTIONS) {
    if (await allowsInstallAction(options, session, action)) {
      allowed.add(action);
    }
  }
  return allowed;
}
