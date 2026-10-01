/**
 * The `Url` namespace's error registry, `url.*`, kept apart from the query
 * helpers so a module that needs only a URL error (or the header builder in
 * `content-disposition.ts`) does not load the query-string parser.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { ArgumentErrorFactory } from '../validation/primitives.js';

const URL_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: '{operation}: expected a string',
    context: { operation: 'identifier' },
  },
  invalid_url: {
    kind: 'invalid',
    message: '{operation}: invalid URL',
    context: { operation: 'identifier' },
  },
  invalid_disposition: {
    kind: 'internal',
    message: 'Url.contentDisposition: type must be attachment or inline',
  },
} as const;

/**
 * The `Url` namespace's codes, `url.*`: input that does not parse as a URL
 * (`invalid`) and an argument of the wrong type (`internal`). None echoes the
 * input.
 *
 * @public
 */
export const UrlErrors: ErrorRegistry<'url', typeof URL_ERRORS> = defineErrors('url', URL_ERRORS);

/** The argument-error factory every `Url` operation passes to `assertString`. */
export const urlError: ArgumentErrorFactory<'expected_string'> = (problem, operation) =>
  new UrlErrors.Error(problem, { operation });
