/**
 * Pages subpath (`jsails/pages`): compiled page loading, Preact server
 * rendering to a page outcome, the `reply` helpers a page's `load` answers
 * with, static site generation, the page renderer seam, and the first-party
 * `pages` plugin.
 *
 * This barrel owns the complete render surface so a consumer can import
 * everything from one subpath without the root entry.
 */

export {
  documentOutcome,
  loadLayoutModule,
  loadPageModule,
  renderRoute,
  preactPageRenderer,
  PageRenderError,
} from './page.js';

export {
  reply,
  ReplyErrors,
  type CookieInit,
  type LoadResult,
  type NotFoundReply,
  type PageProps,
  type PagePropsOf,
  type PageReply,
  type PropsReply,
  type RedirectReply,
  type ReplyPropsOptions,
  type ReplyRedirectOptions,
  type ReplyRedirectStatus,
} from './reply.js';

export {
  createNotFoundErrorPage,
  matchNotFoundPage,
  type NotFoundErrorPageOptions,
} from './not-found.js';

export { pageCacheKey, type PageCacheKeyOptions } from './page-cache.js';

export {
  revalidatePath,
  revalidateTag,
  recordPageCacheKey,
  type RevalidatePathOptions,
  type RevalidationContext,
} from './revalidate.js';

export {
  generateStaticSite,
  StaticSiteError,
  type GenerateStaticSiteOptions,
  type GenerateStaticSiteResult,
} from './static-site/index.js';

export { SERVER_ONLY, type Component } from '../contracts/component.js';

export type {
  LayoutModule,
  LayoutProps,
  PageComponent,
  PageDocumentBody,
  PageModule,
  PageOutcome,
  PageRenderer,
  PageRenderOptions,
  PageStream,
} from '../contracts/render.js';

export { pagesPlugin, pageRendererToken, staticSiteToken } from './plugin.js';

export { pagesPlugin as default } from './plugin.js';
