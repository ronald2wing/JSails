/**
 * The JSON error envelope shared by resource handlers and the HTTP assembly:
 * `{ error: { status, code, message, ...extra } }`. Only an `HttpError`'s or
 * `ValidationError`'s public fields reach the body; any other throw becomes a
 * generic 500, so raw error text is never echoed. Uses only web-standard
 * `Response`, which keeps `jsails/api` browser-bundleable.
 */

import { HttpError } from '../contracts/http.js';
import { ValidationError } from './validation.js';

interface ErrorBody {
  error: { status: number; code: string; message: string; [key: string]: unknown };
}

/** Build a JSON error-envelope response. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = { error: { status, code, message, ...extra } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Reduce any thrown error to the envelope. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return jsonError(400, 'validation_error', 'Validation failed', {
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(500, 'internal_error', 'Internal Server Error');
}
