/**
 * Starter blog detail page (static-export / SSG surface).
 *
 * Resolves one published post by its slug from the shared CMS repository, or
 * renders a "not found" state when the repository is absent or the slug is
 * unknown. The live interactive surface is the blog plugin's routes; this
 * page is the SSG counterpart, reachable live at `/blog/:slug` during `serve`
 * (the plugin only shadows `/blog`, not the detail route).
 */

import type { RequestContext } from 'jsails';
import { renderRichText } from '@jsails/editor/server';
import { Str } from 'jsails/support';
import { renderThemeTemplate } from '@jsails/theme';
import { blogRepositoryToken, type BlogPost } from '@jsails/blog';

import { loadLayout, type LayoutAssets } from '../../ui/layout.js';
import { loadTheme, loadThemeCss, renderThemeChrome } from '../../server/theme.js';

export interface BlogPostPageProps {
  /** The resolved post, or `null` when absent (renders a "not found" state). */
  post: BlogPost | null;
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The post body rendered by the allowlisted rich-text renderer. */
  html?: string;
  /** Pre-rendered theme header/footer. */
  themeHeader?: string;
  themeFooter?: string;
  /** Rendered single/error layout, when the active theme provides one. */
  themeHtml?: string;
}

/**
 * The static export enumerates detail pages here. The shared repository is
 * database-backed, and the build has no request context and must not open a
 * database connection, so no detail pages are generated; a deployment that
 * wants SSG detail pages could seed a repository the build is allowed to read
 * and enumerate its slugs here instead.
 */
export function getStaticPaths(): Array<Record<string, string>> {
  return [];
}

/** Look up the post named by `context.params.slug`, or `null`. */
async function findPost(context: RequestContext): Promise<BlogPost | null> {
  // Static export has no request context and must not open a database
  // connection, so it never queries the repository.
  if (context.renderMode === 'static') {
    return null;
  }
  const repository = context.services?.tryGet(blogRepositoryToken);
  if (repository === undefined) {
    return null;
  }
  const slug = context.params.slug;
  if (slug === undefined || slug === '') {
    return null;
  }
  const post = await repository.getPostBySlug(slug);
  return post?.status === 'published' ? post : null;
}

export async function load(context: RequestContext): Promise<BlogPostPageProps> {
  const assets = loadLayout(context);
  const [post, themeCss, theme] = await Promise.all([
    findPost(context),
    loadThemeCss(context),
    loadTheme(context),
  ]);
  const body = post === null ? undefined : renderRichText(post.blocks);
  const chrome = renderThemeChrome(theme);
  const layout = post === null ? theme.layouts.blogError : theme.layouts.blogSingle;
  const themeHtml =
    layout === undefined
      ? undefined
      : post === null
        ? renderThemeTemplate(layout, { message: 'Post not found.' })
        : renderThemeTemplate(layout, {
            title: Str.escapeHtml(post.title),
            meta: Str.escapeHtml(post.publishedAt ?? post.updatedAt),
            body: body ?? '',
            back: 'Back to blog',
          });
  return {
    post,
    assets: { ...assets, themeCss },
    ...(chrome.header === undefined ? {} : { themeHeader: chrome.header }),
    ...(chrome.footer === undefined ? {} : { themeFooter: chrome.footer }),
    ...(post === null ? {} : { html: body }),
    ...(themeHtml === undefined ? {} : { themeHtml }),
  };
}

export default function BlogPostPage({
  post,
  assets,
  html,
  themeHeader,
  themeFooter,
  themeHtml,
}: BlogPostPageProps) {
  return (
    <UiLayout
      title="Post — JSails Starter"
      assets={assets}
      themeHeader={themeHeader}
      themeFooter={themeFooter}
    >
      {themeHtml !== undefined ? (
        <div dangerouslySetInnerHTML={{ __html: themeHtml }} />
      ) : post === null ? (
        <p class="text-base-content/70">Post not found.</p>
      ) : (
        <article class="w-full space-y-4">
          <header>
            <h1 class="text-4xl font-bold tracking-tight">{post.title}</h1>
          </header>
          <div class="prose" dangerouslySetInnerHTML={{ __html: html ?? '' }} />
          <footer class="text-sm text-base-content/60">
            <a class="link" href="/blog">
              Back to blog
            </a>
          </footer>
        </article>
      )}
    </UiLayout>
  );
}
