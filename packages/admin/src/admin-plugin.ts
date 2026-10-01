/**
 * Admin plugin contributions: the extension seam for composing an admin panel
 * out of pages, resources, and free-form navigation items.
 *
 * `defineAdminPlugin(spec)` validates a plugin specification (a non-empty id
 * plus a `register` callback that receives an {@link AdminPluginBuilder}) and
 * returns a frozen {@link AdminPlugin} descriptor, with the service tokens its
 * contributions read (`requires`), which the `admin` plugin requires so a
 * missing provider fails at boot. The descriptor is inert: it
 * is only consumed by {@link adminPlugin}, which invokes `register` during
 * application assembly so a plugin can contribute pages (`addPage`), resources
 * (`addResource`), and additional navigation links (`addNavigationItem`).
 *
 * Contributions are collected once, before routes are mounted, so every
 * plugin-provided surface shares the same dashboard navigation and the same
 * panel-wide slug uniqueness guarantee. The builder is a plain object handed to
 * trusted plugin code; a structurally invalid contribution is rejected with an
 * {@link AdminDefinitionError} at register time rather than surfacing as a
 * broken route later.
 *
 * Every page, resource, and row or bulk action is default-deny: one without
 * its own `authorize` is reachable by no one. `withAdminAuthorize(plugin,
 * authorize)` is how an app grants a plugin it did not write (and so cannot
 * add callbacks to) an explicit gate: every contribution of that plugin that
 * declares no `authorize` gets the given session gate, and one that declares
 * its own keeps it.
 *
 * The module is ORM-free: it imports only the page/resource descriptor types
 * and performs no I/O.
 */

import type { Session } from 'jsails';
import type { ServiceToken } from 'jsails/kernel';
import { isRecord } from 'jsails/plugin-sdk';

import type { AdminAction } from './actions.js';
import { resolveRequires } from './descriptor-shape.js';
import { AdminDefinitionError } from './errors.js';
import type { AdminPage, AdminPageAuthorize } from './page.js';
import type { RelationManager } from './relation-manager.js';
import type { AdminResourceAuthorize, Resource, ResourceActions } from './resource/index.js';

/** A free-form dashboard navigation link contributed by a plugin. */
export interface AdminNavigationItem {
  /** Human link label. */
  readonly label: string;
  /** Link target (an absolute path or full URL). */
  readonly href: string;
  /** Optional navigation group. */
  readonly group?: string;
  /** Optional navigation sort weight; lower sorts first. Defaults to `0`. */
  readonly sort?: number;
}

/** The contribution surface handed to a plugin's `register` callback. */
export interface AdminPluginBuilder {
  /** Contribute an admin page. */
  addPage(page: AdminPage): void;
  /** Contribute a free-form dashboard navigation link. */
  addNavigationItem(item: AdminNavigationItem): void;
  /** Contribute an admin CRUD resource. */
  addResource(resource: Resource): void;
}

/** A frozen, validated plugin descriptor consumed by {@link adminPlugin}. */
export interface AdminPlugin {
  /** Non-empty plugin id, unique within a panel. */
  readonly id: string;
  /**
   * Services the plugin's contributions read from the application. The
   * `admin` plugin requires each one, so it runs after their providers and a
   * missing provider fails at boot rather than on the first request.
   */
  readonly requires?: readonly ServiceToken<unknown>[];
  /** Invoked during assembly with the contribution builder. */
  readonly register: (builder: AdminPluginBuilder) => void;
}

/** Specification passed to {@link defineAdminPlugin}. */
export interface AdminPluginDefinition {
  /** Non-empty plugin id, unique within a panel. */
  readonly id: string;
  /** Services the plugin's contributions read from the application. */
  readonly requires?: readonly ServiceToken<unknown>[];
  /** Invoked during assembly with the contribution builder. */
  readonly register: (builder: AdminPluginBuilder) => void;
}

/** Validate a plugin spec and return a frozen descriptor. */
export function defineAdminPlugin(spec: AdminPluginDefinition): AdminPlugin {
  if (!isRecord(spec)) {
    throw new AdminDefinitionError(
      'invalid_admin_plugin',
      'defineAdminPlugin requires a spec object',
    );
  }
  if (typeof spec.id !== 'string' || spec.id.trim() === '') {
    throw new AdminDefinitionError(
      'invalid_admin_plugin',
      'admin plugin id must be a non-empty string',
    );
  }
  if (typeof spec.register !== 'function') {
    throw new AdminDefinitionError(
      'invalid_admin_plugin',
      'admin plugin must define a register function',
    );
  }
  const requires = resolveRequires(spec.requires, 'invalid_admin_plugin', 'admin plugin');
  return Object.freeze({
    id: spec.id,
    ...(requires === undefined ? {} : { requires }),
    register: spec.register,
  });
}

/** A session-only gate: exact `true` allows, anything else (or a throw) denies. */
export type AdminSessionGate = (session: Session) => boolean | Promise<boolean>;

/** Return `value` with `key` set, or `value` itself when `next` is the same reference. */
function withRef<T extends object, K extends keyof T>(value: T, key: K, next: T[K]): T {
  return value[key] === next ? value : Object.freeze({ ...value, [key]: next });
}

