/**
 * Route and output-path planning, and bounded page rendering, for
 * {@link generateStaticSite}.
 *
 * Planning expands dynamic routes via `getStaticPaths`, maps each resolved
 * route to a contained output path, and registers every output in a shared
 * collision registry before anything is rendered, so a collision or contract
 * violation is reported without touching the disk. Rendering then runs with a
 * bounded number of pages in flight and hands each page to a writer as soon as
 * it is rendered, so the build never holds the whole site's HTML at once.
 */

import { sep } from 'node:path';

import { relativePathInside } from '../../support/path-containment.server.js';

import type { ServiceRegistry } from '../../extensions/services.js';
import { formatError } from '../../errors/inspect.js';
import {
  routeToOutputPath,
  substituteRouteParams,
  type RouteManifest,
  type RouteManifestEntry,
} from '../../routing/routes.js';
import type { AssetUrlResolver, RequestContext } from '../../contracts/http.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { PageMetadata } from '../../seo/metadata.js';
import type { RobotsOptions } from '../../seo/robots.js';
import { buildRobotsTxt } from '../../seo/robots.js';
import { buildSitemapXml, type SitemapEntry } from '../../seo/sitemap.js';
import { loadPageModule, resolvePageMetadata } from '../page.js';
import { JsailsError } from '../../errors/jsails-error.js';

/** Stable codes carried by a {@link StaticSiteError}. */
export type StaticSiteErrorCode =
  | 'invalid_base_url'
  | 'duplicate_output'
  | 'unsupported_entry'
  | 'invalid_static_paths'
  | 'invalid_render'
  | 'unsafe_path'
  | 'invalid_public_asset'
  | 'unsafe_output_dir';

