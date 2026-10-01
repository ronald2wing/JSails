/**
 * `state.json` v1: which release of an app is live on its server, and which
 * one a rollback returns to.
 *
 * ```json
 * { "v": 1, "seq": 7, "live": "20261123101500-0123456789ab",
 *   "previous": "20261122093000-ba9876543210",
 *   "updatedAt": "2026-11-23T10:16:02.000Z", "by": "ana@laptop" }
 * ```
 *
 * The file states intent, not truth: the proxy's target is what serves, and
 * `reconcile.ts` rewrites this file to match it before a release. It is
 * written only under the deploy lock, by compare-and-replace
 * (`writeRemoteFile` with `expect` set to the SHA-256 of the bytes the run
 * observed), and `seq` is the lock sequence number of the run that wrote it.
 * There is no status field: a release that is neither live nor previous and
 * runs no container is dead, which `observe` derives.
 *
 * {@link encodeHostState} writes the keys in one order with a trailing
 * newline, so equal states are equal bytes; {@link parseHostState} accepts
 * exactly that shape and throws a value-free `jamal_host_state.invalid`
 * otherwise.
 */

import { CONTROL_CHARS } from 'jsails/support';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import { isPlainObject } from '../object-shape.js';
import { isReleaseId } from './release-id.js';

const HOST_STATE_ERRORS = {
  invalid: {
    kind: 'invalid',
    message: 'state.json is not a v1 host state document',
  },
} as const;

/** `jamal_host_state.*`: a `state.json` that is not a v1 document. */
export const HostStateErrors: ErrorRegistry<'jamal_host_state', typeof HOST_STATE_ERRORS> =
  defineErrors('jamal_host_state', HOST_STATE_ERRORS);

/** The one state format version. */
export const HOST_STATE_VERSION = 1;

/** An app's host state. */
export interface HostState {
  readonly v: typeof HOST_STATE_VERSION;
  /** The lock sequence number of the run that wrote it. */
  readonly seq: number;
  /** The release the app serves, or `null` before the first release. */
  readonly live: string | null;
  /** The release a rollback returns to, or `null`. */
  readonly previous: string | null;
  /** When it was written, as an ISO 8601 time. */
  readonly updatedAt: string;
  /** Who wrote it (`user@host`). */
  readonly by: string;
}

/** The longest `by` or `updatedAt` a document may carry. */
const MAX_TEXT = 256;

/** Whether `value` is a short single-line string. */
export function isRecordedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT &&
    !CONTROL_CHARS.test(value)
  );
}

/** Whether `value` is a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A release id or `null`. */
function isReleasePointer(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isReleaseId(value));
}

/** Check a candidate state, throwing `jamal_host_state.invalid` when it is not one. */
export function assertHostState(value: unknown): HostState {
  if (!isPlainObject(value)) throw new HostStateErrors.Error('invalid');
  const keys = Object.keys(value).sort().join(',');
  const { v, seq, live, previous, updatedAt, by } = value;
  if (
    keys !== 'by,live,previous,seq,updatedAt,v' ||
    v !== HOST_STATE_VERSION ||
    !isCount(seq) ||
    !isReleasePointer(live) ||
    !isReleasePointer(previous) ||
    (live !== null && live === previous) ||
    !isRecordedText(updatedAt) ||
    !isRecordedText(by)
  ) {
    throw new HostStateErrors.Error('invalid');
  }
  return { v: HOST_STATE_VERSION, seq, live, previous, updatedAt, by };
}

/** The bytes of `state`, keys in a fixed order, with a trailing newline. */
export function encodeHostState(state: HostState): Uint8Array {
  const checked = assertHostState(state);
  const ordered = {
    v: checked.v,
    seq: checked.seq,
    live: checked.live,
    previous: checked.previous,
    updatedAt: checked.updatedAt,
    by: checked.by,
  };
  return Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8');
}

/** Parse `state.json`'s bytes; throws `jamal_host_state.invalid` for anything but v1. */
export function parseHostState(bytes: Uint8Array): HostState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new HostStateErrors.Error('invalid');
  }
  return assertHostState(parsed);
}
