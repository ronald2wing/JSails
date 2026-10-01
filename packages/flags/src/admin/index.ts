/**
 * Feature-flags admin (`@jsails/flags/admin`): a server-only admin surface for
 * global flags. It is a separate subpath so `@jsails/flags` itself never loads
 * `@jsails/admin`, which is only an optional peer.
 *
 * `flagsAdmin({ store })` returns an {@link AdminPlugin} (id `flags`) that
 * contributes the `flags` page over the same store the app passes to
 * `flagsPlugin({ store })`; `defineFlagsAdminPage` builds that page alone for
 * a panel's `pages` list.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';

import { defineFlagsAdminPage, type FlagsAdminPageOptions } from './page.js';

export { defineFlagsAdminPage, type FlagsAdminPageOptions } from './page.js';

/** Options for {@link flagsAdmin}; identical to the page options. */
export type FlagsAdminOptions = FlagsAdminPageOptions;

/**
 * Create the flags admin plugin. The returned descriptor is inert until the
 * admin plugin invokes its `register` during assembly.
 */
export function flagsAdmin(options: FlagsAdminOptions): AdminPlugin {
  const page = defineFlagsAdminPage(options);
  return defineAdminPlugin({
    id: 'flags',
    register(builder) {
      builder.addPage(page);
    },
  });
}