/**
 * Gated copies of a plugin's resources, keyed by the originals. Every reference
 * among them is rewritten to the copy: a relation manager's `related`, a
 * column's `related`, and an action's `parent` and `relationManager`. The
 * routes compare these references by identity (the related gate is the
 * referenced resource's `authorize`, a parent comes from `parent` or from the
 * resource listing the action's manager), so a reference left on an original
 * would meet that original's missing `authorize` and be refused. A reference
 * to a resource the plugin does not contribute is left as declared: it may be
 * the app's own resource, which this gate must not open.
 */
function gateResources(
  resources: readonly Resource[],
  gate: AdminSessionGate,
): ReadonlyMap<Resource, Resource> {
  // Copies are created empty first and filled afterwards, so resources that
  // refer to each other (A manages B, B manages A) can point at copies that
  // are not finished yet.
  const copies = new Map<Resource, Resource>();
  for (const resource of resources) {
    if (!copies.has(resource)) copies.set(resource, {} as Resource);
  }
  const remapResource = (resource: Resource): Resource => copies.get(resource) ?? resource;
  const managers = new Map<RelationManager, RelationManager>();
  const remapManager = (manager: RelationManager): RelationManager => {
    let copy = managers.get(manager);
    if (copy === undefined) {
      copy = withRef(manager, 'related', remapResource(manager.related));
      managers.set(manager, copy);
    }
    return copy;
  };
  const gateAction = (action: AdminAction): AdminAction => {
    let gated = action;
    if (gated.parent !== undefined) gated = withRef(gated, 'parent', remapResource(gated.parent));
    if (gated.relationManager !== undefined) {
      gated = withRef(gated, 'relationManager', remapManager(gated.relationManager));
    }
    if (gated.authorize === undefined) {
      gated = Object.freeze({
        ...gated,
        authorize: ({ session }: { session: Session }) => gate(session),
      });
    }
    return gated;
  };
  const gateActions = (actions: readonly AdminAction[]): readonly AdminAction[] =>
    Object.freeze(actions.map(gateAction));

  for (const [original, copy] of copies) {
    const { header, row, bulk } = original.actions ?? {};
    const actions: ResourceActions | undefined =
      original.actions === undefined
        ? undefined
        : Object.freeze({
            ...(header === undefined ? {} : { header: gateActions(header) }),
            ...(row === undefined ? {} : { row: gateActions(row) }),
            ...(bulk === undefined ? {} : { bulk: gateActions(bulk) }),
          });
    const authorize: AdminResourceAuthorize =
      original.authorize ?? (({ session }) => gate(session));
    Object.assign(copy, {
      ...original,
      authorize,
      columns: Object.freeze(
        original.columns.map((column) =>
          column.related === undefined
            ? column
            : withRef(column, 'related', remapResource(column.related)),
        ),
      ),
      ...(original.relationManagers === undefined
        ? {}
        : { relationManagers: Object.freeze(original.relationManagers.map(remapManager)) }),
      ...(actions === undefined ? {} : { actions }),
    });
    Object.freeze(copy);
  }
  return copies;
}

/** One contribution of a wrapped plugin, held until all are known. */
type Contribution =
  | { readonly kind: 'page'; readonly page: AdminPage }
  | { readonly kind: 'resource'; readonly resource: Resource }
  | { readonly kind: 'navigation'; readonly item: AdminNavigationItem };

/**
 * Grant an admin plugin an explicit gate: each page, resource, and resource
 * action it contributes without an `authorize` of its own gets `authorize`,
 * called with the session. References between the plugin's own resources (a
 * relation manager's or column's `related`, an action's `parent`) point at the
 * gated copies. A resource the plugin only refers to, without contributing it,
 * is left as declared (default-deny unless it has its own `authorize`).
 */
export function withAdminAuthorize(plugin: AdminPlugin, authorize: AdminSessionGate): AdminPlugin {
  if (typeof authorize !== 'function') {
    throw new AdminDefinitionError(
      'invalid_admin_plugin',
      'withAdminAuthorize requires an authorize function',
    );
  }
  return defineAdminPlugin({
    id: plugin.id,
    ...(plugin.requires === undefined ? {} : { requires: plugin.requires }),
    register(builder) {
      // Collected first, so a reference to a resource the plugin adds later
      // is rewritten too; then forwarded in the plugin's own order.
      const contributions: Contribution[] = [];
      plugin.register({
        addPage: (page) => contributions.push({ kind: 'page', page }),
        addResource: (resource) => contributions.push({ kind: 'resource', resource }),
        addNavigationItem: (item) => contributions.push({ kind: 'navigation', item }),
      });
      const resources = contributions.flatMap((entry) =>
        entry.kind === 'resource' && isRecord(entry.resource) ? [entry.resource] : [],
      );
      const gated = gateResources(resources, authorize);
      for (const entry of contributions) {
        if (entry.kind === 'page') {
          const { page } = entry;
          const pageAuthorize: AdminPageAuthorize | undefined = !isRecord(page)
            ? undefined
            : (page.authorize ?? (({ session }) => authorize(session)));
          builder.addPage(
            pageAuthorize === undefined
              ? page
              : Object.freeze({ ...page, authorize: pageAuthorize }),
          );
        } else if (entry.kind === 'resource') {
          builder.addResource(gated.get(entry.resource) ?? entry.resource);
        } else {
          builder.addNavigationItem(entry.item);
        }
      }
    },
  });
}
