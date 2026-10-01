/**
 * The execution context's codes, `context.*`: a key declared badly, a request
 * id that is not one, and a carrier that cannot be restored. Every message is
 * value-free: a carrier comes from a queue or another process, so neither its
 * text nor a decoded value ever reaches a message, only the field or the key
 * name at fault.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const CONTEXT_ERRORS = {
  invalid_key_name: {
    kind: 'internal',
    message: 'a context key name is 1 to 64 of a-z 0-9 . _ - starting with a letter',
  },
  key_conflict: {
    kind: 'internal',
    message: 'context key {key} is already declared with a different propagation',
    context: { key: 'identifier' },
    suggestion: 'Give each context key a unique, namespaced name',
  },
  invalid_request_id: {
    kind: 'internal',
    message: 'a request id is 1 to 255 of A-Z a-z 0-9 _ - =',
  },
  invalid_carrier: {
    kind: 'invalid',
    message: 'the execution context carrier has a malformed {field}',
    context: { field: ['shape', 'traceparent', 'requestId', 'values'] },
  },
  unsupported_carrier: {
    kind: 'invalid',
    message: 'the execution context carrier version is not supported by this process',
    suggestion: 'Finish the rolling deploy so every process reads the same carrier version',
  },
  invalid_value: {
    kind: 'invalid',
    message: 'context key {key} could not be decoded from the carrier',
    context: { key: 'identifier' },
  },
  unencodable_value: {
    kind: 'internal',
    message: 'the codec of context key {key} produced no carriable text',
    context: { key: 'identifier' },
  },
} as const;

/**
 * The execution context's codes, `context.*`. `ContextErrors.is(error)`
 * recognizes any of them, such as a job carrier that did not restore.
 *
 * @public
 */
export const ContextErrors: ErrorRegistry<'context', typeof CONTEXT_ERRORS> = defineErrors(
  'context',
  CONTEXT_ERRORS,
);
