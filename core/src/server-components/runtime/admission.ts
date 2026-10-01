/**
 * Admission control for the server-component lanes: the lane list, the one
 * validated limits schema, the concurrency slots, and the per-address limiter
 * seam.
 *
 * Every request the component transport serves belongs to one lane: `update`
 * (an action or client edit), `refresh` (a `$refresh` poll, kept apart so a
 * page full of polling components cannot starve user actions), `upload`, and
 * `download`. Each lane has its own {@link LaneLimits}: how many requests it
 * runs at once across the runtime and for one principal, the total time a
 * request may take, and how long a streamed body may go without progress.
 *
 * A principal is the verified credential's subject tag when it has one, and
 * otherwise the client's address bucket, so an anonymous visitor is bounded
 * per network rather than sharing one slot pool with every other visitor.
 *
 * Limits are validated once, when the runtime is built, and frozen; every
 * failure is a value-free `component_limits.*` error naming the lane and the
 * field, never the offending value.
 */

import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import { isPlainObject } from '../../json/shape.js';
import type { ClientAddress } from '../../security/request-origin.js';

/**
 * Every lane the component transport serves, in a fixed order.
 *
 * @public
 */
export const LANES: readonly ['update', 'refresh', 'upload', 'download'] = Object.freeze([
  'update',
  'refresh',
  'upload',
  'download',
] as const);

/**
 * One lane of the component transport.
 *
 * @public
 */
export type Lane = (typeof LANES)[number];

/**
 * The limits one lane runs under.
 *
 * @public
 */
export interface LaneLimits {
  /** Requests the lane runs at once across the runtime. */
  readonly maxConcurrent: number;
  /** Requests the lane runs at once for one principal (subject, or client bucket). */
  readonly maxConcurrentPerPrincipal: number;
  /**
   * Milliseconds a request may take from arrival to its last response byte.
   * Past it the request is answered `timeout` (or its stream is cut), and its
   * slot stays taken until the handler actually settles.
   */
  readonly totalMs: number;
  /** Milliseconds a streamed request or response body may go without a chunk. */
  readonly idleMs: number;
}

/**
 * Validated limits for every lane.
 *
 * @public
 */
export type RuntimeLimits = { readonly [L in Lane]: LaneLimits };

/**
 * Limits as an author writes them: any lane, any field, the rest defaulted.
 *
 * @public
 */
export type RuntimeLimitsInput = { readonly [L in Lane]?: Partial<LaneLimits> };

const LANE_LIMIT_FIELDS = [
  'maxConcurrent',
  'maxConcurrentPerPrincipal',
  'totalMs',
  'idleMs',
] as const satisfies readonly (keyof LaneLimits)[];

const COMPONENT_LIMITS_ERRORS = {
  invalid_limits: {
    kind: 'invalid',
    message: 'server components limits must be an object keyed by lane',
  },
  unknown_lane: {
    kind: 'invalid',
    message: 'server components limits name a lane that does not exist',
    suggestion: 'use one of the lanes update, refresh, upload, download',
  },
  invalid_lane: {
    kind: 'invalid',
    message: 'server components limits for lane {lane} must be an object',
    context: { lane: ['update', 'refresh', 'upload', 'download'] },
  },
  unknown_field: {
    kind: 'invalid',
    message: 'server components limits for lane {lane} name an unknown field',
    context: { lane: ['update', 'refresh', 'upload', 'download'] },
    suggestion: 'use maxConcurrent, maxConcurrentPerPrincipal, totalMs, or idleMs',
  },
  invalid_value: {
    kind: 'invalid',
    message: 'server components limit {field} for lane {lane} must be a positive integer',
    context: {
      lane: ['update', 'refresh', 'upload', 'download'],
      field: ['maxConcurrent', 'maxConcurrentPerPrincipal', 'totalMs', 'idleMs'],
    },
  },
  principal_over_total: {
    kind: 'invalid',
    message:
      'server components limit maxConcurrentPerPrincipal for lane {lane} exceeds its maxConcurrent',
    context: { lane: ['update', 'refresh', 'upload', 'download'] },
  },
} as const;

/**
 * The limits schema's codes, `component_limits.*`.
 *
 * @public
 */
export const ComponentLimitsErrors: ErrorRegistry<
  'component_limits',
  typeof COMPONENT_LIMITS_ERRORS
> = defineErrors('component_limits', COMPONENT_LIMITS_ERRORS);

function freezeLimits(limits: RuntimeLimits): RuntimeLimits {
  for (const lane of LANES) {
    Object.freeze(limits[lane]);
  }
  return Object.freeze(limits);
}

/**
 * The limits a lane runs under when the author sets none.
 *
 * @public
 */
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = freezeLimits({
  update: { maxConcurrent: 64, maxConcurrentPerPrincipal: 4, totalMs: 30_000, idleMs: 10_000 },
  refresh: { maxConcurrent: 64, maxConcurrentPerPrincipal: 4, totalMs: 15_000, idleMs: 10_000 },
  upload: { maxConcurrent: 16, maxConcurrentPerPrincipal: 2, totalMs: 300_000, idleMs: 30_000 },
  download: { maxConcurrent: 32, maxConcurrentPerPrincipal: 4, totalMs: 600_000, idleMs: 30_000 },
});

