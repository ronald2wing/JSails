/**
 * Typed content collections: {@link defineContentCollection} layers schema
 * validation, ordering, filtering, and static paths over one discovered
 * directory tree.
 */

import type { z } from 'zod';

import { formatIssuePath, mapZodIssues } from 'jsails/plugin-sdk';

import { buildCollection, discoverContent } from './discovery.js';
import { ContentError } from './errors.js';
import type { ContentCollectionDescriptor, ContentPage, EntryFilter } from './model.js';

// ---------------------------------------------------------------------------
// defineContentCollection
// ---------------------------------------------------------------------------

/** Options for {@link defineContentCollection}. */
export interface DefineContentCollectionOptions<
  Schema extends z.ZodObject<z.ZodRawShape> | undefined = undefined,
> {
  /** Content directory, resolved against the process working directory. */
  readonly dir: string;
  /**
   * Route pattern whose single `[param]` token names the static-path key.
   * Defaults to `'[slug]'` (each static path is `{ slug: string }`).
   */
  readonly route?: string;
  /**
   * Optional Zod object schema for the frontmatter. When provided it validates
   * every entry's frontmatter (malformed → {@link ContentError} with
   * `.errors`) and types each page's `data` as `z.infer<Schema>`. When absent
   * only `title` is required and `data` is `Record<string, unknown>`.
   */
  readonly schema?: Schema;
  /**
   * Optional sort comparator, overriding the default `order` → `title` → `slug`
   * sort. `prevNext` and `getStaticPaths` follow the resulting order.
   */
  readonly order?: (a: ContentPage, b: ContentPage) => number;
  /**
   * Directory for the incremental on-disk cache, forwarded to
   * {@link discoverContent}. Defaults to `.content-cache` in the process
   * working directory.
   */
  readonly cacheDir?: string;
}

/** The `data` type of a collection: `z.infer<Schema>`, or raw frontmatter. */
type ContentData<Schema> =
  Schema extends z.ZodObject<z.ZodRawShape> ? z.infer<Schema> : Record<string, unknown>;

/**
 * Define a typed content collection from one directory tree.
 *
 * `discoverContent` is memoized per directory, so the O(N) render pass runs once
 * per process; this descriptor then validates frontmatter against `schema` (if
 * given) and layers the derived helpers on top.
 */
export function defineContentCollection<
  Schema extends z.ZodObject<z.ZodRawShape> | undefined = undefined,
>(
  options: DefineContentCollectionOptions<Schema>,
): Promise<ContentCollectionDescriptor<ContentData<Schema>>> {
  return buildDescriptor(options);
}

async function buildDescriptor<Schema extends z.ZodObject<z.ZodRawShape> | undefined>(
  options: DefineContentCollectionOptions<Schema>,
): Promise<ContentCollectionDescriptor<ContentData<Schema>>> {
  const collection = await discoverContent(options.dir, { cacheDir: options.cacheDir });

  if (options.schema !== undefined) {
    for (const page of collection.pages) {
      const result = options.schema.safeParse(page.data);
      if (!result.success) {
        throw new ContentError(
          'invalid_frontmatter',
          `Invalid frontmatter in "${page.slug}"`,
          mapZodIssues(result.error).map(({ path, message }) => ({
            field: formatIssuePath(path),
            message,
          })),
        );
      }
    }
  }

  const ordered =
    options.order !== undefined
      ? buildCollection([...collection.pages].sort(options.order))
      : collection;

  // Schema validation above proves every page's `data` conforms to `Schema`, so
  // the widening to the typed `ContentPage<Data>` is safe.
  const pages = ordered.pages as unknown as readonly ContentPage<ContentData<Schema>>[];
  const bySlug = ordered.bySlug as unknown as ReadonlyMap<string, ContentPage<ContentData<Schema>>>;
  const paramName = deriveParamName(options.route);

  const descriptor: ContentCollectionDescriptor<ContentData<Schema>> = {
    pages,
    search: ordered.search,
    getEntry(slug: string) {
      return bySlug.get(slug);
    },
    getEntries(filter?: EntryFilter) {
      return filterPages(pages, filter);
    },
    getStaticPaths() {
      return buildStaticPaths(pages, paramName);
    },
    prevNext(slug: string) {
      return ordered.prevNext.get(slug);
    },
  };

  return Object.freeze(descriptor);
}

// ---------------------------------------------------------------------------
// createMarkdownStaticPaths
// ---------------------------------------------------------------------------

/**
 * One-line `getStaticPaths` for a content-backed page module.
 *
 * ```ts
 * export function getStaticPaths() {
 *   return createMarkdownStaticPaths(await collection);
 * }
 * ```
 */
export function createMarkdownStaticPaths(
  collection: ContentCollectionDescriptor,
): readonly { slug: string }[] {
  return collection.getStaticPaths();
}

function deriveParamName(route: string | undefined): string {
  const match = (route ?? '[slug]').match(/\[([A-Za-z0-9_-]+)\]/);
  return match?.[1] ?? 'slug';
}

function buildStaticPaths<Data>(
  pages: readonly ContentPage<Data>[],
  paramName: string,
): { slug: string }[] {
  const paths: { slug: string }[] = [];
  for (const page of pages) {
    if (page.draft) continue;
    // The key is the route's `[param]` name (default `slug`).
    paths.push({ [paramName]: page.slug } as { slug: string });
  }
  return paths;
}

function filterPages<Data>(
  pages: readonly ContentPage<Data>[],
  filter?: EntryFilter,
): readonly ContentPage<Data>[] {
  if (filter === undefined) return pages;
  return pages.filter((page) => {
    if (filter.tag !== undefined && !page.tags.includes(filter.tag)) return false;
    if (filter.section !== undefined && page.section !== filter.section) return false;
    if (filter.draft !== undefined && page.draft !== filter.draft) return false;
    return true;
  });
}
