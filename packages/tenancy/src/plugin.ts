/**
 * Opt-in tenancy plugin: auth-agnostic tenant resolution exposed as
 * `TenancyService` under `tenancyToken`.
 *
 * The plugin owns the default tenant and membership entities, but it is not
 * enabled by the framework or the starter by default. Adding it to
 * `plugins.use` is the opt-in; the schema command discovers
 * {@link tenancyEntities} through the plugin's static `schema` declaration.
 *
 * Tenancy is auth-agnostic. The resolver receives the generic JSails session
 * context; membership stores an opaque user id and never imports the auth
 * plugin or foreign-keys into Better Auth's table.
 */

import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';
import type { Session } from 'jsails';
import { tenancyEntities, type Tenant } from './entities.js';

/** Context passed to the tenant resolver. */
export interface TenantResolveContext {
  readonly session: Session | null;
}

/** Resolve a request to its tenant, or `null` when the request is global. */
export type TenantResolver = (
  request: Request,
  context: TenantResolveContext,
) => Tenant | null | Promise<Tenant | null>;

/** Options accepted by {@link tenancyPlugin}. */
export interface TenancyPluginOptions {
  /** App-owned tenant resolution (subdomain, session, header, config, ...). */
  readonly resolveTenant: TenantResolver;
}

/**
 * Runtime tenant service provided under {@link tenancyToken}. Unlike the
 * app-owned {@link TenantResolver}, `resolve` always returns a promise.
 */
export interface TenancyService {
  resolve(request: Request, context: TenantResolveContext): Promise<Tenant | null>;
}

/** Opaque token for the tenancy service. */
export const tenancyToken: ServiceToken<TenancyService> =
  createServiceToken<TenancyService>('tenancy');

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

  return definePlugin({
    name: 'tenancy',
    schema: { entities: tenancyEntities },
    setup({ services }) {
      // The app's resolver may be synchronous or asynchronous; the service
      // normalizes it to one promise-returning seam so a consumer always awaits
      // the same shape and a synchronous throw surfaces as a rejection.
      services.provide(tenancyToken, {
        resolve: async (request, context) => options.resolveTenant(request, context),
      });
    },
  });
}
