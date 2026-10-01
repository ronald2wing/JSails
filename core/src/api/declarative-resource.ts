/**
 * Declarative resource DSL: thin composition over the existing resource
 * primitives (`defineSerializer`, `createResourceHandlers`,
 * `createResourceRouter`) so every API resource is a single object.
 *
 * ## Composition
 *
 * `defineDeclarativeResource(spec)`:
 * 1. Validates `name` (non-empty safe URL segment), `serializer` (a
 *    {@link SerializerFields} map), `store` (all six {@link ResourceStore}
 *    methods), and `authorize` (an {@link ResourceAuthorize} callback).
 * 2. Passes `spec.serializer` to {@link defineSerializer}.
 * 3. Passes `{ serializer, store, authorize }`, plus `filters`, `pagination`,
 *    and `maxJsonBytes` when given, to {@link createResourceHandlers}.
 * 4. Passes `{ prefix: '/', resources: { [name]: handlers } }` to
 *    {@link createResourceRouter}.
 * 5. Returns a frozen `{ name, serializer, handlers, routes, authorize }`.
 *
 * ## Authorization (default-deny)
 *
 * The returned `authorize` callback is the same one passed into
 * `createResourceHandlers`, which enforces default-deny: a request is allowed
 * only when `authorize` resolves to exactly `true`. The composed handlers
 * already carry this enforcement — callers that wire the handlers through a
 * Hono router without further authorization gates will apply it on every
 * request.
 *
 * ## Error model
 *
 * Every validation failure throws a value-free `DeclarativeResourceError`
 * whose message never echoes the invalid input. The underlying primitives
 * (`defineSerializer`, `createResourceHandlers`, `createResourceRouter`) may
 * also throw their own errors, which propagate unwrapped.
 */

import { defineSerializer } from './serialization.js';
import type { SerializerFields } from './serialization.js';
import type { FilterOptions } from './filters.js';
import type { PaginationOptions } from './pagination.js';
import { createResourceHandlers } from './resource.js';
import type { ResourceAuthorize, ResourceHandlers, ResourceStore } from './resource.js';
import { createResourceRouter } from './router.js';
import type { RouteEntry } from './router.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Stable codes carried by a {@link DeclarativeResourceError}. */
export type DeclarativeResourceErrorCode = 'invalid_spec';

/** Raised when the spec fails structural validation. Value-free: the message never echoes the invalid input. */
export class DeclarativeResourceError extends JsailsError {
  constructor(
    readonly code: DeclarativeResourceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The declarative one-file resource produced by {@link defineDeclarativeResource}. */
export interface DeclarativeResource {
  /** The resource slug / route segment. */
  readonly name: string;
  /** Serializer built from `spec.serializer`. */
  readonly serializer: ReturnType<typeof defineSerializer>;
  /** Collection and detail handlers. */
  readonly handlers: ResourceHandlers;
  /** Deterministic route manifest (five entries: two collection + three detail). */
  readonly routes: readonly RouteEntry[];
  /** The `authorize` callback passed through verbatim. */
  readonly authorize: ResourceAuthorize;
}

/** Options for {@link defineDeclarativeResource}. */
export interface DeclarativeResourceOptions {
  /** Resource slug / URL segment. Must be a non-empty safe segment (alphanumeric plus `_-`). */
  readonly name: string;
  /** Field map passed through to {@link defineSerializer}. */
  readonly serializer: SerializerFields;
  /** Persistence adapter implementing every {@link ResourceStore} method. */
  readonly store: ResourceStore;
  /** Required default-deny authorization callback. */
  readonly authorize: ResourceAuthorize;
  /** Searchable, sortable, and filterable fields; see `createResourceHandlers`. */
  readonly filters?: FilterOptions;
  /** Page size and offset caps. */
  readonly pagination?: PaginationOptions;
  /** Upper bound on a JSON request body, in bytes. */
  readonly maxJsonBytes?: number;
}

/** The store methods the composed handlers call. */
const STORE_METHODS = ['count', 'list', 'get', 'create', 'update', 'delete'] as const;

/** Safe URL segment: starts alphanumeric, then zero or more alphanumeric/`_-`. */
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Build a complete resource — serializer, handlers, route manifest, and
 * authorization — from one declarative spec.
 *
 * ```ts
 * const posts = defineDeclarativeResource({
 *   name: 'post',
 *   serializer: {
 *     id: { schema: integer(), readOnly: true },
 *     title: string(),
 *     body: optional(string()),
 *   },
 *   store,  // implements ResourceStore
 *   authorize: resourcePolicy({ list: require(isStaff) }),
 *   filters: { fields: { title: { filterable: false } } },
 * });
 * // posts.handlers.collection.GET  — Hono worker
 * // posts.routes                   — mountable route manifest
 * ```
 */
export function defineDeclarativeResource(
  options: DeclarativeResourceOptions,
): DeclarativeResource {
  const { name, serializer: fields, store, authorize, filters, pagination, maxJsonBytes } = options;

  // -- validate name ----------------------------------------------------------
  if (typeof name !== 'string' || !SEGMENT_RE.test(name)) {
    throw new DeclarativeResourceError(
      'invalid_spec',
      'Resource name must be a non-empty safe URL segment (alphanumeric + "-_")',
    );
  }

  // -- validate serializer fields ---------------------------------------------
  if (
    fields === undefined ||
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields)
  ) {
    throw new DeclarativeResourceError(
      'invalid_spec',
      'serializer must be a non-null object of field definitions',
    );
  }

  // -- validate store ---------------------------------------------------------
  if (
    store === undefined ||
    store === null ||
    typeof store !== 'object' ||
    STORE_METHODS.some(
      (method) => typeof (store as unknown as Record<string, unknown>)[method] !== 'function',
    )
  ) {
    throw new DeclarativeResourceError(
      'invalid_spec',
      'store must be a non-null object implementing ResourceStore',
    );
  }

  // -- validate authorize -----------------------------------------------------
  if (typeof authorize !== 'function') {
    throw new DeclarativeResourceError('invalid_spec', 'authorize must be a function');
  }

  // -- compose ----------------------------------------------------------------
  const serializer = defineSerializer(fields);
  const handlers = createResourceHandlers({
    serializer,
    store,
    authorize,
    ...(filters === undefined ? {} : { filters }),
    ...(pagination === undefined ? {} : { pagination }),
    ...(maxJsonBytes === undefined ? {} : { maxJsonBytes }),
  });
  const routes = createResourceRouter({
    prefix: '/',
    resources: { [name]: handlers },
  });

  return Object.freeze({ name, serializer, handlers, routes, authorize });
}
