/**
 * The admin session and form guards: resolve and authorize the session the
 * panel's routes admit, and parse a form body into string fields and file
 * parts.
 *
 * Every guard fails closed: an unresolvable or unauthorized session is
 * `null`, and an unparseable body is empty. Forbidden prototype keys are
 * dropped from every parsed body so a hostile field name can never reach a
 * schema or a record. A file input the user left untouched submits an empty,
 * unnamed part; it is dropped so it can never stand in for an upload.
 *
 * The panel's routes are registrar routes accepting the session cookie, so
 * core's access chain refuses an unsafe request from another origin, and
 * runs the routes' access (this session check) before any handler or body
 * byte; the session is resolved once per request and shared by the access
 * check and the handler.
 */

import type { Session } from 'jsails';
import { ValidationError } from 'jsails/api';
import { forbidden } from 'jsails/errors';
import type { RouteContext } from 'jsails/kernel';
import { isForbiddenKey, isHeaderAuthenticatedSession, isRecord } from 'jsails/plugin-sdk';

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
 * same-origin form).
 */
export function assertAdminSession(panel: AdminPanel, request: Request): Promise<Session | null> {
  let byRequest = resolvedSessions.get(panel);
  if (byRequest === undefined) {
    byRequest = new WeakMap();
    resolvedSessions.set(panel, byRequest);
  }
  let pending = byRequest.get(request);
  if (pending === undefined) {
    pending = resolveAdminSession(panel, request);
    byRequest.set(request, pending);
  }
  return pending;
}

/**
 * The session a panel route's access admitted: the access check resolved it
 * and this reads the same resolution. A route reached without one (only a
 * handler called outside its route) is refused with core's 403.
 */
export async function admittedSession(panel: AdminPanel, context: RouteContext): Promise<Session> {
  const session = await assertAdminSession(panel, context.request);
  if (session === null) throw forbidden();
  return session;
}

/**
 * The session each panel resolved for each request: a route's access check
 * and its handler share one resolution (both entries go with their objects).
 */
const resolvedSessions = new WeakMap<AdminPanel, WeakMap<Request, Promise<Session | null>>>();

/** Resolve and authorize the admin session of `request` (see {@link assertAdminSession}). */
async function resolveAdminSession(panel: AdminPanel, request: Request): Promise<Session | null> {
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
  return parsedEntries(entries);
}

/**
 * Read a route's form body (`ctx.body.form()`, bounded by the route's
 * declared body cap) into string fields and file parts. A body that is not a
 * form, or cannot be parsed, yields empty results; any other failure (a body
 * past the route's cap, answered 413) propagates, so the handler never acts
 * on a form it did not receive.
 */
export async function readRouteForm(context: RouteContext): Promise<ParsedFormBody> {
  let form: FormData;
  try {
    form = await context.body.form();
  } catch (error) {
    if (error instanceof ValidationError) return { values: {}, files: new Map() };
    throw error;
  }
  return parsedEntries(form.entries());
}

/** Form entries as string fields and file parts, dangerous keys and untouched file inputs dropped. */
function parsedEntries(entries: IterableIterator<[string, unknown]>): ParsedFormBody {
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