/** Raised when a static build cannot be planned, validated, or committed safely. */
export class StaticSiteError extends JsailsError {
  constructor(
    readonly code: StaticSiteErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A page whose output path is planned and claimed, but not yet rendered. */
export interface PageTarget {
  readonly entry: RouteManifestEntry;
  /** Resolved route the page is rendered for (e.g. `/blog/hello`). */
  readonly route: string;
  readonly params: Record<string, string>;
  /** Contained, posix-separated output path. */
  readonly rel: string;
}

/** A rendered (and already written) page with the metadata the sitemap needs. */
export interface PlannedPage {
  /** Resolved route the page was rendered for (e.g. `/blog/hello`). */
  readonly route: string;
  readonly rel: string;
  /** Resolved page metadata, used to decide sitemap inclusion. */
  readonly metadata: PageMetadata;
}

/** A generated text file (sitemap/robots) mapped to its posix output path. */
export interface PlannedRawOutput {
  readonly rel: string;
  readonly contents: string;
}

/**
 * SEO options for the static exporter. `siteName`/`origin`/`defaults` mirror the
 * runtime subset attached to page contexts; `robots` drives `robots.txt`.
 */
export interface StaticSiteSeoOptions {
  readonly siteName?: string;
  readonly origin?: string;
  readonly defaults?: PageMetadata;
  readonly robots?: RobotsOptions;
}

const DEFAULT_BASE_URL = 'http://localhost';

/** Parse and validate `baseUrl`, defaulting to a local origin. */
export function resolveBaseUrl(baseUrl: string | undefined): URL {
  const raw = baseUrl ?? DEFAULT_BASE_URL;
  if (typeof raw !== 'string' || raw === '') {
    throw new StaticSiteError('invalid_base_url', 'baseUrl must be a non-empty string');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StaticSiteError('invalid_base_url', `baseUrl "${raw}" is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StaticSiteError('invalid_base_url', `baseUrl "${raw}" must use http or https`);
  }
  return url;
}

/**
 * Every claimed output path, plus every directory those paths imply.
 *
 * A file may neither repeat another output, sit at a directory another output
 * lives under, nor live under another output file. Keeping the implied
 * directories in their own map makes each check a lookup per path segment
 * instead of a scan of every earlier output.
 */
export class OutputRegistry {
  /** Output file path -> label of what claimed it. */
  readonly #files = new Map<string, string>();
  /** Implied directory -> first output file found under it. */
  readonly #dirs = new Map<string, string>();

  /** Number of claimed output files. */
  get size(): number {
    return this.#files.size;
  }

  /** Claim `rel` for `label`, or throw a `duplicate_output` error. */
  add(rel: string, label: string): void {
    const normalized = rel.split(sep).join('/');
    const existing = this.#files.get(normalized);
    if (existing !== undefined) {
      throw new StaticSiteError(
        'duplicate_output',
        `output collision: ${label} and ${existing} both resolve to "${normalized}"`,
      );
    }
    const descendant = this.#dirs.get(normalized);
    if (descendant !== undefined) {
      throw new StaticSiteError(
        'duplicate_output',
        `output collision: ${label} ("${normalized}") is a file conflicting with directory "${descendant}"`,
      );
    }
    const ancestors = ancestorDirs(normalized);
    for (const dir of ancestors) {
      if (this.#files.has(dir)) {
        throw new StaticSiteError(
          'duplicate_output',
          `output collision: ${label} ("${normalized}") is inside output file "${dir}"`,
        );
      }
    }
    this.#files.set(normalized, label);
    for (const dir of ancestors) {
      if (!this.#dirs.has(dir)) this.#dirs.set(dir, normalized);
    }
  }
}

/** Every proper ancestor directory of a posix path, shortest first. */
function ancestorDirs(path: string): string[] {
  const dirs: string[] = [];
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    dirs.push(path.slice(0, index));
  }
  return dirs;
}

/** Record one output path in `outputs`; see {@link OutputRegistry.add}. */
export function addOutput(outputs: OutputRegistry, rel: string, label: string): void {
  outputs.add(rel, label);
}

/**
 * Plan every page target in manifest order, expanding dynamic routes via
 * `getStaticPaths` and claiming each output path. Nothing is rendered.
 */
export async function planPageTargets(
  manifest: RouteManifest,
  outDir: string,
  skipped: string[],
  outputs: OutputRegistry,
): Promise<PageTarget[]> {
  const targets: PageTarget[] = [];

  for (const entry of manifest.entries) {
    if (entry.kind === 'api') {
      skipped.push(entry.route);
      continue;
    }
    if (entry.kind !== 'page') {
      throw new StaticSiteError(
        'unsupported_entry',
        `unsupported manifest entry kind "${String(entry.kind)}" for route "${entry.route}"`,
      );
    }

    if (!entry.dynamic) {
      const rel = outputRel(outDir, entry.route);
      addOutput(outputs, rel, `page "${entry.route}"`);
      targets.push({ entry, route: entry.route, params: {}, rel });
      continue;
    }

    const page = await loadPageModule(entry.file);
    if (page.getStaticPaths === undefined) {
      throw new StaticSiteError(
        'invalid_static_paths',
        `dynamic page "${entry.route}" must export getStaticPaths for static generation`,
      );
    }

    let records: unknown;
    try {
      records = await page.getStaticPaths();
    } catch (error) {
      throw new StaticSiteError(
        'invalid_static_paths',
        `getStaticPaths for "${entry.route}" failed: ${formatError(error)}`,
      );
    }
    if (!Array.isArray(records)) {
      throw new StaticSiteError(
        'invalid_static_paths',
        `getStaticPaths for "${entry.route}" must return an array`,
      );
    }

    for (const record of records) {
      const params = validateParamRecord(entry, record);
      const route = substituteRouteParams(entry, params);
      const rel = outputRel(outDir, route);
      addOutput(outputs, rel, `page "${route}"`);
      targets.push({ entry, route, params, rel });
    }
  }

  return targets;
}

/** The render environment shared by every page of one static build. */
export interface StaticRenderEnvironment {
  readonly baseUrl: URL;
  readonly renderer: PageRenderer;
  readonly services: ServiceRegistry | undefined;
  readonly assetUrl: AssetUrlResolver | undefined;
  readonly storagePath: string | undefined;
  readonly seo: StaticSiteSeoOptions | undefined;
}

/** Pages rendered at once when the caller does not choose a concurrency. */
export const DEFAULT_RENDER_CONCURRENCY = 8;

/**
 * Render every target with at most `concurrency` pages in flight, passing each
 * page's HTML to `write` as soon as it is rendered so no HTML is retained.
 * Results keep the targets' order. After the first failure no new page is
 * started; once the in-flight pages settle, the failure of the earliest target
 * is thrown, so the reported error does not depend on timing.
 */
export async function renderPages(
  targets: readonly PageTarget[],
  environment: StaticRenderEnvironment,
  concurrency: number,
  write: (target: PageTarget, html: string) => Promise<void>,
): Promise<PlannedPage[]> {
  const results = new Array<PlannedPage>(targets.length);
  const failures = new Map<number, unknown>();
  let next = 0;

  const worker = async (): Promise<void> => {
    while (failures.size === 0 && next < targets.length) {
      const index = next;
      next += 1;
      const target = targets[index]!;
      try {
        const { html, metadata } = await renderPage(target, environment);
        await write(target, html);
        results[index] = { route: target.route, rel: target.rel, metadata };
      } catch (error) {
        failures.set(index, error);
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  if (failures.size > 0) {
    throw failures.get(Math.min(...failures.keys()));
  }
  return results;
}

/** The output paths of the SEO files, claimed before any page is rendered. */
const SITEMAP_REL = 'sitemap.xml';
const ROBOTS_REL = 'robots.txt';

/**
 * Claim `sitemap.xml` and `robots.txt` when the caller opted into SEO, so a
 * page or asset already occupying either is a collision error rather than a
 * silent overwrite, raised before rendering starts.
 */
export function reserveSeoOutputs(
  seo: StaticSiteSeoOptions | undefined,
  outputs: OutputRegistry,
): void {
  if (seo === undefined) return;
  addOutput(outputs, SITEMAP_REL, 'sitemap');
  addOutput(outputs, ROBOTS_REL, 'robots');
}

/**
 * Build `sitemap.xml` and `robots.txt` for a static build whose outputs were
 * claimed by {@link reserveSeoOutputs}.
 *
 * Emitted only when the caller opted into SEO (`seo !== undefined`), so a build
 * that never configured SEO keeps its output set unchanged. Pages whose
 * effective robots directive (page metadata, else the SEO defaults) includes
 * `noindex` are excluded from the sitemap.
 */
export async function buildSeoOutputs(
  pages: readonly PlannedPage[],
  baseUrl: URL,
  seo: StaticSiteSeoOptions | undefined,
): Promise<PlannedRawOutput[]> {
  if (seo === undefined) {
    return [];
  }

  const entries: SitemapEntry[] = pages
    .filter((page) => !isNoindex(page.metadata, seo.defaults))
    .map((page) => ({ loc: new URL(page.route, baseUrl).href }));

  const sitemap = await buildSitemapXml(entries);
  const robots = buildRobotsTxt(seo.robots ?? {});

  return [
    { rel: SITEMAP_REL, contents: sitemap },
    { rel: ROBOTS_REL, contents: robots },
  ];
}

/** Whether a page's effective robots directive opts it out of the sitemap. */
function isNoindex(metadata: PageMetadata, defaults: PageMetadata | undefined): boolean {
  const robots = metadata.robots ?? defaults?.robots;
  return robots !== undefined && robots.includes('noindex');
}

/** Validate one `getStaticPaths` record against the entry's declared params. */
function validateParamRecord(entry: RouteManifestEntry, record: unknown): Record<string, string> {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new StaticSiteError(
      'invalid_static_paths',
      `getStaticPaths for "${entry.route}" must return plain parameter records`,
    );
  }
  const values = record as Record<string, unknown>;
  for (const name of entry.params) {
    if (!Object.hasOwn(values, name)) {
      throw new StaticSiteError(
        'invalid_static_paths',
        `getStaticPaths record for "${entry.route}" is missing parameter ":${name}"`,
      );
    }
    if (typeof values[name] !== 'string') {
      throw new StaticSiteError(
        'invalid_static_paths',
        `getStaticPaths parameter ":${name}" for "${entry.route}" must be a string`,
      );
    }
  }
  for (const key of Object.keys(values)) {
    if (!entry.params.includes(key)) {
      throw new StaticSiteError(
        'invalid_static_paths',
        `getStaticPaths record for "${entry.route}" has unexpected parameter "${key}"`,
      );
    }
  }
  return values as Record<string, string>;
}

/**
 * Build a GET context and render one resolved route to an HTML string.
 *
 * `services` is attached to the synthesized context only when the caller
 * supplied a registry; the build never starts one. The renderer is trusted
 * producer code, so its string is returned as-is, but a non-string result is
 * rejected here rather than written.
 *
 * The metadata for the sitemap comes from the renderer's `onMetadata` report,
 * so a page's `generateMetadata` runs once per page. Only a renderer that does
 * not report it makes the exporter resolve the metadata itself.
 */
async function renderPage(
  target: PageTarget,
  environment: StaticRenderEnvironment,
): Promise<{ readonly html: string; readonly metadata: PageMetadata }> {
  const { entry, route, params } = target;
  const { baseUrl, renderer, services, assetUrl, storagePath, seo } = environment;
  const url = new URL(route, baseUrl);
  const context: RequestContext = {
    request: new Request(url, { method: 'GET' }),
    url,
    params,
    session: null,
    renderMode: 'static',
    ...(services === undefined ? {} : { services }),
    ...(assetUrl === undefined ? {} : { assetUrl }),
    ...(storagePath === undefined ? {} : { storagePath }),
    ...(seo === undefined ? {} : { seo }),
  };
  let reported: PageMetadata | undefined;
  const html = await renderer.render(entry, context, {
    staticMode: true,
    onMetadata: (metadata) => {
      reported = metadata;
    },
  });
  if (typeof html !== 'string') {
    throw new StaticSiteError(
      'invalid_render',
      `renderer for route "${route}" must return an HTML string`,
    );
  }
  const metadata =
    reported ?? (await resolvePageMetadata(await loadPageModule(entry.file), context));
  return { html, metadata };
}

/** Map a resolved route to its contained, posix-separated output path. */
function outputRel(outDir: string, route: string): string {
  const target = routeToOutputPath(outDir, route);
  const rel = relativePathInside(outDir, target);
  if (rel === undefined || rel === '' || rel.includes('\0')) {
    throw new StaticSiteError(
      'unsafe_path',
      `route "${route}" does not map inside the output directory`,
    );
  }
  return rel.split(sep).join('/');
}
