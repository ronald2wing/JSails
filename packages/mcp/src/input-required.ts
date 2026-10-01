/**
 * Multi-round-trip input: what a handler returns when it needs the user's
 * answer (or its own state carried to the next round) before it can finish.
 *
 * {@link inputRequired} builds the value. Each request is an elicitation: a
 * `form` asks for fields described by an object schema, a `url` sends the user
 * to a page. `state` is any JSON value the handler wants back on the next
 * round; the serving layer seals it (HMAC, bound to the caller, the method, the
 * target, and the exact arguments) so the handler reads back only what it
 * wrote, and only on the same call. On the 2026-07-28 revision the client
 * answers and retries; on a 2025 connection that can carry server-to-client
 * requests (stdio) the SDK asks the client itself and re-enters the handler;
 * on stateless legacy HTTP, where neither is possible, the call fails with a
 * value-free error instead.
 *
 * Everything is checked when the value is built (keys, messages, URLs, form
 * schemas against the restricted elicitation shape, state size), so a
 * malformed request is a handler failure reported to the operator, never a
 * half-sent result.
 */

import {
  inputRequired as sdkInputRequired,
  type InputRequest,
  type InputRequests,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { isRecord } from 'jsails/plugin-sdk';

import { strictJson, type JsonValue } from './content.js';
import { McpDefinitionError } from './errors.js';
import { projectSchema, wireSchema, type McpSchema } from './schema-projection.js';

/** A form elicitation: the user fills in the fields `schema` describes. */
export interface McpFormRequest<S extends McpSchema = McpSchema> {
  readonly mode: 'form';
  /** What the user is asked, in plain words. */
  readonly message: string;
  /**
   * An object schema of flat primitive fields (string, number, integer,
   * boolean, string enums), the shape elicitation allows.
   */
  readonly schema: S;
}

/** A URL elicitation: the user is sent to a page (sign-in, payment, consent). */
export interface McpUrlRequest {
  readonly mode: 'url';
  readonly message: string;
  /** An `https:` URL, or `http:` on a loopback host. */
  readonly url: string;
}

/** One input request. */
export type McpInputRequest = McpFormRequest | McpUrlRequest;

/** What {@link inputRequired} takes: at least one request, or state, or both. */
export interface McpInputRequiredSpec {
  /**
   * Requests keyed by an identifier the handler reads the answer back with
   * (`ctx.answer(key)`): letters, digits, `_`, `-`, `.`, at most 64, not
   * starting with `jsails.` (reserved for the framework's own requests).
   */
  readonly requests?: Readonly<Record<string, McpInputRequest>>;
  /** Handler state for the next round (`ctx.state()`), at most 16 KiB of JSON. */
  readonly state?: JsonValue;
}

/** The opaque value a handler returns to ask for input. */
export interface McpInputRequired {
  readonly kind: 'input-required';
}

/** The answer to one request, as the handler reads it on the next round. */
export type McpElicitAnswer<T> =
  | { readonly action: 'accept'; readonly content: T }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' };

/** The checked form of an input-required value. */
export interface InputRequiredRecord {
  /** The wire requests; `undefined` when the value carries state only. */
  readonly requests: InputRequests | undefined;
  readonly state: JsonValue | undefined;
}

/** The key the framework uses for a tool's confirmation request. */
export const CONFIRM_KEY = 'jsails.confirm';

const KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_PREFIX = 'jsails.';
const MAX_STATE_BYTES = 16_384;
const MAX_MESSAGE_LENGTH = 4_096;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const records = new WeakMap<object, InputRequiredRecord>();
/** Form schemas already projected and accepted by the SDK's restricted-shape check. */
const formSchemas = new WeakMap<object, StandardSchemaWithJSON>();

function invalid(reason: string): McpDefinitionError {
  return new McpDefinitionError('invalid_input_request', `inputRequired ${reason}`);
}

function checkMessage(message: unknown): string {
  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    throw invalid(`messages must be non-empty strings of at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  return message;
}

/**
 * The wire form of a form request. The schema is projected once and checked
 * by the SDK against the restricted elicitation shape; the result is reused
 * for every later request with the same schema object and message.
 */
function formRequest(schema: unknown, message: string): InputRequest {
  if (typeof schema !== 'object' || schema === null) {
    throw invalid('form requests need an object schema');
  }
  const known = formSchemas.get(schema);
  if (known !== undefined) {
    return sdkInputRequired.elicit({ message, requestedSchema: known });
  }
  let wire: StandardSchemaWithJSON;
  try {
    wire = wireSchema(projectSchema(schema, 'input', 'elicitation').json);
  } catch (_projection) {
    throw invalid('form schemas must be object schemas with JSON Schema support');
  }
  let request: InputRequest;
  try {
    request = sdkInputRequired.elicit({ message, requestedSchema: wire });
  } catch (_restricted) {
    throw invalid(
      'form schemas may only hold flat string, number, integer, boolean, or enum fields',
    );
  }
  formSchemas.set(schema, wire);
  return request;
}

function urlRequest(url: unknown, message: string): InputRequest {
  if (typeof url !== 'string' || !URL.canParse(url)) {
    throw invalid('url requests need an absolute URL');
  }
  const parsed = new URL(url);
  const secure =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!secure || parsed.username !== '' || parsed.password !== '') {
    throw invalid('url requests need an https: URL (http: only on loopback) without credentials');
  }
  return sdkInputRequired.elicitUrl({ message, url: parsed.href });
}

/** Check one request and return its wire form. */
export function wireInputRequest(request: unknown): InputRequest {
  if (!isRecord(request)) {
    throw invalid('requests must be objects');
  }
  const message = checkMessage(request.message);
  if (request.mode === 'form') {
    return formRequest(request.schema, message);
  }
  if (request.mode === 'url') {
    return urlRequest(request.url, message);
  }
  throw invalid('request mode must be form or url');
}

/**
 * Ask for input. Return the result from a tool handler, resource reader, or
 * prompt renderer; the handler runs again with the answers (`ctx.answer`) and
 * its state (`ctx.state`). Throws {@link McpDefinitionError} with code
 * `invalid_input_request` on a malformed spec.
 */
export function inputRequired(spec: McpInputRequiredSpec): McpInputRequired {
  if (!isRecord(spec)) {
    throw invalid('needs a spec object');
  }
  for (const field of Object.keys(spec)) {
    if (field !== 'requests' && field !== 'state') {
      throw invalid('spec has an unknown field');
    }
  }
  let requests: InputRequests | undefined;
  if (spec.requests !== undefined) {
    if (!isRecord(spec.requests)) {
      throw invalid('requests must be an object keyed by request id');
    }
    const entries = Object.entries(spec.requests);
    if (entries.length > 0) {
      requests = {};
      for (const [key, request] of entries) {
        if (!KEY.test(key) || key.startsWith(RESERVED_PREFIX)) {
          throw invalid(
            'request keys must be at most 64 letters, digits, "_", "-", or "." and must not start with "jsails."',
          );
        }
        requests[key] = wireInputRequest(request);
      }
    }
  }
  const state = spec.state;
  if (state !== undefined) {
    let json: string;
    try {
      json = strictJson(state);
    } catch (_notJson) {
      throw invalid('state must be a JSON value');
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
      throw invalid(`state must be at most ${MAX_STATE_BYTES} bytes of JSON`);
    }
  }
  if (requests === undefined && state === undefined) {
    throw invalid('needs at least one request or state');
  }
  const handle: McpInputRequired = Object.freeze({ kind: 'input-required' });
  records.set(
    handle,
    Object.freeze({
      requests,
      state: state === undefined ? undefined : (JSON.parse(strictJson(state)) as JsonValue),
    }),
  );
  return handle;
}

/** The record behind an {@link inputRequired} value, or `undefined` for anything else. */
export function inputRequiredRecord(value: unknown): InputRequiredRecord | undefined {
  return typeof value === 'object' && value !== null ? records.get(value) : undefined;
}

/** The wire form of a tool's confirmation request. */
export function confirmationRequest(message: string): InputRequest {
  return sdkInputRequired.elicit({
    message: checkMessage(message),
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', title: 'Confirm', description: 'Allow this call to run.' },
      },
      required: ['confirm'],
    },
  });
}
