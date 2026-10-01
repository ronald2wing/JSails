/**
 * Build-time static site generation for compiled filesystem page routes.
 *
 * `generateStaticSite` renders every `page` manifest entry through the supplied
 * {@link PageRenderer} — the built-in Preact renderer by default, which shares
 * the HTTP layer's {@link renderRoute} path — and writes the result under
 * `outDir`; `api` entries are never rendered or imported and are reported as
 * skipped. Dynamic pages must export `getStaticPaths` returning exact string
 * parameter records — every output path is resolved (and collisions detected)
 * before anything is rendered or written. Pages then render with a bounded
 * number in flight (`concurrency`, default 8) and each is written into a
 * sibling staging directory as soon as it renders, so peak memory does not
 * grow with the site. Any failure discards the staging directory, leaving a
 * prior build untouched.
 *
 * Boundaries:
 * - Compiled `.js`/`.mjs` page modules only; TypeScript, bundling, JSX
 *   transforms, hydration, ISR, and server actions are out of scope. A supplied
 *   renderer may emit any HTML it likes, but dynamic-path discovery still
 *   requires a compiled module exporting `getStaticPaths`.
 * - No ORM, Valkey, or network service is initialized. Each page is rendered
 *   with a single in-memory GET context (`session: null`) built from `baseUrl`.
 * - `publicDir` contents are copied byte-for-byte with no compilation. Symlinks
 *   are rejected and dot-files (e.g. `.env`) are skipped, never copied.
 * - No existing component of `outDir` may be a symlink, except `root` (the
 *   project root; default the working directory) and its parents, which are
 *   the operator's filesystem layout.
 * - Writes go through a sibling staging directory. An existing non-empty
 *   `outDir` is only replaced when it carries the ownership marker written by a
 *   previous run; an unowned non-empty directory is refused, and a failed rename
 *   restores the original output instead of deleting arbitrary paths.
 *
 * A root `pages/not-found` module is rendered to `404.html`, the file static
 * hosts serve for an unmatched URL; it is listed last in `written` and kept
 * out of the sitemap.
 *
 * `written`/`copied` are absolute paths of files placed in the final `outDir`;
 * `skipped` holds the route strings of `api` entries.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ServiceRegistry } from '../../extensions/services.js';
import type { RouteManifest } from '../../routing/routes.js';
import type { AssetUrlResolver } from '../../contracts/http.js';
import type { PageRenderer } from '../../contracts/render.js';
import { preactPageRenderer } from '../page.js';
import { planAssets } from './public-assets.js';
import {
  buildSeoOutputs,
  DEFAULT_RENDER_CONCURRENCY,
  OutputRegistry,
  planNotFoundTarget,
  planPageTargets,
  renderNotFoundTarget,
  renderPages,
  reserveSeoOutputs,
  resolveBaseUrl,
  type PlannedRawOutput,
  type StaticSiteSeoOptions,
} from './plan.js';
import {
  assertNoSymlinkAncestors,
  assertOutDirSafety,
  commitStaging,
  copyStagedAssets,
  inspectOutput,
  writeStagedFile,
  writeStagingMarker,
} from './write.js';

export { StaticSiteError } from './plan.js';
export type { StaticSiteSeoOptions } from './plan.js';

/** Options for {@link generateStaticSite}. */
export interface GenerateStaticSiteOptions {
  /** Route manifest produced by `discoverRoutes`. */
  readonly manifest: RouteManifest;
  /** Output directory; created or replaced as an owned build target. */
  readonly outDir: string;
  /**
   * Trusted directory for the output symlink check, normally the project root.
   * It and its parents are the operator's filesystem layout and may be
   * symlinks (a symlinked home, macOS `/var`), also when `outDir` reaches them
   * through a different spelling of the same real directory; every other
   * existing component of `outDir`, below it or outside it, must not be.
   * Defaults to the working directory, which a relative `outDir` resolves
   * against; a caller writing outside its working directory (a temporary
   * directory) passes the directory it trusts.
   */
  readonly root?: string;
  /** Optional directory of static assets copied verbatim into `outDir`. */
  readonly publicDir?: string;
  /** Origin used to build each page's request URL. Must be `http(s)`. */
  readonly baseUrl?: string;
  /**
   * Renderer used for every page. Defaults to the built-in
   * {@link preactPageRenderer}. A custom renderer is trusted HTML producer
   * code: its returned string is written as-is, with no sanitization.
   */
  readonly renderer?: PageRenderer;
  /**
   * Read-only services exposed to the renderer through `context.services`.
   * Omitted means no registry is started and the field stays absent.
   */
  readonly services?: ServiceRegistry;
  /**
   * Resolver for public asset URLs, attached to each synthesized page context
   * so templates and server components can emit cache-busted asset URLs during
   * static generation. Omitted means the field stays absent and callers use
   * unversioned paths.
   */
  readonly assetUrl?: AssetUrlResolver;
  /**
   * Absolute persistent-storage directory, attached to each synthesized page
   * context as `storagePath`. Omitted means the field stays absent. The build
   * never creates the directory.
   */
  readonly storagePath?: string;
  /**
   * Opt-in SEO output. When provided, the build emits `sitemap.xml` and
   * `robots.txt` (pages whose effective robots directive includes `noindex` are
   * excluded from the sitemap) and attaches the runtime subset to each page
   * context so the renderer can inject `<head>` metadata. Omitted means no SEO
   * files are written and no metadata context is attached.
   */
  readonly seo?: StaticSiteSeoOptions;
  /**
   * Maximum number of pages rendered at once. Defaults to 8, which overlaps
   * pages whose `load()` waits on I/O; `1` renders strictly one page at a
   * time for pages that share mutable state. Output order and the reported
   * error do not depend on it.
   */
  readonly concurrency?: number;
}

