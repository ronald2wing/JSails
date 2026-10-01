/**
 * DRF-inspired resource handlers: a thin HTTP layer over a store adapter plus
 * a serializer. `createResourceHandlers` produces method-keyed handlers with
 * the filesystem API worker signature `(request, context) => Response`, so a
 * Hono worker can dispatch `handlers.collection[request.method]` without
 * re-implementing validation, authorization, or pagination.
 *
 * ## Store contract and row scoping
 *
 * The store adapter is the ONLY place that knows how rows map to identities.
 * Every store method receives the `RequestContext`, so an adapter that scopes
 * rows to the caller filters in `count` and `list` (and, where relevant,
 * `get`). The handler never rewrites or augments a query; a store that returns
 * unscoped `list` results but a scoped `count` — or vice versa — produces
 * inconsistent pages, and leaking other callers' rows in `list` is the
 * adapter's bug, not something this layer can or does paper over. This module
 * deliberately does NOT infer row-level policies from the `authorize` callback
 * for list results: filtering a page after counting would desynchronize the
 * count, so list scoping is the store's responsibility, not the handler's.
 *
 * ## Authorization (default-deny, two-phase on detail)
 *
 * `authorize(context, action, resource?)` is REQUIRED and default-deny: the
 * request is allowed only when the callback resolves to exactly `true` — any
 * falsy or truthy non-boolean result, a throw, or a rejection denies.
 * Collection actions (`list`, `create`) run a single general check. Detail
 * actions run a general check first, fetch the object, then an object-level
 * check with the fetched record BEFORE the record is serialized, updated, or
 * deleted — so a denied detail request never touches `serialize`/`update`/
 * `remove`, and a denied collection request never touches the store at all.
 *
 * ## Statuses
 *
 * Handlers return 200 (list/retrieve/update), 201 (create), 204 (destroy),
 * 400 (validation, malformed JSON), 403 (authorization), 404 (missing id or
 * record), 413 (oversized body), and 500 (unexpected store/serializer errors,
 * message never leaked). Error bodies use the framework's JSON error envelope,
 * the same one `createApp` produces. 405 for unsupported methods (e.g. PUT) is
 * produced by the dispatch layer that maps `request.method` onto this shape,
 * not by these handlers.
 */

import { ValidationError } from './validation.js';
import type { Serializer } from './serialization.js';
import { paginate } from './pagination.js';
import type { PaginationOptions } from './pagination.js';
import { HttpError, type RequestContext } from '../contracts/http.js';
import { toErrorResponse } from './error-response.js';
import { readJsonBody } from './json-body.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** Actions a resource handler can authorize. Mirrors DRF's action names. */
export type ResourceAction = 'list' | 'create' | 'retrieve' | 'update' | 'delete';

/**
 * Authorization callback. REQUIRED and default-deny: the request is allowed
 * only when the callback returns (or resolves to) exactly `true` — any other
 * value, a throw, or a rejection denies. `resource` is present only on the
 * object-level check after a successful detail fetch.
 */
export interface ResourceAuthorize<TResource = unknown> {
  (context: RequestContext, action: ResourceAction, resource?: TResource): Awaitable<boolean>;
}

/**
 * Storage adapter. No ORM assumptions: any persistence can back it. Methods
 * receive the `RequestContext` so the adapter scopes queries to the caller —
 * `count` and `list` MUST agree on the scoped set or pages will be wrong.
 * `create`/`update` receive already-validated payloads.
 */
export interface ResourceStore<TRecord = unknown, TInput = unknown, TPartial = Partial<TInput>> {
  count(context: RequestContext): Promise<number>;
  list(offset: number, limit: number, context: RequestContext): Promise<TRecord[]>;
  get(id: string, context: RequestContext): Promise<TRecord | null>;
  create(data: TInput, context: RequestContext): Promise<TRecord>;
  update(id: string, data: TPartial, context: RequestContext): Promise<TRecord | null>;
  delete(id: string, context: RequestContext): Promise<void>;
}

/** A filesystem API worker handler: takes the request and its context. */
export type ResourceHandler = (request: Request, context: RequestContext) => Awaitable<Response>;

/** Collection-level handlers, keyed by HTTP method. */
export interface CollectionHandlers {
  readonly GET: ResourceHandler;
  readonly POST: ResourceHandler;
}

/** Detail-level handlers, keyed by HTTP method. */
export interface DetailHandlers {
  readonly GET: ResourceHandler;
  readonly PATCH: ResourceHandler;
  readonly DELETE: ResourceHandler;
}

/** The complete handler set produced by {@link createResourceHandlers}. */
export interface ResourceHandlers {
  readonly collection: CollectionHandlers;
  readonly detail: DetailHandlers;
}

