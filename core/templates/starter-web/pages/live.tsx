/**
 * Starter live page: a client island subscribed to a live publication.
 *
 * The page itself is static markup. The `live-posts` island hydrates in the
 * browser and opens the live subscription, so the server render is the empty
 * state and the list fills in once the snapshot arrives.
 *
 * This is the counterpart to `pages/tasks.tsx`: that page shows a server
 * component with a backend action, this one shows a client island fed by the
 * live layer. Neither polls.
 */

import type { RequestContext } from 'jsails';

import { loadLayout, type LayoutAssets } from '../ui/layout.js';
import { UiLivePosts } from '../ui/live-posts.js';

export interface LivePageProps {
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<LivePageProps> {
  const assets = await loadLayout(context);
  return { assets, path: context.url.pathname };
}

export default function LivePage({ assets, path }: LivePageProps) {
  return (
    <UiLayout title="Live — JSails Starter" assets={assets} path={path}>
      <header class="flex flex-col gap-3">
        <span class="text-xs font-medium uppercase tracking-wider text-base-content/50">
          Live layer
        </span>
        <h1 class="text-4xl font-bold tracking-tight">Live</h1>
        <p class="max-w-2xl text-base-content/65">
          A client island subscribed to a server-defined publication. The server decides which rows
          a subscriber may see; the client only renders them.
        </p>
      </header>

      <div class="mt-8 max-w-2xl">
        <div id="live-posts-root" data-jsails-island="live-posts">
          <UiLivePosts />
        </div>
      </div>

      <footer class="mt-10 text-center text-sm text-base-content/55">
        <p>
          Publishing a post updates this list without a reload. The connection resumes from the last
          sequence it applied, so a brief drop does not lose changes.
        </p>
      </footer>
    </UiLayout>
  );
}