/** Result of a static build. Paths in `written`/`copied`/`raw` are absolute. */
export interface GenerateStaticSiteResult {
  /** Rendered page files placed in `outDir`, in manifest order, then `404.html` if any. */
  readonly written: readonly string[];
  /** Copied public-asset files placed in `outDir`, in walk order. */
  readonly copied: readonly string[];
  /** Generated text files (`sitemap.xml`/`robots.txt`) placed in `outDir`. */
  readonly raw: readonly string[];
  /** Route strings of `api` entries, in manifest order. */
  readonly skipped: string[];
}

/**
 * Render and write a static site from a route manifest.
 *
 * Dynamic-path resolution, output-path validation, asset discovery, and
 * collision detection complete before the staging directory is created and
 * before any page renders. Rendering writes into staging, which is removed on
 * any failure, so a previously committed build is preserved unless the new
 * build fully succeeds.
 */
export async function generateStaticSite(
  options: GenerateStaticSiteOptions,
): Promise<GenerateStaticSiteResult> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('generateStaticSite requires an options object');
  }
  const { manifest } = options;
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new TypeError('generateStaticSite requires a manifest with an entries array');
  }
  if (typeof options.outDir !== 'string' || options.outDir === '') {
    throw new TypeError('outDir must be a non-empty string');
  }
  if (options.root !== undefined && (typeof options.root !== 'string' || options.root === '')) {
    throw new TypeError('root must be a non-empty string when provided');
  }
  if (
    options.publicDir !== undefined &&
    (typeof options.publicDir !== 'string' || options.publicDir === '')
  ) {
    throw new TypeError('publicDir must be a non-empty string when provided');
  }

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const outDir = resolve(options.outDir);
  const root = resolve(options.root ?? process.cwd());
  const publicDir = options.publicDir === undefined ? undefined : resolve(options.publicDir);
  const renderer = options.renderer ?? preactPageRenderer;
  if (typeof renderer.render !== 'function') {
    throw new TypeError('renderer must implement render(entry, context, options)');
  }
  const services = options.services;
  const assetUrl = options.assetUrl;
  const storagePath = options.storagePath;
  const seo = options.seo;
  const concurrency = options.concurrency ?? DEFAULT_RENDER_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }

  assertOutDirSafety(outDir, manifest, publicDir);
  assertNoSymlinkAncestors(outDir, root);
  const existed = inspectOutput(outDir);

  // Planning phase: every output is claimed before anything renders or is written.
  const outputs = new OutputRegistry();
  const skipped: string[] = [];
  const targets = await planPageTargets(manifest, outDir, skipped, outputs);
  const notFound = planNotFoundTarget(manifest, outputs);
  const assets = planAssets(publicDir, outDir, outputs);
  reserveSeoOutputs(seo, outputs);

  // Build phase: render into a sibling staging directory, then swap it into place.
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.jsails-site-'));
  let rawOutputs: PlannedRawOutput[];
  const written = targets.map((target) => target.rel);
  try {
    await writeStagingMarker(staging);
    const environment = { baseUrl, renderer, services, assetUrl, storagePath, seo };
    const pages = await renderPages(targets, environment, concurrency, (target, html) =>
      writeStagedFile(staging, target.rel, html),
    );
    if (notFound !== undefined) {
      written.push(
        await renderNotFoundTarget(notFound, environment, (rel, html) =>
          writeStagedFile(staging, rel, html),
        ),
      );
    }
    rawOutputs = await buildSeoOutputs(pages, baseUrl, seo);
    for (const output of rawOutputs) {
      await writeStagedFile(staging, output.rel, output.contents);
    }
    await copyStagedAssets(staging, assets);
    commitStaging(staging, outDir, existed);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    written: written.map((rel) => join(outDir, ...rel.split('/'))),
    copied: assets.map((asset) => join(outDir, ...asset.rel.split('/'))),
    raw: rawOutputs.map((output) => join(outDir, ...output.rel.split('/'))),
    skipped,
  };
}
