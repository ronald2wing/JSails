/**
 * Load-more demo page.
 *
 * Renders the `load-more` island with its seed serialized into
 * `data-jsails-props`, plus the same component as the SSR fallback so the
 * static export ships usable markup before hydration. The island is pure
 * client state: no `load`, no server, no database.
 *
 * Imports are explicit because this starter does not autoload lowercase `ui/`
 * modules; `SITE_TITLE` and `loadLayout` come from the layout module directly.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';

import { PageHeader } from '../ui/components.js';
import { Layout, SITE_TITLE, loadLayout, type LayoutAssets } from '../ui/layout.js';
import { LoadMore, SEED } from '../ui/load-more.js';

/** Head metadata for the demo page. */
export const metadata: PageMetadata = {
  title: `Load more — ${SITE_TITLE}`,
  description: 'A pure client island that paginates an inline seed with the unified pager recipe.',
  canonical: '/load-more',
};

export interface LoadMorePageProps {
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<LoadMorePageProps> {
  return { assets: await loadLayout(context) };
}

export default function LoadMorePage({ assets }: LoadMorePageProps) {
  return (
    <Layout assets={assets}>
      <PageHeader
        title="Load more"
        description="A pure client island: no server, no database. It paginates an inline seed with the same pager and intersection markers a server component uses."
      />
      <div data-jsails-island="load-more" data-jsails-props={JSON.stringify({ seed: SEED })}>
        <LoadMore seed={SEED} />
      </div>
    </Layout>
  );
}
