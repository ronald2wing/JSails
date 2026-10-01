/**
 * The publication contract: `definePublication` validates and freezes a named,
 * Zod-validated, authorization-gated query definition, and `assertPublicationShape`
 * rejects queries whose membership the live layer cannot track from projected rows.
 */

import { z } from 'zod';

import type { ModelQuery } from '../database/model-query.js';
import type { LiveRow } from './change-record.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { Awaitable } from '../contracts/awaitable.js';

/**
 * The publication contract: a named, Zod-validated, authorization-gated query
 * that is the only way live data crosses the wire (docs/design/live.md §4.2).
 *
 * A publication declares what a client may subscribe to and how its rows are
 * shaped. The client never sends mutations through the live channel and never
 * names a collection or a scope — only a registered publication name resolves.
 * The row shape is an allowlist too: a publication names its `fields` or
 * supplies a `project` function, so a column added to the table later (a
 * password hash, a token, an internal note) never reaches a browser by
 * default.
 * `authorize` is required by both the type and a runtime guard: a publication
 * without one cannot be constructed, matching the broadcast channel posture of
 * "allow only on an exact `true`".
 */

/** The identity of a connected user the authorization decision sees. */
export interface LiveUser {
  readonly id: string;
  readonly [claim: string]: unknown;
}

