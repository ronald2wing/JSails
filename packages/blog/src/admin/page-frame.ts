/**
 * Conventions every blog admin page shares: the navigation group, the
 * post-redirect notice, the action path under the panel, form-value coercion,
 * and the author id a session's writes are attributed to.
 */

import type { AdminPageAuthorize } from '@jsails/admin';
import type { Session } from 'jsails';

import type { BlogRepository } from '../cms/index.js';
import { BLOG_HTTP_AUTHOR_ID } from '../plugin.js';

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
  /**
   * Who may use the page, checked after the panel's own `authorize`; exact
   * `true` allows. Without it the page is served to no one: the panel gate
   * admits a session to the panel, not to every page in it.
   */
  readonly authorize?: AdminPageAuthorize;
}

/** The `authorize` entry to spread into a page definition, or nothing. */
export function pageAuthorize(authorize: AdminPageAuthorize | undefined): {
  readonly authorize?: AdminPageAuthorize;
} {
  return authorize === undefined ? {} : { authorize };
}

/** The page's own path (`<base>/<slug>`) under a panel base path. */
export function blogPagePath(base: string, slug: string): string {
  return base === '' || base === '/' ? `/${slug}` : `${base}/${slug}`;
}

/** Coerce a form value into a trimmed string (non-strings become ''). */
export function formString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The longest author id the model accepts. */
const MAX_AUTHOR_ID_LENGTH = 190;

/**
 * The signed-in user's id from an admin session (`session.data.user.id`, the
 * shape the auth plugin resolves), so a write and its revision record who made
 * them. A session without one falls back to {@link BLOG_HTTP_AUTHOR_ID}.
 */
export function sessionAuthorId(session: Session): string {
  const user = session.data['user'];
  if (user !== null && typeof user === 'object' && !Array.isArray(user)) {
    const id = user['id'];
    if (typeof id === 'string' && id !== '' && id.length <= MAX_AUTHOR_ID_LENGTH) return id;
  }
  return BLOG_HTTP_AUTHOR_ID;
}
