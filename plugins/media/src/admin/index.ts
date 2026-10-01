/**
 * Media admin (`@jsails/media/admin`): a server-only admin surface for the
 * media library.
 *
 * `mediaAdmin(options)` returns an {@link AdminPlugin} (id `media`) that
 * contributes one page (slug `media`, label `Media`) rendering the upload /
 * search / edit / delete surface over a caller-supplied {@link MediaLibrary}.
 * The library is captured by closure and is never recreated, so an application
 * that also serves media bytes elsewhere must hand the same instance here and
 * there.
 *
 * The page default path is the admin panel path provided at render time
 * (`context.path`), so the plugin follows whatever base path the panel is
 * mounted on — the `path` option only overrides it.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';

import type { MediaLibrary } from '../library.js';
import { defineMediaPage } from './page.js';

/** Options for {@link mediaAdmin}. */
export interface MediaAdminOptions {
  /** The library to back the page; never recreated by the plugin. */
  readonly library: MediaLibrary;
  /**
   * Optional override for the page path. Defaults to the admin panel path the
   * panel itself supplies (`context.path`), so omitting it mounts the page under
   * the panel's own base (e.g. `/admin/media`).
   */
  readonly path?: string;
  /** Byte cap for inlined previews (default `DEFAULT_PREVIEW_LIMIT_BYTES`). */
  readonly previewLimitBytes?: number;
}

/**
 * Build the media admin plugin. The returned descriptor is inert until
 * {@link adminPlugin} invokes its `register` during assembly.
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
  if (
    options.previewLimitBytes !== undefined &&
    (typeof options.previewLimitBytes !== 'number' ||
      !Number.isInteger(options.previewLimitBytes) ||
      options.previewLimitBytes < 0)
  ) {
    throw new TypeError('previewLimitBytes must be a non-negative integer');
  }
  const source = {
    library: options.library,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.previewLimitBytes === undefined
      ? {}
      : { previewLimitBytes: options.previewLimitBytes }),
  };

  return defineAdminPlugin({
    id: 'media',
    register(builder) {
      builder.addPage(defineMediaPage(source));
    },
  });
}

export {
  DEFAULT_PREVIEW_LIMIT_BYTES,
  MAX_JSON_RESULTS,
  MEDIA_NOTICE_DELETED,
  MEDIA_NOTICE_UPLOADED,
  MEDIA_NOTICE_UPDATED,
  PREVIEW_IMAGE_TYPES,
} from './page.js';
