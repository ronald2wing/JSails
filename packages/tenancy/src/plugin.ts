/**
 * Opt-in tenancy plugin: tenant resolution with membership and status
 * enforcement, exposed as `TenancyService` under `tenancyToken`.
 *
 * The plugin owns the default tenant and membership entities, but it is not
 * enabled by the framework or the starter by default. Adding it to
 * `plugins.use` is the opt-in; the schema command discovers
 * {@link tenancyEntities} through the plugin's static `schema` declaration.
 *
 * The app's resolver only says which tenant a request names (subdomain, path,
 * header, ...). Whatever it reads is client-controlled, so the service never
 * trusts it alone: by default a resolved tenant is handed out only when its
 * `status` is active and the session's user has a `TenantMembership` row in it.
 * Anything else is refused, and `resolve` returns `null` so tenant-scoped code
 * has no tenant id to query with. `resolveAccess` reports why, so a page can
 * answer 403 instead of 404. Results are memoized per `Request` and session
 * user, so every consumer in one request shares a single resolver call and
 * membership lookup.
 *
 * Tenancy stays auth-agnostic: the user id is read from the generic JSails
 * session (`data.userId`, or `data.user.id` as the auth plugin shapes it), and
 * membership stores an opaque user id with no foreign key into Better Auth.
 */

import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';
import type { Session } from 'jsails';
import { Tenant, TenantMembership, tenancyEntities } from './entities.js';

/** Context passed to the tenant resolver. */
export interface TenantResolveContext {
  readonly session: Session | null;
}

/** Resolve a request to the tenant it names, or `null` when the request is global. */
export type TenantResolver = (
  request: Request,
  context: TenantResolveContext,
) => Tenant | null | Promise<Tenant | null>;

/** Look up a user's membership in a tenant, or `null` when there is none. */
export type MembershipLookup = (
  tenant: Tenant,
  userId: string,
) => TenantMembership | null | Promise<TenantMembership | null>;

/** Why a named tenant was refused. */
export type TenantRefusal = 'anonymous' | 'not_member' | 'inactive';

/** The outcome of resolving a request's tenant. */
export type TenantAccess =
  | { readonly status: 'none' }
  | {
      readonly status: 'granted';
      readonly tenant: Tenant;
      /** The session user's membership; `null` only when membership is not required. */
      readonly membership: TenantMembership | null;
    }
  | { readonly status: 'refused'; readonly reason: TenantRefusal };

/** Options accepted by {@link tenancyPlugin}. */
export interface TenancyPluginOptions {
  /** App-owned tenant resolution (subdomain, session, header, config, ...). */
  readonly resolveTenant: TenantResolver;
  /**
   * Require the session's user to be a member of the resolved tenant. Defaults
   * to `true`; set `false` only for tenants whose content is public (a
   * tenant's marketing site), where anonymous visitors must resolve too.
   */
  readonly requireMembership?: boolean;
  /** Tenant `status` values that may be resolved. Defaults to `['active']`. */
  readonly activeStatuses?: readonly string[];
  /** Membership lookup. Defaults to a `TenantMembership` query by tenant and user id. */
  readonly findMembership?: MembershipLookup;
  /** Read the user id from a session. Defaults to `data.userId`, then `data.user.id`. */
  readonly sessionUserId?: (session: Session) => string | null;
}

/**
 * Runtime tenant service provided under {@link tenancyToken}. Both methods are
 * memoized per `Request` and session user.
 */
export interface TenancyService {
  /** The request's tenant when access is granted; `null` when none is named or it is refused. */
  resolve(request: Request, context: TenantResolveContext): Promise<Tenant | null>;
  /** The full outcome, including the membership and the refusal reason. */
  resolveAccess(request: Request, context: TenantResolveContext): Promise<TenantAccess>;
}

/** Opaque token for the tenancy service. */
export const tenancyToken: ServiceToken<TenancyService> =
  createServiceToken<TenancyService>('tenancy');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The default user id reader: `data.userId`, then the auth plugin's `data.user.id`. */
export function defaultSessionUserId(session: Session): string | null {
  const direct = session.data.userId;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const user = session.data.user;
  if (isRecord(user) && typeof user.id === 'string' && user.id.length > 0) {
    return user.id;
  }
  return null;
}

const defaultFindMembership: MembershipLookup = (tenant, userId) =>
  TenantMembership.findOne({ where: { tenant: { id: tenant.id }, userId } });

/**
 * Create the tenancy plugin. The plugin declares its entities
 * statically so `db:push` can discover them without calling `setup`.
 */
