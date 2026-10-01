/**
 * The disk error codes, `disk.*`: every failure a {@link Disk} or one of its
 * helpers raises. Messages carry no key, path, bucket or byte of data; a
 * backend failure keeps the original error as `cause` for the operator.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

/**
 * The operation an `aborted`, `unsupported` or `io_failed` error names.
 *
 * @public
 */
export type DiskOperation = 'write' | 'read' | 'stat' | 'delete' | 'list' | 'sign' | 'open';

// Each `operation` enum is spelled out, not shared through a constant, so the
// registry's declaration can be emitted from this file alone (isolated
// declarations); `DiskOperation` above is the same list.
const DISK_ERRORS = {
  invalid_key: {
    kind: 'invalid',
    message: 'disk keys are relative paths of non-empty segments, without "." or ".."',
    suggestion: 'use forward slashes and safe segment names, for example "media/2026/logo.png"',
  },
  invalid_cursor: {
    kind: 'invalid',
    message: 'the list cursor was not issued by this disk',
  },
  invalid_range: {
    kind: 'invalid',
    message: 'the requested byte range is not satisfiable',
  },
  invalid_source: {
    kind: 'invalid',
    message: 'a write source yields Uint8Array chunks',
  },
  invalid_option: {
    kind: 'invalid',
    message: 'disk option {option} is invalid',
    context: { option: 'identifier' },
  },
  not_found: {
    kind: 'not_found',
    message: 'no object is stored under the key',
  },
  conflict: {
    kind: 'conflict',
    message: 'an object is already stored under the key',
  },
  key_collision: {
    kind: 'conflict',
    message: 'the key names a directory of other keys on this disk',
  },
  too_large: {
    kind: 'too_large',
    message: 'the object exceeds the byte limit',
  },
  aborted: {
    kind: 'aborted',
    message: 'the disk {operation} was aborted',
    context: { operation: ['write', 'read', 'stat', 'delete', 'list', 'sign', 'open'] },
  },
  source_failed: {
    kind: 'invalid',
    message: 'the write source failed before it ended',
  },
  unsupported: {
    kind: 'internal',
    message: 'this disk or its store does not support {operation}',
    context: { operation: ['write', 'read', 'stat', 'delete', 'list', 'sign', 'open'] },
  },
  io_failed: {
    kind: 'unavailable',
    message: 'the disk {operation} failed',
    context: { operation: ['write', 'read', 'stat', 'delete', 'list', 'sign', 'open'] },
  },
} as const;

/**
 * The disk registry. Recognize a code with `DiskErrors.is(error, 'not_found')`;
 * raise one with `new DiskErrors.Error('io_failed', { operation: 'write' }, { cause })`.
 *
 * @public
 */
export const DiskErrors: ErrorRegistry<'disk', typeof DISK_ERRORS> = defineErrors(
  'disk',
  DISK_ERRORS,
);
