/**
 * Conventions every blog admin page shares: the navigation group, the
 * post-redirect notice, the action path under the panel, and form-value
 * coercion.
 */

import type { BlogRepository } from '../cms/index.js';

/** Navigation group for every blog admin page. */
export const BLOG_PAGE_GROUP = 'Content';

/** The `?notice=` value a page redirects with after a successful save. */
export const SAVED_NOTICE = 'saved';

/** Options shared by the repository-backed blog admin page factories. */
export interface BlogAdminPageOptions {
  /** The repository the page reads and writes. */
  readonly repository: BlogRepository;
  /** The panel base path the page posts back under. Defaults to `context.path`. */
  readonly path?: string;
}

/** The page's own path (`<base>/<slug>`) under a panel base path. */
export function blogPagePath(base: string, slug: string): string {
  return base === '' || base === '/' ? `/${slug}` : `${base}/${slug}`;
}

/** Coerce a form value into a trimmed string (non-strings become ''). */
export function formString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