/** Transport-agnostic request metadata, for origin/IP-derived authorization. */
export interface LiveRequestInfo {
  readonly ip: string | null;
  readonly origin: string | null;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/** What `authorize` sees: the parsed params, the user, and the request. */
export interface PublicationAuthContext<TParams> {
  readonly params: TParams;
  readonly user: LiveUser | null;
  readonly request: LiveRequestInfo;
}

/** What `query` sees, adding an abort signal the service owns. */
export interface PublicationQueryContext<TParams> extends PublicationAuthContext<TParams> {
  readonly signal: AbortSignal;
}

/**
 * A column name of `TRow`. A query whose row type was not inferred is typed as
 * plain `object`, which has no keys; any string is accepted then, and the
 * subscribe-time column check still applies.
 */
export type PublicationField<TRow> = [keyof TRow] extends [never] ? string : keyof TRow & string;

/** The descriptor a publication is defined from. */
export interface PublicationDefinition<TParams, TRow extends object> {
  readonly name: string;
  /** Client-visible collection key. Stable across deploys. */
  readonly collection: string;
  readonly params: z.ZodType<TParams>;
  /** Must return exactly true. Any other value denies. */
  readonly authorize: (context: PublicationAuthContext<TParams>) => Awaitable<boolean>;
  readonly query: (context: PublicationQueryContext<TParams>) => ModelQuery<TRow>;
  /**
   * The scalar columns each subscriber receives, by property name. Must include
   * `id`, which the client keys rows by, and the entity's primary key must be
   * that single `id` column. Give this or `project`, not both.
   */
  readonly fields?: readonly PublicationField<TRow>[];
  /**
   * Shapes each row a subscriber receives, for a row that needs derived or
   * renamed values. The result's `id` must equal the row's primary key, as
   * the wire serializes it; a row that does not match is never sent. Give
   * this or `fields`, not both.
   */
  readonly project?: (row: TRow) => LiveRow;
  /** Per-publication row cap. Defaults to service maxRows. */
  readonly maxRows?: number;
}

/** Stable codes carried by a {@link PublicationDefinitionError}. */
export type PublicationDefinitionErrorCode =
  | 'missing_authorize'
  | 'missing_query'
  | 'invalid_name'
  | 'missing_projection'
  | 'invalid_fields'
  | 'invalid_projection';

/** Raised for a publication definition the live layer refuses to accept. Value-free. */
export class PublicationDefinitionError extends JsailsError {
  constructor(
    readonly code: PublicationDefinitionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Freeze a publication definition, enforcing the minimal runtime contract the
 * type alone cannot: `authorize` and `query` must be functions (so a
 * hand-written or `as`-cast object fails closed rather than denying or
 * throwing later), `name` must be a non-empty string (the registry keys on
 * it), and exactly one of `fields` or `project` must say what a subscriber
 * sees. `fields` must be distinct non-empty names including `id`; whether each
 * is a real column is checked when the entity is known, at subscribe time.
 * The result is frozen so a held reference cannot be mutated after the
 * service has read it.
 *
 * The guards exist because TypeScript checks evaporate at the JS boundary: a
 * publication without `authorize` would otherwise default-deny only by accident
 * of `authorize` returning `undefined`.
 */
export function definePublication<TParams, TRow extends object>(
  definition: PublicationDefinition<TParams, TRow>,
): PublicationDefinition<TParams, TRow> {
  if (typeof definition.authorize !== 'function') {
    throw new PublicationDefinitionError(
      'missing_authorize',
      'a publication requires an authorize function',
    );
  }
  if (typeof definition.query !== 'function') {
    throw new PublicationDefinitionError(
      'missing_query',
      'a publication requires a query function',
    );
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new PublicationDefinitionError('invalid_name', 'a publication requires a non-empty name');
  }
  const { fields, project } = definition;
  if ((fields === undefined) === (project === undefined)) {
    throw new PublicationDefinitionError(
      'missing_projection',
      'a publication requires exactly one of fields or project',
    );
  }
  if (project !== undefined && typeof project !== 'function') {
    throw new PublicationDefinitionError('missing_projection', 'project must be a function');
  }
  if (fields !== undefined) {
    assertFieldList(fields);
    return Object.freeze({ ...definition, fields: Object.freeze([...fields]) });
  }
  return Object.freeze({ ...definition });
}

/** `fields` must be distinct, non-empty strings and include the `id` the client keys on. */
function assertFieldList(fields: unknown): void {
  if (
    !Array.isArray(fields) ||
    !fields.every((field) => typeof field === 'string' && field.length > 0) ||
    new Set(fields).size !== fields.length ||
    !fields.includes('id')
  ) {
    throw new PublicationDefinitionError(
      'invalid_fields',
      'publication fields must be distinct column names including id',
    );
  }
}

/** Why a publication's query shape is rejected by the live layer. */
export type PublicationShapeErrorCode =
  | 'unsupported_limit'
  | 'unsupported_offset'
  | 'unsupported_relation_predicate'
  | 'unsupported_raw_apply';

/** Raised by {@link assertPublicationShape} for a shape the live layer refuses. Value-free. */
export class PublicationShapeError extends JsailsError {
  constructor(readonly code: PublicationShapeErrorCode) {
    super('publication shape is not supported by the live layer');
  }
}

/**
 * Reject a publication whose membership is not a pure function of its own
 * projected row (docs/design/live.md §4.2a).
 *
 * Reliability here is deliberately honest. `limit`/`offset` are detected
 * reliably: `ModelQuery.limit()`/`offset()` route to `builder.limit()`/`offset()`,
 * which set `expressionMap.limit`/`offset` — the raw QueryBuilder's separate
 * `take`/`skip` fields are a *different*, unused API surface, so a guard reading
 * `take`/`skip` would silently miss every `limit`/`offset`. Relation predicates
 * (`whereHas`/`has` compile to `EXISTS (...)` fragments in `expressionMap.wheres`)
 * and raw `apply` (the `#applied` flag read via `query.applied`) are detected
 * heuristically. A clock-derived predicate is **not** detectable at all — it
 * compiles to an ordinary `andWhere` fragment indistinguishable from a scalar
 * comparison — and is caught by review and docs, not this guard (§15.4).
 */
export function assertPublicationShape(query: ModelQuery<object>): void {
  const map = query.builder.expressionMap;
  if (map.limit !== undefined) {
    throw new PublicationShapeError('unsupported_limit');
  }
  if (map.offset !== undefined) {
    throw new PublicationShapeError('unsupported_offset');
  }
  if (map.wheres.some((clause) => containsExists(clause.condition))) {
    throw new PublicationShapeError('unsupported_relation_predicate');
  }
  if (query.applied) {
    throw new PublicationShapeError('unsupported_raw_apply');
  }
}

/** Scan a compiled WHERE fragment for an EXISTS subquery, recursing into brackets. */
function containsExists(condition: unknown): boolean {
  if (typeof condition === 'string') {
    return /EXISTS/i.test(condition);
  }
  if (Array.isArray(condition)) {
    return condition.some((entry) => containsExists(entry));
  }
  if (typeof condition === 'object' && condition !== null) {
    // A WhereWrappingOperator carries `condition`; a WherePredicateOperator does
    // not, and no EXISTS string appears anywhere but a string fragment.
    return Object.values(condition as Record<string, unknown>).some((value) =>
      containsExists(value),
    );
  }
  return false;
}
