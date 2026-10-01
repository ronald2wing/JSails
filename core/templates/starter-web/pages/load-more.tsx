/**
 * Starter load-more page: the pagination recipe as a live server component.
 *
 * `load` renders the `load-more-feed` server component through the render
 * helper and passes the resulting VNode to the default page as a prop. The page
 * itself is a plain synchronous component: async work belongs in `load`, never
 * in a component body.
 *
 * The component owns its pager and sentinel markers; this page only supplies
 * the document shell and the surrounding copy.
 */

import type { VNode } from 'preact';

import type { RequestContext } from 'jsails';
import { renderServerComponent } from 'jsails/server-components';

import { loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface LoadMorePageProps {
  /** The rendered server component, produced in `load`. */
  feed: VNode;
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<LoadMorePageProps> {
  const [feed, assets] = await Promise.all([
    renderServerComponent('load-more-feed', context),
    loadLayout(context),
  ]);
  return { feed, assets, path: context.url.pathname };
}

export default function LoadMorePage({ feed, assets, path }: LoadMorePageProps) {
  return (
    <UiLayout title="Load more — JSails Starter" assets={assets} path={path}>
      <header class="flex flex-col gap-3">
        <span class="text-xs font-medium uppercase tracking-wider text-base-content/50">
          Server component
        </span>
        <h1 class="text-4xl font-bold tracking-tight">Load more</h1>
        <p class="max-w-2xl text-base-content/65">
          One pagination recipe: pager links for explicit pages and an intersection sentinel for the
          next one.
        </p>
      </header>

      <div class="mt-8">{feed}</div>

      <footer class="mt-10 text-center text-sm text-base-content/55">
        <p>
          Both controls call the same server component. The pager jumps to a page; the sentinel
          loads the next page once it enters the viewport.
        </p>
      </footer>
    </UiLayout>
  );
}
