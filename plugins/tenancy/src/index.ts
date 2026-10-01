/**
 * First-party tenancy plugin and its framework-owned entities.
 *
 * Enable it explicitly:
 *
 * ```js
 * plugins: {
 *   use: [['jsails/tenancy', { resolveTenant }]],
 * }
 * ```
 *
 * The schema command discovers {@link tenancyEntities} from the enabled plugin;
 * disabling the plugin leaves the application schema untouched.
 */

export { Tenant, TenantMembership, tenancyEntities } from './entities.js';
export {
  tenancyPlugin,
  tenancyToken,
  type TenancyPluginOptions,
  type TenancyService,
  type TenantResolveContext,
  type TenantResolver,
} from './plugin.js';

// The declarative loader calls `mod.default(options)`, so the plugin subpath
// barrel default-exports its factory alongside the named export.
export { tenancyPlugin as default } from './plugin.js';
