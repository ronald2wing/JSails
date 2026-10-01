/**
 * Public static-file middleware for the app runtime.
 *
 * `createPublicFilesMiddleware(publicDir)` returns a Hono middleware that
 * serves files under an explicit developer-owned public directory. It is meant
 * to be registered AFTER the filesystem API/page routes so it can never shadow
 * a protected handler: a route that already answered short-circuits the chain,
 * and anything the middleware does not serve falls through via `next()` to the
 * app's existing 404.
 *
 * File I/O is delegated to the maintained `@hono/node-server/serve-static`
 * adapter; this module owns only the security gate in front of it. It never
 * sets MIME types or streams bodies itself.
 *
 * Lifecycle:
 * - Returns `undefined` when `publicDir` does not exist (an app without a
 *   public directory is valid), so callers can skip registration.
 * - Throws a value-free error when `publicDir` exists but is a symlink or is
 *   not a directory.
 *
 * Request gate (GET/HEAD only; every other method calls `next()`):
 * - The request path is decoded exactly once from Hono's path and then
 *   rejected when it contains a NUL, control characters, a backslash, a
 *   malformed percent sequence, a residual percent escape (double encoding),
 *   an interior empty segment, or any dot-prefixed (hidden) segment.
 * - Every ancestor segment and the final candidate are `lstat`-checked and
 *   symlinks are rejected, including a directory's `index.html`. A resolved
 *   `realpath` containment check is a second barrier against escaping the root.
 * - A directory request serves its `index.html`; a missing file, missing index,
 *   or failed check falls through to the app 404. Responses carry
 *   `X-Content-Type-Options: nosniff` plus the maintained adapter's content
 *   type. No filesystem path, error text, or directory listing is exposed.
 * - Client-supplied `x-forwarded-*` headers are never consulted.
 *
 * Caching: a public file is cacheable by definition, so the response carries
 * `Cache-Control: public` and a weak `ETag` derived from the file's size and
 * mtime (the stat is already in hand from the gate). A content-addressed URL
 * (`?v=<hash>`, see `asset-urls.ts`) is immutable for a year; any other URL
 * must revalidate on every use. A matching `If-None-Match` is answered with a
 * 304 right here, before the adapter opens the file: an opened read stream
 * that a later layer discarded unread would hold its descriptor open, and a
 * flood of revalidations would exhaust them.
 *
 * Precompressed variants: when the client accepts it and a sibling
 * `<file>.br` (preferred) or `<file>.gz` exists, that sibling is served with
 * `Content-Encoding` and the original file's content type, so a build step can
 * compress assets once instead of the server gzipping them on every request.
 * A sibling passes the same symlink and containment checks as the file itself,
 * a sibling older than the file is ignored as stale, and every response for a file that has a sibling carries
 * `Vary: Accept-Encoding`. Range requests always get the identity file.
 */

import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isPathInside } from '../support/path-containment.server.js';

import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';
import { getMimeType } from 'hono/utils/mime';

import { acceptQuality } from '../server/content-negotiation.js';

import { isErrno } from '../errors/inspect.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Resolved root-relative file path, keyed per request context. */
const servedPaths = new WeakMap<Context, string>();

/** A path that cleared decoding and segment validation. */
interface SafePath {
  /** Slash-joined decoded segments, no leading or trailing slash. */
  readonly relative: string;
  /** Whether the request path ended in `/` (directory request). */
  readonly directory: boolean;
}

/**
 * Build the public static-file middleware for `publicDir`, or `undefined` when
 * the directory does not exist. Never reads a request body, opens a network
 * connection, or trusts forwarding headers.
 */
/** Stable failure code carried by {@link PublicFilesError}. */
export type PublicFilesErrorCode = 'invalid_directory' | 'io_failed';

