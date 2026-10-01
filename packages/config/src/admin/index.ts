/**
 * Config admin (`@jsails/config/admin`): a server-only admin surface that
 * renders an edit form for every config set. It is a separate subpath so
 * `@jsails/config` itself never loads `@jsails/admin`, an optional peer.
 *
 * `configAdmin({ config })` returns an {@link AdminPlugin} (id `config`) that
 * contributes the `config` page; `defineConfigAdminPage` builds the page alone.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';

import { defineConfigAdminPage, type ConfigAdminPageOptions } from './page.js';

export { defineConfigAdminPage, type ConfigAdminPageOptions } from './page.js';

/** Options for {@link configAdmin}; identical to the page options. */
export type ConfigAdminOptions = ConfigAdminPageOptions;

/** Create the config admin plugin. Inert until the admin panel assembles it. */
export function configAdmin(options: ConfigAdminOptions): AdminPlugin {
  const page = defineConfigAdminPage(options);
  return defineAdminPlugin({
    id: 'config',
    register(builder) {
      builder.addPage(page);
    },
  });
}
