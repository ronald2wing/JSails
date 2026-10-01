/**
 * The framework's one JSON request-body reader.
 *
 * Under `createApp` every body is read through the request's body budget,
 * which fails the read with `request.too_large` past the route's limit, so a
 * handler there may read without a limit of its own. A handler that can also
 * run outside `createApp` (the resource handlers) passes `maxBytes`, and the
 * body is then abandoned as soon as it exceeds that cap. Either way the body
 * is streamed and counted, never buffered past a cap.
 */

import { ValidationError } from './validation-error.js';
import { RequestErrors, tooLarge } from '../errors/kernel.js';
import { readStreamBounded } from '../support/bytes.js';

/** Options for {@link readJsonBody}. */
export interface ReadJsonBodyOptions {
  /** Reject a body larger than this many bytes with a 413. */
  readonly maxBytes?: number;
}

/** Thrown out of the bounded read on overflow, so it is told from a read failure. */
const OVERFLOW = Symbol('overflow');

function overflow(): never {
  throw OVERFLOW;
}

function invalidJson(message: string): ValidationError {
  return new ValidationError([{ path: [], code: 'invalid_json', message }]);
}

/**
 * Read and parse a JSON request body. An unreadable, empty, or malformed body
 * throws {@link ValidationError} (a 422 `request.invalid`); a body over
 * `maxBytes`, or past the request's body budget, throws the kernel's
 * `request.too_large` (a 413). Handlers pass the result to their own schema
 * for field validation.
 */
export async function readJsonBody(
  request: Request,
  options: ReadJsonBodyOptions = {},
): Promise<unknown> {
  const text = await readBodyText(request, options.maxBytes);
  if (text.trim() === '') {
    throw invalidJson('Request body is empty');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidJson('Request body is not valid JSON');
  }
}

async function readBodyText(request: Request, maxBytes: number | undefined): Promise<string> {
  if (maxBytes !== undefined) {
    // A declared length over the cap is refused before a single byte is read.
    const declared = Number(request.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  }

  let bytes: Uint8Array;
  try {
    bytes = await readStreamBounded(request.body, maxBytes ?? Number.POSITIVE_INFINITY, overflow);
  } catch (error) {
    if (error === OVERFLOW) throw tooLarge();
    // The request's body budget ran out: that is the answer, not bad JSON.
    if (isTooLarge(error)) throw error;
    throw invalidJson('Request body could not be read');
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Whether `error` is `request.too_large`: a read past the request's body
 * budget (`server/body-budget.ts`) fails with it.
 */
export function isTooLarge(error: unknown): boolean {
  return RequestErrors.is(error, 'too_large');
}
