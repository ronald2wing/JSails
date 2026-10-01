/**
 * Input, clock, and id guards shared by every {@link BlogRepository}
 * implementation, so the in-memory and database-backed repositories reject the
 * same inputs with the same value-free {@link BlogContentError}s.
 */

import type { z } from 'zod';

import { BlogContentError } from './repository.js';

/** Maximum id length, matching the model's `idSchema` bound. */
const MAX_ID_LENGTH = 190;

/** Clocks a repository stamps ids and timestamps from. */
export interface RepositoryClock {
  /** Produce and validate a non-empty id from the injected generator. */
  readonly makeId: () => string;
  /** Stamp the current instant as an ISO string from the injected clock. */
  readonly stamp: () => string;
}

/** Wrap the injected `nextId`/`now` options in validating {@link RepositoryClock} functions. */
export function createRepositoryClock(nextId: () => string, now: () => Date): RepositoryClock {
  return {
    makeId() {
      const id = nextId();
      if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
        throw new BlogContentError('invalid_input', 'nextId must return a non-empty string id');
      }
      return id;
    },
    stamp() {
      const value = now();
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new BlogContentError('invalid_input', 'now must return a valid Date');
      }
      return value.toISOString();
    },
  };
}

/** Reject a non-object input with a value-free `invalid_input`. */
export function assertInputObject(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BlogContentError('invalid_input', `${label} input must be an object`);
  }
}

/** Validate and decode an entity against its schema, failing value-free. */
export function parseEntity<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BlogContentError('invalid_input', `invalid ${label}`);
  }
  return result.data;
}

/** Reject a create-time `archived` status (archiving is a later layer's transition). */
export function assertCreatableStatus(status: unknown): void {
  if (status === 'archived') {
    throw new BlogContentError('invalid_status', 'cannot create an archived entry');
  }
}

/** The `not_found` error for a missing entity of the given collection. */
export function notFound(label: string): BlogContentError {
  return new BlogContentError('not_found', `${label} not found`);
}

/** The value-free `slug_conflict` error; it never echoes the duplicated slug. */
export function slugConflict(): BlogContentError {
  return new BlogContentError('slug_conflict', 'slug is already in use');
}

/** The `invalid_status` error for a publish/unpublish transition on an archived entry. */
export function archivedTransition(transition: 'publish' | 'unpublish'): BlogContentError {
  return new BlogContentError('invalid_status', `cannot ${transition} an archived entry`);
}
