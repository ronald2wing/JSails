/**
 * Tenant roles as code-defined data.
 *
 * An app declares its membership roles once with {@link defineTenantRoles}:
 * each role has a rank (higher is more privileged) and a list of permissions
 * drawn from the built-in {@link TENANCY_PERMISSIONS} vocabulary and the app's
 * own declared vocabulary. The returned {@link TenantRoleSet} is frozen and
 * answers the four questions authorization needs: parse a stored role, rank
 * it, check a permission, and check whether one role may assign another.
 *
 * `owner` is reserved. It is a valid stored membership role (the one source of
 * truth for who owns a tenant), it ranks above every app role and holds every
 * permission, but no app may define it and {@link TenantRoleSet.canAssign}
 * never grants it: ownership only moves through a transfer.
 * `tenant.transfer` is likewise held by the owner alone and cannot be given to
 * a defined role. `tenant.delete` and `plan.manage` are owner-only in
 * {@link defaultTenantRoles}; an app may grant them to its own roles.
 *
 * User ids and actors never appear here, so the rules hold whatever the
 * identity layer looks like.
 */

import { TenancyError } from './tenancy-error.js';

const tenancyPermissions = [
  'tenant.view',
  'tenant.update',
  'tenant.delete',
  'tenant.transfer',
  'members.view',
  'members.invite',
  'members.remove',
  'members.role',
  'domains.manage',
  'settings.manage',
  'plan.manage',
  'audit.view',
] as const;
/** Built-in tenancy permissions. */
export const TENANCY_PERMISSIONS: typeof tenancyPermissions = Object.freeze(tenancyPermissions);

/** A built-in tenancy permission. */
export type TenancyPermission = (typeof TENANCY_PERMISSIONS)[number];

/** The reserved owner role. */
export const OWNER_ROLE = 'owner';

/** Permissions that only the owner holds; no defined role may list them. */
export const OWNER_ONLY_PERMISSIONS: readonly TenancyPermission[] = Object.freeze([
  'tenant.transfer',
]);

/** One role in a {@link defineTenantRoles} spec. */
export interface TenantRoleSpec<P extends string> {
  /** Integer from 1 to 1000000; higher is more privileged; unique within the set. */
  readonly rank: number;
  readonly permissions: readonly (NoInfer<P> | TenancyPermission)[];
  readonly label?: string;
}

/** The input of {@link defineTenantRoles}. */
export interface TenantRolesDefinition<R extends string, P extends string> {
  readonly roles: Readonly<Record<R, TenantRoleSpec<P>>>;
  /** The role an invitation gets when none is named. */
  readonly defaultRole: NoInfer<R>;
  /** The app's own permission vocabulary (`posts.publish`, ...). */
  readonly permissions?: readonly P[];
}

/** A frozen role set built by {@link defineTenantRoles}. */
export interface TenantRoleSet<R extends string = string, P extends string = never> {
  /** Defined roles, most privileged first; never includes `owner`. */
  readonly roles: readonly R[];
  readonly defaultRole: R;
  /** Every permission the set knows: built-in first, then the app's. */
  readonly permissions: readonly (P | TenancyPermission)[];
  /** A stored role value, or `null` when it is neither a defined role nor `owner`. */
  parse(value: string): R | typeof OWNER_ROLE | null;
  /** The rank of a role; `owner` ranks above every defined role. Throws `invalid_role`. */
  rank(role: R | typeof OWNER_ROLE): number;
  /** Whether a role holds a permission. Unknown roles and permissions are refused. */
  allows(role: R | typeof OWNER_ROLE, permission: P | TenancyPermission): boolean;
  /**
   * The rank rule: an actor may move a member from `from` (`null` for a new
   * member) to `to` only when both rank strictly below the actor's own role.
   * `owner` is never assignable and an owner is never re-roled this way.
   */
  canAssign(actorRole: R | typeof OWNER_ROLE, from: R | null, to: R): boolean;
}

/** The highest rank a defined role may have; the owner ranks one above the highest in use. */
const MAX_RANK = 1_000_000;

const ROLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PERMISSION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function invalid(): TenancyError {
  return new TenancyError('invalid_role_set');
}

/**
 * Define the membership roles of a tenant. Throws `invalid_role_set` when a
 * role is named `owner` or is not a lower-case identifier, a rank is not a
 * unique positive integer, a permission is unknown or owner-only, the app
 * vocabulary is malformed or collides with a built-in, or the default role is
 * not defined.
 */
