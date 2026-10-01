/**
 * Bounds for the client component controller.
 *
 * Every numeric limit the controller enforces (snapshot token/payload size,
 * response body sizes, arg key count, queue depth) lives here, together with
 * the structural equality the dirty-diff uses. The JSON value scanner and its
 * depth bound are shared with the server (`wire/json-scan.ts`).
 */

import { isPlainObject } from '../../json/shape.js';

/** Maximum accepted snapshot token length (base64url payload + signature). */
export const MAX_SNAPSHOT_TOKEN_LENGTH: number = 512 * 1024;
/** Maximum accepted decoded snapshot payload size, in bytes. */
export const MAX_SNAPSHOT_PAYLOAD_BYTES: number = 384 * 1024;
/** Maximum accepted update response body size, in characters. */
export const MAX_RESPONSE_BODY_LENGTH: number = 2 * 1024 * 1024;
/** Maximum accepted upload response body size, in characters. */
export const MAX_UPLOAD_RESPONSE_BODY_LENGTH: number = 64 * 1024;
/** Maximum number of keys accepted in an action args object. */
export const MAX_ARGS_KEYS = 1000;
/** Default bound on the number of queued (not yet dispatched) actions. */
export const DEFAULT_MAX_QUEUE = 8;

/** Structural JSON equality (no cycles; inputs are validated JSON values). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key) || !jsonEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}