/** Options for {@link createResourceHandlers}. */
export interface ResourceHandlersOptions<TInput, TOutput, TRecord> {
  /** Allowlists write input and read output; drives validation + rendering. */
  readonly serializer: Serializer<TInput, TOutput>;
  /** Persistence adapter; responsible for row scoping via the context. */
  readonly store: ResourceStore<TRecord, TInput, Partial<TInput>>;
  /** Required default-deny authorization callback; only exactly `true` allows. */
  readonly authorize: ResourceAuthorize<TRecord>;
  /** Route parameter holding the record id. Defaults to `"id"`. */
  readonly idParam?: string;
  /** Page size cap and default, forwarded to the pagination helper. */
  readonly pagination?: PaginationOptions;
  /**
   * Upper bound on the JSON request body, in bytes. Enforced before parsing so
   * an oversized body is never fully buffered. Defaults to 64 KiB; the app-level
   * HTTP server should enforce its own (separate) limit as the primary guard.
   */
  readonly maxJsonBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

/** Canonical pagination integers: plain base-10 digits only, no sign/format. */
const DIGITS = /^[0-9]+$/;

/**
 * Builds collection (`GET`/`POST`) and detail (`GET`/`PATCH`/`DELETE`)
 * handlers around a serializer, store, and authorization callback.
 */
export function createResourceHandlers<TInput, TOutput, TRecord>(
  options: ResourceHandlersOptions<TInput, TOutput, TRecord>,
): ResourceHandlers {
  const {
    serializer,
    store,
    authorize,
    idParam = 'id',
    pagination = {},
    maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  } = options;

  const collection: CollectionHandlers = {
    GET: guard(async (_request, context) => {
      await assertResourceAuthorized(authorize, context, 'list');
      const params = parsePaginationParams(context.url);
      const page = await paginate(
        {
          count: () => store.count(context),
          list: (offset, limit) => store.list(offset, limit, context),
        },
        params,
        pagination,
      );
      return jsonResponse(
        { ...page, results: page.results.map((record) => serializer.toRepresentation(record)) },
        200,
      );
    }),

    POST: guard(async (request, context) => {
      await assertResourceAuthorized(authorize, context, 'create');
      const body = await readJsonBody(request, { maxBytes: maxJsonBytes });
      const input = serializer.validate(body);
      const record = await store.create(input, context);
      return jsonResponse(serializer.toRepresentation(record), 201);
    }),
  };

  const detail: DetailHandlers = {
    GET: guard(async (_request, context) => {
      await assertResourceAuthorized(authorize, context, 'retrieve');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw notFound();
      }
      await assertResourceAuthorized(authorize, context, 'retrieve', record);
      return jsonResponse(serializer.toRepresentation(record), 200);
    }),

    PATCH: guard(async (request, context) => {
      await assertResourceAuthorized(authorize, context, 'update');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw notFound();
      }
      await assertResourceAuthorized(authorize, context, 'update', record);
      const body = await readJsonBody(request, { maxBytes: maxJsonBytes });
      const patch = serializer.validate(body, { partial: true });
      const updated = await store.update(id, patch, context);
      if (updated === null) {
        throw notFound();
      }
      return jsonResponse(serializer.toRepresentation(updated), 200);
    }),

    DELETE: guard(async (_request, context) => {
      await assertResourceAuthorized(authorize, context, 'delete');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw notFound();
      }
      await assertResourceAuthorized(authorize, context, 'delete', record);
      await store.delete(id, context);
      return new Response(null, { status: 204 });
    }),
  };

  return { collection, detail };
}

/** Wraps a handler so any thrown error maps to a safe HTTP response. */
function guard(
  handler: (request: Request, context: RequestContext) => Promise<Response>,
): ResourceHandler {
  return (request, context) => handler(request, context).catch(toErrorResponse);
}

function notFound(): HttpError {
  return new HttpError('not_found', 'Not Found', 404);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function assertResourceAuthorized<TRecord>(
  authorize: ResourceAuthorize<TRecord>,
  context: RequestContext,
  action: ResourceAction,
  resource?: TRecord,
): Promise<void> {
  let allowed: unknown;
  try {
    allowed = await authorize(context, action, resource);
  } catch {
    allowed = false;
  }
  if (allowed !== true) {
    throw new HttpError('forbidden', 'Forbidden', 403);
  }
}

function requireId(context: RequestContext, idParam: string): string {
  const id = context.params[idParam];
  if (id === undefined) {
    throw notFound();
  }
  return id;
}

/**
 * Parses `page`/`pageSize` from the query string as canonical positive
 * integers: digits only (so `Number()` can never smuggle `Infinity`, exponents,
 * hex, signs, or whitespace), bounded by `Number.isSafeInteger`. Absent values
 * are omitted so the pagination helper applies its defaults.
 */
function parsePaginationParams(url: URL): { page?: number; pageSize?: number } {
  const parsed: { page?: number; pageSize?: number } = {};
  for (const key of ['page', 'pageSize'] as const) {
    const raw = url.searchParams.get(key);
    if (raw === null) {
      continue;
    }
    if (!DIGITS.test(raw)) {
      throw invalidPagination(key);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidPagination(key);
    }
    parsed[key] = value;
  }
  return parsed;
}

function invalidPagination(key: 'page' | 'pageSize'): ValidationError {
  return new ValidationError([
    {
      path: [key],
      code: key === 'page' ? 'invalid_page' : 'invalid_page_size',
      message: `${key} must be a positive integer`,
    },
  ]);
}
