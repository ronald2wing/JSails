/**
 * Feature-flags admin (`@jsails/flags/admin`): a server-only admin surface for
 * global flags. It is a separate subpath so `@jsails/flags` itself never loads
 * `@jsails/admin`, which is only an optional peer.
 *
 * `flagsAdmin(options?)` returns an {@link AdminPlugin} (id `flags`) that
 * contributes the `flags` page over the app's service (the one `flagsPlugin`
 * provides under `flagsToken`); `defineFlagsAdminPage` builds that page alone
 * for a panel's `pages` list. Both declare `requires: [flagsToken]`, so the
 * `admin` plugin requires the flags service and a panel configured without
 * `@jsails/flags` fails at boot.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';

import { flagsToken } from '../plugin.js';
import { defineFlagsAdminPage, type FlagsAdminPageOptions } from './page.js';

export { defineFlagsAdminPage, type FlagsAdminPageOptions } from './page.js';

/** Options for {@link flagsAdmin}; identical to the page options. */
export type FlagsAdminOptions = FlagsAdminPageOptions;

/**
 * Create the flags admin plugin. The returned descriptor is inert until the
 * admin plugin invokes its `register` during assembly.
 */
export function flagsAdmin(options: FlagsAdminOptions = {}): AdminPlugin {
  const page = defineFlagsAdminPage(options);
  return defineAdminPlugin({
    id: 'flags',
    requires: [flagsToken],
    register(builder) {
      builder.addPage(page);
    },
  });
}
