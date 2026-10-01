/**
 * The framework's one JSON request-body reader.
 *
 * `createApp` already caps every body through its `bodyLimit` middleware, so a
 * handler mounted there may read without a limit of its own. A handler that can
 * also run outside `createApp` (the resource handlers) passes `maxBytes`, and
 * the body is then streamed and abandoned as soon as it exceeds the cap rather
 * than buffered whole.
 */

import { ValidationError } from './validation.js';
import { HttpError } from '../contracts/http.js';
import { readStreamBounded } from '../support/bytes.js';

/** Options for {@link readJsonBody}. */
export interface ReadJsonBodyOptions {
  /** Reject a body larger than this many bytes with a 413. */
  readonly maxBytes?: number;
}

function invalidJson(message: string): ValidationError {
  return new ValidationError([{ path: [], code: 'invalid_json', message }]);
}

function tooLarge(): never {
  throw new HttpError('payload_too_large', 'Request body too large', 413);
}

/**
 * Read and parse a JSON request body. An unreadable, empty, or malformed body
 * throws {@link ValidationError} (a 400); a body over `maxBytes` throws an
 * {@link HttpError} with status 413. Handlers pass the result to their own
 * schema for field validation.
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
  if (maxBytes === undefined) {
    try {
      return await request.text();
    } catch {
      throw invalidJson('Request body could not be read');
    }
  }

  // A declared length over the cap is refused before a single byte is read.
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    tooLarge();
  }

  let bytes: Uint8Array;
  try {
    bytes = await readStreamBounded(request.body, maxBytes, tooLarge);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidJson('Request body could not be read');
  }
  return new TextDecoder().decode(bytes);
}