/** Raised when the public directory cannot be used as a static-file root. Value-free. */
export class PublicFilesError extends JsailsError {
  constructor(
    readonly code: PublicFilesErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export async function createPublicFilesMiddleware(
  publicDir: string,
): Promise<MiddlewareHandler | undefined> {
  if (typeof publicDir !== 'string' || publicDir === '') {
    throw new TypeError('createPublicFilesMiddleware requires a non-empty public directory path');
  }

  let rootStat: Stats;
  try {
    rootStat = await lstat(publicDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw new PublicFilesError('io_failed', 'public directory could not be inspected', {
      cause: error,
    });
  }
  if (rootStat.isSymbolicLink()) {
    throw new PublicFilesError('invalid_directory', 'public directory must not be a symbolic link');
  }
  if (!rootStat.isDirectory()) {
    throw new PublicFilesError('invalid_directory', 'public directory must be a directory');
  }

  let root: string;
  try {
    root = await realpath(publicDir);
  } catch (error) {
    throw new PublicFilesError('io_failed', 'public directory could not be resolved', {
      cause: error,
    });
  }

  // The adapter receives only paths this module has already validated; the
  // decoded argument it computes itself is ignored. `allowPercentInPath` stops
  // it rejecting a literal `%` our own decoder accepted.
  const serve = serveStatic({
    root,
    allowPercentInPath: true,
    rewriteRequestPath: (_decodedPath, context) => servedPaths.get(context) ?? '\u0000missing',
  });

  const middleware: MiddlewareHandler = async (context, next) => {
    const method = context.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();

    const safe = decodeRequestPath(context.req.path);
    if (safe === undefined) return next();

    const candidate = await resolveExistingFile(root, safe);
    if (candidate === undefined) return next();

    const variants =
      context.req.header('range') === undefined
        ? await findEncodedVariants(root, candidate)
        : NO_VARIANTS;
    const chosen = chooseVariant(variants, context.req.header('accept-encoding'));
    const served = chosen ?? candidate;
    const etag = fileEtag(served.stat, chosen?.encoding);
    const cacheControl =
      context.req.query('v') !== undefined
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate';
    const vary = variants.length > 0 ? 'Accept-Encoding' : undefined;

    if (etagMatches(context.req.header('if-none-match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          'cache-control': cacheControl,
          'x-content-type-options': 'nosniff',
          ...(vary === undefined ? {} : { vary }),
        },
      });
    }

    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Cache-Control', cacheControl);
    context.header('ETag', etag);
    if (vary !== undefined) context.header('Vary', vary);
    servedPaths.set(context, served.relative);
    const response = await serve(context, next);
    if (chosen !== undefined && response instanceof Response) {
      // The adapter typed the response from the `.br`/`.gz` name; the client
      // must see the original type plus the encoding it was sent in.
      response.headers.set(
        'Content-Type',
        getMimeType(candidate.relative) ?? 'application/octet-stream',
      );
      response.headers.set('Content-Encoding', chosen.encoding);
    }
    return response;
  };

  return middleware;
}

/**
 * Decode the request path once and reject anything that must never reach the
 * filesystem. Returns the slash-joined segments plus trailing-slash intent, or
 * `undefined` when the path is malformed, hidden, or an escape attempt.
 */
function decodeRequestPath(rawPath: string): SafePath | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined; // malformed percent escape or invalid UTF-8
  }

  if (decoded === '' || decoded.charCodeAt(0) !== 47 /* '/' */) return undefined;
  if (decoded.includes('\u0000') || decoded.includes('\\')) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  // A single decode should have consumed every valid escape; any survivor means
  // the path was double encoded and its meaning is ambiguous.
  if (/%[0-9a-fA-F]{2}/.test(decoded)) return undefined;

  const segments = decoded.split('/');
  const relativeSegments: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment === '') {
      // A single trailing slash is allowed; interior empty segments are not.
      if (index === segments.length - 1) continue;
      return undefined;
    }
    if (segment.startsWith('.')) return undefined; // hidden, `.`, or `..`
    relativeSegments.push(segment);
  }

  return {
    relative: relativeSegments.join('/'),
    directory: decoded.endsWith('/'),
  };
}