function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

function isField(value: string): value is keyof LaneLimits {
  return (LANE_LIMIT_FIELDS as readonly string[]).includes(value);
}

/**
 * Validate author limits over {@link DEFAULT_RUNTIME_LIMITS}, returning frozen
 * limits for every lane. Throws a value-free `component_limits.*` error for an
 * unknown lane or field, a non-positive or non-integer value, or an explicit
 * per-principal cap above the lane's total. A default per-principal cap above
 * a lowered total is narrowed to it.
 */
export function resolveRuntimeLimits(input: unknown): RuntimeLimits {
  if (input === undefined) {
    return DEFAULT_RUNTIME_LIMITS;
  }
  if (!isPlainObject(input)) {
    throw new ComponentLimitsErrors.Error('invalid_limits');
  }
  const resolved = Object.fromEntries(
    LANES.map((lane) => [lane, { ...DEFAULT_RUNTIME_LIMITS[lane] }]),
  ) as { [L in Lane]: { -readonly [F in keyof LaneLimits]: number } };
  const explicitPerPrincipal = new Set<Lane>();
  for (const [lane, overrides] of Object.entries(input)) {
    if (!isLane(lane)) {
      throw new ComponentLimitsErrors.Error('unknown_lane');
    }
    if (overrides === undefined) {
      continue;
    }
    if (!isPlainObject(overrides)) {
      throw new ComponentLimitsErrors.Error('invalid_lane', { lane });
    }
    for (const [field, value] of Object.entries(overrides)) {
      if (!isField(field)) {
        throw new ComponentLimitsErrors.Error('unknown_field', { lane });
      }
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new ComponentLimitsErrors.Error('invalid_value', { lane, field });
      }
      resolved[lane][field] = value;
      if (field === 'maxConcurrentPerPrincipal') {
        explicitPerPrincipal.add(lane);
      }
    }
  }
  for (const lane of LANES) {
    const limits = resolved[lane];
    if (limits.maxConcurrentPerPrincipal <= limits.maxConcurrent) {
      continue;
    }
    // A lowered lane total narrows the default per-principal cap with it; only
    // a per-principal cap the author set above the total is a contradiction.
    if (explicitPerPrincipal.has(lane)) {
      throw new ComponentLimitsErrors.Error('principal_over_total', { lane });
    }
    limits.maxConcurrentPerPrincipal = limits.maxConcurrent;
  }
  return freezeLimits(resolved);
}

/** A held concurrency slot. `release` is idempotent. */
export interface AdmissionSlot {
  release(): void;
}

/** The runtime's concurrency slots, one pool per lane plus one per principal. */
export interface Admission {
  /** Take a slot for `principal` on `lane`, or `undefined` when either cap is reached. */
  acquire(lane: Lane, principal: string): AdmissionSlot | undefined;
  /** Slots currently held on `lane`. */
  inFlight(lane: Lane): number;
}

/** Create the slot pools for `limits`. */
export function createAdmission(limits: RuntimeLimits): Admission {
  const held = new Map<Lane, number>(LANES.map((lane) => [lane, 0]));
  const heldBy = new Map<string, number>();
  return Object.freeze({
    acquire(lane: Lane, principal: string): AdmissionSlot | undefined {
      const laneLimits = limits[lane];
      const key = `${lane}\u0000${principal}`;
      const total = held.get(lane) ?? 0;
      const own = heldBy.get(key) ?? 0;
      if (total >= laneLimits.maxConcurrent || own >= laneLimits.maxConcurrentPerPrincipal) {
        return undefined;
      }
      held.set(lane, total + 1);
      heldBy.set(key, own + 1);
      let released = false;
      return Object.freeze({
        release(): void {
          if (released) {
            return;
          }
          released = true;
          held.set(lane, (held.get(lane) ?? 1) - 1);
          const remaining = (heldBy.get(key) ?? 1) - 1;
          if (remaining <= 0) {
            heldBy.delete(key);
          } else {
            heldBy.set(key, remaining);
          }
        },
      });
    },
    inFlight(lane: Lane): number {
      return held.get(lane) ?? 0;
    },
  });
}

/**
 * The principal a request's slot is counted against: its verified subject tag,
 * or its client's address bucket when the credential is anonymous. A request
 * with no resolved client shares the one `unknown` bucket.
 */
export function principalOf(subject: string | null, client: ClientAddress | undefined): string {
  return subject === null ? `client:${client?.bucket ?? 'unknown'}` : `subject:${subject}`;
}

/**
 * The per-address rate limiter a component lane consults before it reads the
 * request. Returning `false` answers `rate_limited` without reading the body.
 *
 * @public
 */
export interface AddressLimiter {
  admit(client: ClientAddress | undefined, lane: Lane): boolean;
}

/**
 * The limiter a runtime uses when none is supplied: it admits every address,
 * leaving the concurrency slots and deadlines as the lanes' only bounds.
 *
 * @public
 */
export const UNLIMITED_ADDRESSES: AddressLimiter = Object.freeze({
  admit: () => true,
});
