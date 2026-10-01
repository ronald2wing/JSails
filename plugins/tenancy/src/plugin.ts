/**
 * First-party tenancy plugin.
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

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { createServiceToken, type ServiceToken } from 'jsails/extensions';
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

/** Runtime tenant service provided under {@link tenancyToken}. */
export interface TenancyService {
  resolve(request: Request, context: TenantResolveContext): Promise<Tenant | null>;
}

/** Opaque token for the tenancy service. */
export const tenancyToken: ServiceToken<TenancyService> =
  createServiceToken<TenancyService>('tenancy');

/**
 * Build the first-party tenancy plugin. The plugin declares its entities
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
      services.provide(tenancyToken, {
        async resolve(request, context) {
          return options.resolveTenant(request, context);
        },
      });
    },
  });
}