export function tenancyPlugin(options: TenancyPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('tenancyPlugin requires an options object');
  }
  if (typeof options.resolveTenant !== 'function') {
    throw new TypeError('tenancyPlugin requires a resolveTenant function');
  }
  if (options.requireMembership !== undefined && typeof options.requireMembership !== 'boolean') {
    throw new TypeError('requireMembership must be a boolean');
  }
  if (
    options.activeStatuses !== undefined &&
    (!Array.isArray(options.activeStatuses) ||
      !options.activeStatuses.every((status) => typeof status === 'string'))
  ) {
    throw new TypeError('activeStatuses must be an array of strings');
  }
  for (const name of ['findMembership', 'sessionUserId'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  const requireMembership = options.requireMembership ?? true;
  const activeStatuses = new Set(options.activeStatuses ?? ['active']);
  const findMembership = options.findMembership ?? defaultFindMembership;
  const sessionUserId = options.sessionUserId ?? defaultSessionUserId;

  async function decide(request: Request, context: TenantResolveContext): Promise<TenantAccess> {
    const tenant = await options.resolveTenant(request, context);
    if (tenant === null || tenant === undefined) {
      return { status: 'none' };
    }
    if (!activeStatuses.has(tenant.status)) {
      return { status: 'refused', reason: 'inactive' };
    }
    if (!requireMembership) {
      return { status: 'granted', tenant, membership: null };
    }
    const userId = context.session === null ? null : sessionUserId(context.session);
    if (userId === null) {
      return { status: 'refused', reason: 'anonymous' };
    }
    const membership = await findMembership(tenant, userId);
    if (membership === null || membership === undefined) {
      return { status: 'refused', reason: 'not_member' };
    }
    return { status: 'granted', tenant, membership };
  }

  return definePlugin({
    name: 'tenancy',
    schema: { entities: tenancyEntities },
    setup({ services }) {
      // One decision per Request object and session user: the resolver and the
      // membership query run once however many consumers ask. The session is
      // part of the key so a call made before the session was resolved (or with
      // another session) never hands its decision to a later call. The WeakMap
      // lets a finished request's entries be collected with it.
      const memo = new WeakMap<Request, Map<string, Promise<TenantAccess>>>();
      // `async` turns a synchronous resolver or session-reader throw into a
      // rejection; the entry is stored before the first await, so concurrent
      // callers still share it.
      const resolveAccess = async (
        request: Request,
        context: TenantResolveContext,
      ): Promise<TenantAccess> => {
        const key =
          context.session === null ? 'anonymous' : `user:${sessionUserId(context.session) ?? ''}`;
        let decisions = memo.get(request);
        if (decisions === undefined) {
          decisions = new Map();
          memo.set(request, decisions);
        }
        let pending = decisions.get(key);
        if (pending === undefined) {
          pending = decide(request, context);
          decisions.set(key, pending);
        }
        return pending;
      };
      services.provide(tenancyToken, {
        resolveAccess,
        resolve: async (request, context) => {
          const access = await resolveAccess(request, context);
          return access.status === 'granted' ? access.tenant : null;
        },
      });
    },
  });
}

/** Options for {@link subdomainTenantResolver}. */
export interface SubdomainTenantResolverOptions {
  /** The apex the tenant label sits under, e.g. `example.com` for `acme.example.com`. */
  readonly rootDomain: string;
  /** Tenant lookup by slug. Defaults to `Tenant.findOneBy({ slug })`. */
  readonly findTenant?: (slug: string) => Tenant | null | Promise<Tenant | null>;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A {@link TenantResolver} reading the tenant slug from exactly one subdomain
 * label under `rootDomain` and looking it up in the database. It names a
 * tenant; the plugin's membership check still decides whether the session may
 * use it.
 */
export function subdomainTenantResolver(options: SubdomainTenantResolverOptions): TenantResolver {
  if (typeof options.rootDomain !== 'string' || options.rootDomain.length === 0) {
    throw new TypeError('subdomainTenantResolver requires a rootDomain');
  }
  const suffix = `.${options.rootDomain.toLowerCase().replace(/^\.+/, '')}`;
  const findTenant = options.findTenant ?? ((slug: string) => Tenant.findOneBy({ slug }));
  return async (request) => {
    const host = new URL(request.url).hostname.toLowerCase();
    if (!host.endsWith(suffix)) {
      return null;
    }
    const label = host.slice(0, -suffix.length);
    if (!SLUG_PATTERN.test(label)) {
      return null;
    }
    return findTenant(label);
  };
}
