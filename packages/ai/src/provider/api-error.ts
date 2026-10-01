/**
 * Mapping what a provider SDK throws to a value-free {@link AiError}.
 *
 * The official Anthropic and OpenAI SDKs raise errors of one shape: an HTTP
 * `status` (absent for a connection failure or an error event inside a
 * stream), the response `headers`, the decoded error body, and a class name
 * that tells a user abort, a connection timeout, and a connection failure
 * apart. The adapters load their SDK lazily and accept injected clients
 * (Bedrock, Vertex, Foundry, a proxy), so the error is read by shape, never by
 * `instanceof`.
 *
 * The result carries only static facts: the code, the HTTP status, and the
 * provider's error type when it is one of a known set. The provider's message
 * is read only to recognize a context-length failure and is never copied.
 * The SDK has already retried what it retries (`maxRetries`); `retryAfterMs`
 * passes the provider's own wait hint on to the caller. An account out of
 * credit is `provider_rejected` with `reason: 'billing'` and no wait hint,
 * even when the provider sends it as HTTP 429, so a caller that retries on
 * `rate_limited` does not retry it forever.
 */

import { AiError, type AiErrorCode } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';

/** What an SDK error says about itself, read by shape. */
export interface ApiErrorFacts {
  /** The HTTP status; absent for connection failures and in-stream error events. */
  readonly status: number | undefined;
  /** The provider's error type (`overloaded_error`, `rate_limit_error`, ...). */
  readonly type: string | undefined;
  /** The provider's error code (OpenAI's `context_length_exceeded`, ...). */
  readonly code: string | undefined;
  /** The provider's message. Read for classification only; never copied. */
  readonly message: string | undefined;
}

/** Recognizes a context-length failure from the facts of a rejected request. */
export type ContextLengthTest = (facts: ApiErrorFacts) => boolean;

/** Error types that are safe to report back as context: the SDKs' own fixed set. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
  'conflict_error',
]);

interface HeaderReader {
  get(name: string): string | null;
}

function className(error: object): string | undefined {
  const name = (error as { readonly name?: unknown }).name;
  const constructorName = (error as { readonly constructor?: { readonly name?: unknown } })
    .constructor?.name;
  for (const candidate of [constructorName, name]) {
    if (typeof candidate === 'string' && candidate.startsWith('API')) return candidate;
  }
  return typeof name === 'string' ? name : undefined;
}

function stringField(record: unknown, key: string): string | undefined {
  if (!isPlainObject(record)) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read the classification facts of an SDK error. */
export function readApiErrorFacts(error: unknown): ApiErrorFacts {
  if (typeof error !== 'object' || error === null) {
    return { status: undefined, type: undefined, code: undefined, message: undefined };
  }
  const shape = error as {
    readonly status?: unknown;
    readonly type?: unknown;
    readonly code?: unknown;
    readonly error?: unknown;
  };
  const body = shape.error;
  // Anthropic keeps the whole body (`{ type: 'error', error: { type, message } }`);
  // OpenAI keeps its inner `error` object.
  const inner = isPlainObject(body) && isPlainObject(body.error) ? body.error : body;
  const status =
    typeof shape.status === 'number' && Number.isSafeInteger(shape.status)
      ? shape.status
      : undefined;
  return {
    status,
    type: typeof shape.type === 'string' ? shape.type : stringField(inner, 'type'),
    code: typeof shape.code === 'string' ? shape.code : stringField(inner, 'code'),
    message: stringField(inner, 'message'),
  };
}

/**
 * The wait a response asked for, in milliseconds: `retry-after-ms`, else
 * `retry-after` as seconds or as an HTTP date. Absent or unusable is
 * `undefined`.
 */
