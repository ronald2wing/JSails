/**
 * Blog admin integration (`@jsails/blog/admin`): the admin-panel surfaces for
 * the blog CMS.
 *
 * `blogAdmin` contributes the posts/pages/categories/tags resources plus the
 * menus and revisions pages; `blogThemeAdmin` contributes the theme
 * activation page. The page factories are exported for apps that compose their
 * own admin plugin. This subpath is the only one that imports `@jsails/admin`,
 * which is an optional peer: an app that does not run the admin panel never
 * loads it.
 */

export { blogAdmin, type BlogAdminOptions } from './resources.js';
export {
  blogThemeAdmin,
  defineBlogThemesAdminPage,
  THEME_ACTIVATED_NOTICE,
  type BlogThemeAdminOptions,
} from './themes-page.js';
export { defineBlogMenusAdminPage } from './menus-page.js';
export {
  defineBlogRevisionsAdminPage,
  type BlogRevisionsAdminPageOptions,
} from './revisions-page.js';
export { BLOG_DEFAULT_REVISION_LIMIT } from './content-resources.js';
export type { BlogAdminPageOptions } from './page-frame.js';
