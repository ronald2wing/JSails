/**
 * The request guards every admin route runs before a handler: resolve and
 * authorize the session, parse the form body into string fields and file
 * parts, and enforce the same-origin plus constant-time CSRF mutation check.
 *
 * Every guard fails closed: an unresolvable or unauthorized session is `null`,
 * an unparseable body is empty, and a mutation without a matching token is
 * refused. Forbidden prototype keys are dropped from every parsed body so a
 * hostile field name can never reach a schema or a record. A file input the
 * user left untouched submits an empty, unnamed part; it is dropped so it can
 * never stand in for an upload.
 *
 * The same-origin check compares the `Origin` header with the origin the
 * request was addressed to, as core resolved it (`c.var.origin`, from
 * `server.origin` and `server.hosts`; the same value core's own CSRF
 * middleware uses), so a panel behind a TLS-terminating proxy, where the
 * request URL is `http://`, still accepts its own `https://` form posts.
 */

import type { Context } from 'hono';
import type { Session } from 'jsails';
import {
  checkTrustedMutation,
  isForbiddenKey,
  isHeaderAuthenticatedSession,
  isRecord,
} from 'jsails/plugin-sdk';

import { reportAdminError } from './error-report.js';
import type { AdminPanel } from './panel.js';

/**
 * Resolve and authorize the admin session. Returns the session only when the
 * panel's `resolveSession` produced a browser (cookie) session and
 * `panel.authorize` resolved to exactly `true`; a null resolver result, a
 * header-authenticated session, a truthy non-boolean, a throw, or a rejection
 * all return `null`.
 *
 * A bearer or API-token session is refused before `authorize` runs: the panel
 * is a browser surface, and a token minted for the CLI or an integration must
 * never carry its holder's admin role into it, where the token would act with
 * none of the cookie's protections (an expiry that slides only with use, a
 * same-origin form, a CSRF token bound to a browser).
 */
export async function assertAdminSession(
  panel: AdminPanel,
  request: Request,
): Promise<Session | null> {
  const resolveSession = panel.resolveSession;
  // A panel built from `auth` (rather than a `resolveSession` callback) has no
  // resolver here; the admin plugin derives one during setup. Fail closed.
  if (typeof resolveSession !== 'function') {
    return null;
  }
  let session: Session | null;
  try {
    session = (await resolveSession(request)) ?? null;
  } catch (error) {
    reportAdminError(panel, error, { surface: 'session' });
    return null;
  }
  if (session === null || isHeaderAuthenticatedSession(session)) {
    return null;
  }
  try {
    if ((await panel.authorize(session)) !== true) {
      return null;
    }
  } catch (error) {
    reportAdminError(panel, error, { surface: 'authorize' });
    return null;
  }
  return session;
}

/**
 * Parse a urlencoded/multipart request body into string fields only. A body
 * that cannot be parsed (or carries non-string values) yields an empty map; the
 * dangerous `__proto__`/`constructor`/`prototype` keys are always dropped.
 */
export async function readFormBody(request: Request): Promise<Record<string, string>> {
  return (await readFormBodyAndFiles(request)).values;
}

/** A file part from a parsed multipart body (structure only, no global File type). */
export interface UploadedFilePart {
  /** The uploaded file's basename. */
  readonly name: string;
  /** The uploaded file's MIME type as the client declared it (may be empty). */
  readonly type: string;
  /** The uploaded file's size in bytes, when the parser knows it. */
  readonly size?: number;
  /** Read the file's bytes. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A parsed form body: the string fields plus any uploaded file parts. */
export interface ParsedFormBody {
  /** String-only field values, dangerous keys dropped. */
  readonly values: Record<string, string>;
  /** File parts keyed by field name; non-file values are never included. */
  readonly files: ReadonlyMap<string, UploadedFilePart>;
}

/**
 * Parse a urlencoded/multipart request body into string fields and file parts.
 * A body that cannot be parsed yields empty results; the dangerous
 * `__proto__`/`constructor`/`prototype` keys are always dropped.
 */
export async function readFormBodyAndFiles(request: Request): Promise<ParsedFormBody> {
  const contentType = request.headers.get('content-type') ?? '';

  let entries: IterableIterator<[string, unknown]>;
  try {
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const formData = await request.formData();
      entries = formData.entries();
    } else {
      entries = new URLSearchParams(await request.text()).entries();
    }
  } catch {
    return { values: {}, files: new Map() };
  }

  const values: Record<string, string> = {};
  const files = new Map<string, UploadedFilePart>();
  for (const [key, value] of entries) {
    if (isForbiddenKey(key)) {
      continue;
    }
    if (typeof value === 'string') {
      values[key] = value;
    } else if (isFilePart(value) && !isUntouchedFileInput(value)) {
      files.set(key, value);
    }
  }
  return { values, files };
}

/** Detect a File-like value by its `arrayBuffer` method (never `instanceof File`). */
function isFilePart(value: unknown): value is UploadedFilePart {
  return isRecord(value) && typeof value['arrayBuffer'] === 'function';
}

/**
 * A browser submits an untouched `<input type=file>` as a part with an empty
 * filename and no bytes. It carries no upload, so it is not a file part.
 */
function isUntouchedFileInput(part: UploadedFilePart): boolean {
  return part.name === '' && (part.size === undefined || part.size === 0);
}

/**
 * The trusted origin for the same-origin check: the origin core's first
 * pipeline stage resolved for this request (`c.var.origin`), or `undefined`
 * outside that pipeline, which compares against the request URL's own origin.
 */
export function adminTrustedOrigin(c: Context): string | undefined {
  const resolved: unknown = c.get('origin');
  if (!isRecord(resolved)) return undefined;
  const origin = resolved['origin'];
  return typeof origin === 'string' && origin !== '' ? origin : undefined;
}

/**
 * Enforce the panel's mutation guards: a same-origin `Origin` header (against
 * the request's resolved origin) and a submitted `_csrf` field
 * matching the session token (constant-time). Returns `true` only when both
 * hold.
 */
export function assertAdminMutation(
  c: Context,
  session: Session,
  body: Record<string, string>,
): boolean {
  const expectedOrigin = adminTrustedOrigin(c);
  return checkTrustedMutation(c.req.raw, session, {
    csrfValue: body['_csrf'],
    ...(expectedOrigin === undefined ? {} : { expectedOrigin }),
  }).allowed;
}
