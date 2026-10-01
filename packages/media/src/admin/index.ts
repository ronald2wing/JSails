/**
 * Media admin (`@jsails/media/admin`): a server-only admin surface for the
 * media library.
 *
 * `mediaAdmin(options)` returns an {@link AdminPlugin} (id `media`) that
 * contributes one page (slug `media`, label `Media`) rendering the upload /
 * search / edit / delete surface over a caller-supplied `MediaLibrary`.
 * The library is captured by closure and is never recreated, so an application
 * that also serves media bytes elsewhere must hand the same instance here and
 * there.
 *
 * The page default path is the admin panel path provided at render time
 * (`context.path`), so the plugin follows whatever base path the panel is
 * mounted on — the `path` option only overrides it.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';
import { isNonNegativeInteger } from 'jsails/plugin-sdk';

import { defineMediaAdminPage, type MediaAdminPageOptions } from './page.js';

export { defineMediaAdminPage, type MediaAdminPageOptions } from './page.js';

/** Options for {@link mediaAdmin}; identical to the page options. */
export type MediaAdminOptions = MediaAdminPageOptions;

/**
 * Create the media admin plugin. The returned descriptor is inert until the
 * admin plugin invokes its `register` during assembly.
 */
export function mediaAdmin(options: MediaAdminOptions): AdminPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('mediaAdmin requires an options object');
  }
  if (
    options.library === null ||
    typeof options.library !== 'object' ||
    typeof options.library.upload !== 'function'
  ) {
    throw new TypeError('mediaAdmin requires a media library');
  }
  if (options.previewLimitBytes !== undefined && !isNonNegativeInteger(options.previewLimitBytes)) {
    throw new TypeError('previewLimitBytes must be a non-negative integer');
  }
  const page = defineMediaAdminPage(options);

  return defineAdminPlugin({
    id: 'media',
    register(builder) {
      builder.addPage(page);
    },
  });
}