export function readRetryAfterMs(headers: unknown, now: number = Date.now()): number | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const reader = headers as Partial<HeaderReader>;
  if (typeof reader.get !== 'function') return undefined;
  const millis = reader.get.call(headers, 'retry-after-ms');
  if (typeof millis === 'string' && /^\d+(\.\d+)?$/.test(millis.trim())) {
    return Math.ceil(Number(millis));
  }
  const after = reader.get.call(headers, 'retry-after');
  if (typeof after !== 'string' || after.trim().length === 0) return undefined;
  const text = after.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function failure(
  code: AiErrorCode,
  message: string,
  context: Readonly<Record<string, string | number>>,
  retryAfterMs?: number,
): AiError {
  return new AiError(code, message, {
    context,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function typeContext(type: string | undefined): Readonly<Record<string, string>> {
  return type !== undefined && KNOWN_TYPES.has(type) ? { type } : {};
}

/**
 * Whether the account is out of credit: OpenAI answers that with HTTP 429 and
 * the code (and type) `insufficient_quota`, and Anthropic with a
 * `billing_error`. Waiting never fixes it, so it is never `rate_limited`.
 */
function isBillingFailure(facts: ApiErrorFacts): boolean {
  return (
    facts.code === 'insufficient_quota' ||
    facts.type === 'insufficient_quota' ||
    facts.type === 'billing_error'
  );
}

function billingFailure(context: Readonly<Record<string, string | number>>): AiError {
  return failure('provider_rejected', 'the provider account cannot pay for the request', {
    ...context,
    reason: 'billing',
  });
}

function byStatus(
  status: number,
  facts: ApiErrorFacts,
  isContextLength: ContextLengthTest,
  retryAfterMs: number | undefined,
): AiError {
  const context = { status, ...typeContext(facts.type) };
  if (isBillingFailure(facts)) return billingFailure(context);
  if (status === 429) {
    return failure('rate_limited', 'the provider rate limit was reached', context, retryAfterMs);
  }
  if (status >= 500 || status === 408 || status === 409) {
    return failure('provider_unavailable', 'the provider is unavailable', context, retryAfterMs);
  }
  if (status === 401 || status === 403) {
    return failure('provider_auth', 'the provider refused the credentials', context);
  }
  if ((status === 400 || status === 413 || status === 422) && isContextLength(facts)) {
    return failure(
      'context_length_exceeded',
      'the request exceeds the model context window',
      context,
    );
  }
  return failure('provider_rejected', 'the provider rejected the request', context);
}

function byType(facts: ApiErrorFacts, isContextLength: ContextLengthTest): AiError | undefined {
  const context = typeContext(facts.type);
  if (isBillingFailure(facts)) return billingFailure(context);
  switch (facts.type) {
    case 'overloaded_error':
    case 'api_error':
    case 'timeout_error':
    case 'server_error':
      return failure('provider_unavailable', 'the provider is unavailable', context);
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
      return failure('rate_limited', 'the provider rate limit was reached', context);
    case 'authentication_error':
    case 'permission_error':
      return failure('provider_auth', 'the provider refused the credentials', context);
    case 'invalid_request_error':
      return isContextLength(facts)
        ? failure(
            'context_length_exceeded',
            'the request exceeds the model context window',
            context,
          )
        : failure('provider_rejected', 'the provider rejected the request', context);
    default:
      return undefined;
  }
}

/**
 * Map anything an SDK call threw to an `AiError`. An `AiError` passes through;
 * a stopped call (`signal` aborted) is `aborted`; a billing failure is
 * `provider_rejected` (`reason: 'billing'`); HTTP statuses map to
 * `rate_limited`, `provider_unavailable`, `provider_auth`,
 * `context_length_exceeded`, or `provider_rejected`; connection failures and
 * timeouts are `provider_unavailable`; an error event inside a stream maps by
 * its type; anything else is `provider_failed`.
 */
export function mapApiError(
  error: unknown,
  signal: AbortSignal | undefined,
  isContextLength: ContextLengthTest,
): AiError {
  if (error instanceof AiError) return error;
  if (signal?.aborted === true) return new AiError('aborted', 'the provider call was stopped');
  if (typeof error !== 'object' || error === null) {
    return new AiError('provider_failed', 'the provider call failed');
  }
  const name = className(error);
  if (name === 'APIUserAbortError' || name === 'AbortError') {
    return new AiError('aborted', 'the provider call was stopped');
  }
  if (name === 'APIConnectionTimeoutError') {
    return failure('provider_unavailable', 'the provider did not answer in time', {
      reason: 'timeout',
    });
  }
  if (name === 'APIConnectionError') {
    return failure('provider_unavailable', 'the provider could not be reached', {
      reason: 'connection',
    });
  }
  const facts = readApiErrorFacts(error);
  const retryAfterMs = readRetryAfterMs((error as { readonly headers?: unknown }).headers);
  if (facts.status !== undefined)
    return byStatus(facts.status, facts, isContextLength, retryAfterMs);
  return (
    byType(facts, isContextLength) ?? new AiError('provider_failed', 'the provider call failed')
  );
}
