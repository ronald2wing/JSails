import { z } from 'zod';

import type { ModelQuery } from '../database/model-query.js';
import type { LiveRow } from './change-record.js';

/**
 * The publication contract: a named, Zod-validated, authorization-gated query
 * that is the only way live data crosses the wire (LIVE-PLAN.md §4.2).
 *
 * A publication declares what a client may subscribe to and how its rows are
 * shaped. The client never sends mutations through the live channel and never
 * names a collection or a scope — only a registered publication name resolves.
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

/** The descriptor a publication is defined from. */
export interface PublicationDefinition<TParams, TRow extends object> {
  readonly name: string;
  /** Client-visible collection key. Stable across deploys. */
  readonly collection: string;
  readonly params: z.ZodType<TParams>;
  /** Must return exactly true. Any other value denies. */
  readonly authorize: (context: PublicationAuthContext<TParams>) => boolean | Promise<boolean>;
  readonly query: (context: PublicationQueryContext<TParams>) => ModelQuery<TRow>;
  /** Defaults to projectRow(entityClass, row). */
  readonly project?: (row: TRow) => LiveRow;
  /** Per-publication row cap. Defaults to service maxRows. */
  readonly maxRows?: number;
}

/** Raised for a publication definition the live layer refuses to accept. Value-free. */
export class PublicationDefinitionError extends Error {
  readonly code: 'missing_authorize' | 'missing_query' | 'invalid_name';

  constructor(code: 'missing_authorize' | 'missing_query' | 'invalid_name', message: string) {
    super(message);
    this.name = 'PublicationDefinitionError';
    this.code = code;
  }
}

/**
 * Freeze a publication definition, enforcing the minimal runtime contract the
 * type alone cannot: `authorize` and `query` must be functions (so a
 * hand-written or `as`-cast object fails closed rather than denying or
 * throwing later), and `name` must be a non-empty string (the registry keys on
 * it). The result is frozen so a held reference cannot be mutated after the
 * service has read it.
 *
 * The plan's §4.2 signature is `Object.freeze({ ...definition })`; the runtime
 * guards are the Phase 2 "missing authorize is rejected" test realized here
 * because TypeScript checks evaporate at the JS boundary and a publication
 * without `authorize` would otherwise default-deny only by accident of
 * `authorize` returning `undefined`.
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
  return Object.freeze({ ...definition });
}