export function defineTenantRoles<const R extends string, const P extends string = never>(
  definition: TenantRolesDefinition<R, P>,
): TenantRoleSet<R, P> {
  const appPermissions: readonly P[] = definition.permissions ?? [];
  const vocabulary = new Set<string>(TENANCY_PERMISSIONS);
  for (const permission of appPermissions) {
    if (!PERMISSION_NAME.test(permission) || vocabulary.has(permission)) {
      throw invalid();
    }
    vocabulary.add(permission);
  }

  const names = Object.keys(definition.roles) as R[];
  if (names.length === 0) {
    throw invalid();
  }
  const ranks = new Map<string, number>();
  const grants = new Map<string, ReadonlySet<string>>();
  const usedRanks = new Set<number>();
  for (const name of names) {
    const role: TenantRoleSpec<P> = definition.roles[name];
    if (name === OWNER_ROLE || !ROLE_NAME.test(name)) {
      throw invalid();
    }
    if (
      !Number.isSafeInteger(role.rank) ||
      role.rank <= 0 ||
      role.rank > MAX_RANK ||
      usedRanks.has(role.rank) ||
      !Array.isArray(role.permissions)
    ) {
      throw invalid();
    }
    usedRanks.add(role.rank);
    const held = new Set<string>();
    for (const permission of role.permissions) {
      if (!vocabulary.has(permission) || OWNER_ONLY_PERMISSIONS.some((p) => p === permission)) {
        throw invalid();
      }
      held.add(permission);
    }
    ranks.set(name, role.rank);
    grants.set(name, held);
  }
  if (typeof definition.defaultRole !== 'string' || !ranks.has(definition.defaultRole)) {
    throw invalid();
  }

  const ownerRank = Math.max(...usedRanks) + 1;
  const ordered = Object.freeze(
    [...names].sort((a, b) => (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0)),
  );
  const permissions: readonly (P | TenancyPermission)[] = Object.freeze([
    ...TENANCY_PERMISSIONS,
    ...appPermissions,
  ]);

  const rankOf = (role: string): number | null =>
    role === OWNER_ROLE ? ownerRank : (ranks.get(role) ?? null);

  return Object.freeze({
    roles: ordered,
    defaultRole: definition.defaultRole,
    permissions,
    parse(value: string): R | typeof OWNER_ROLE | null {
      if (typeof value !== 'string') {
        return null;
      }
      if (value === OWNER_ROLE) {
        return OWNER_ROLE;
      }
      return ordered.find((name) => name === value) ?? null;
    },
    rank(role: R | typeof OWNER_ROLE): number {
      const rank = typeof role === 'string' ? rankOf(role) : null;
      if (rank === null) {
        throw new TenancyError('invalid_role');
      }
      return rank;
    },
    allows(role: R | typeof OWNER_ROLE, permission: P | TenancyPermission): boolean {
      if (typeof role !== 'string' || typeof permission !== 'string') {
        return false;
      }
      if (!vocabulary.has(permission) || rankOf(role) === null) {
        return false;
      }
      return role === OWNER_ROLE || (grants.get(role)?.has(permission) ?? false);
    },
    canAssign(actorRole: R | typeof OWNER_ROLE, from: R | null, to: R): boolean {
      const actor = typeof actorRole === 'string' ? rankOf(actorRole) : null;
      const target = typeof to === 'string' && to !== OWNER_ROLE ? rankOf(to) : null;
      if (actor === null || target === null || target >= actor) {
        return false;
      }
      if (from === null) {
        return true;
      }
      const current = typeof from === 'string' && from !== OWNER_ROLE ? rankOf(from) : null;
      return current !== null && current < actor;
    },
  });
}

/**
 * The default role set: `admin` manages the tenant and its members, `member`
 * sees the tenant and its members, `viewer` sees the tenant. Deleting the
 * tenant, managing its plan and transferring it stay with the owner.
 */
export const defaultTenantRoles: TenantRoleSet<'admin' | 'member' | 'viewer'> = defineTenantRoles({
  roles: {
    admin: {
      rank: 30,
      label: 'Admin',
      permissions: [
        'tenant.view',
        'tenant.update',
        'members.view',
        'members.invite',
        'members.remove',
        'members.role',
        'domains.manage',
        'settings.manage',
        'audit.view',
      ],
    },
    member: { rank: 20, label: 'Member', permissions: ['tenant.view', 'members.view'] },
    viewer: { rank: 10, label: 'Viewer', permissions: ['tenant.view'] },
  },
  defaultRole: 'member',
});