/** A validated file to serve: its root-relative path and the stat the gate took. */
interface ServedFile {
  readonly relative: string;
  readonly stat: Stats;
}

/** A precompressed sibling of a served file. */
interface EncodedVariant extends ServedFile {
  readonly encoding: 'br' | 'gzip';
}

const NO_VARIANTS: readonly EncodedVariant[] = [];

/** Sibling suffixes in preference order: brotli compresses text assets best. */
const VARIANT_SUFFIXES = [
  ['br', '.br'],
  ['gzip', '.gz'],
] as const;

/**
 * Weak validator from size and mtime: cheap, and stable across processes. An
 * encoded variant gets its own validator so a cache never answers one
 * encoding's revalidation with another's bytes.
 */
function fileEtag(stat: Stats, encoding?: string): string {
  const suffix = encoding === undefined ? '' : `-${encoding}`;
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}${suffix}"`;
}

/** Weak `If-None-Match` comparison; `*` matches any current representation. */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const bare = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag.replace(/^W\//, '') === bare);
}

/** The precompressed siblings of `file` that pass the same checks as the file itself. */
async function findEncodedVariants(
  root: string,
  file: ServedFile,
): Promise<readonly EncodedVariant[]> {
  const found: EncodedVariant[] = [];
  for (const [encoding, suffix] of VARIANT_SUFFIXES) {
    const relative = `${file.relative}${suffix}`;
    const absolute = join(root, relative);
    let stat: Stats;
    try {
      stat = await lstat(absolute);
    } catch {
      continue; // no such sibling: the common case
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    // A sibling older than its source is stale (a deploy replaced the file
    // but not its compressed copy); serving it would give encoding-capable
    // clients the old bytes under a validator nothing ever invalidates.
    if (stat.mtimeMs < file.stat.mtimeMs) continue;
    if (await isInsideRoot(root, absolute)) found.push({ relative, stat, encoding });
  }
  return found;
}

/** The most preferred variant the client accepts (q > 0), brotli first. */
function chooseVariant(
  variants: readonly EncodedVariant[],
  acceptEncoding: string | undefined,
): EncodedVariant | undefined {
  return variants.find((variant) => acceptQuality(acceptEncoding, variant.encoding, ['*']) > 0);
}

/**
 * Resolve `safe` to a root-relative file path that exists, is not a symlink,
 * and stays inside `root`. Directories fall back to their `index.html`.
 */
async function resolveExistingFile(root: string, safe: SafePath): Promise<ServedFile | undefined> {
  const segments = safe.relative === '' ? [] : safe.relative.split('/');
  let current = root;
  let stat: Stats | undefined;

  for (const segment of segments) {
    current = join(current, segment);
    try {
      stat = await lstat(current);
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) return undefined;
  }

  if (stat === undefined) {
    // The request was for the root itself; it was validated as a real dir.
    stat = await lstat(root).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  }

  if (stat.isDirectory()) {
    const indexRelative = safe.relative === '' ? 'index.html' : `${safe.relative}/index.html`;
    const indexAbsolute = join(root, indexRelative);
    let indexStat: Stats;
    try {
      indexStat = await lstat(indexAbsolute);
      if (indexStat.isSymbolicLink() || !indexStat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    return (await isInsideRoot(root, indexAbsolute))
      ? { relative: indexRelative, stat: indexStat }
      : undefined;
  }

  if (safe.directory || !stat.isFile()) return undefined;
  return (await isInsideRoot(root, current)) ? { relative: safe.relative, stat } : undefined;
}

/** Defense-in-depth check that a real candidate never leaves the real root. */
async function isInsideRoot(root: string, candidate: string): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return false;
  }
  return isPathInside(root, resolved);
}
