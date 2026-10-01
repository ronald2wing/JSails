/**
 * First-party `pages` plugin: provides the default page renderer and static-site
 * generator under typed service tokens so the core pipeline can resolve them
 * from the registry after the plugins run.
 *
 * `pagesPlugin()` configures a plugin named `pages` on the `definePlugin`
 * contract. It takes no options. Setup provides {@link preactPageRenderer}
 * under {@link pageRendererToken} and {@link generateStaticSite} under
 * {@link staticSiteToken}; nothing is read from disk and nothing opens until
 * the renderer or generator is invoked, and there is no cleanup: the renderer
 * is stateless and the generator owns its own teardown.
 */

import type { PageRenderer } from '../contracts/render.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { definePlugin, type PluginFactory } from '../plugins/contract/define-plugin.js';
import { preactPageRenderer } from './page.js';
import { generateStaticSite } from './static-site/index.js';
import type { GenerateStaticSiteOptions, GenerateStaticSiteResult } from './static-site/index.js';

/**
 * Opaque token for the default {@link PageRenderer}. Defined once here and
 * shared by the provider (`pagesPlugin`) and the core pipeline (which resolves
 * it to render pages in `buildApp` and during static export in `build`).
 */
export const pageRendererToken: ServiceToken<PageRenderer> =
  createServiceToken<PageRenderer>('page-renderer');

/**
 * Opaque token for the static-site generator. Defined once here and shared
 * by the provider (`pagesPlugin`) and the core pipeline (which resolves it
 * to drive `Application.build`).
 */
export const staticSiteToken: ServiceToken<
  (options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>
> =
  createServiceToken<(options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>>(
    'static-site-generator',
  );

/**
 * The first-party `pages` plugin. Call it with no options.
 */
export const pagesPlugin: PluginFactory = definePlugin({
  name: 'pages',
  provides: [pageRendererToken, staticSiteToken],
  setup({ services }) {
    services.provide(pageRendererToken, preactPageRenderer);
    services.provide(staticSiteToken, generateStaticSite);
  },
});
