/**
 * The value-free error classes of `@jsails/mcp` and their code table.
 *
 * Three audiences, three classes:
 *
 * - {@link McpDefinitionError} is thrown at define time and at factory
 *   construction, to the author. It names what is wrong with a definition,
 *   never the offending value.
 * - {@link McpToolFailure} is thrown by a tool handler on purpose. It is
 *   client-audience: its code and message reach the caller as a tool execution
 *   error (`isError: true`) with a `{ code, message }` structured body.
 * - {@link McpServingError} is operator-audience. Anything else that goes
 *   wrong while serving (a handler throw, a malformed result, a timeout, a
 *   failing gate or authenticator, a rejected request state, a transport
 *   fault) is reported through the serving `onError` hook as one of these,
 *   with the original failure as `cause`; the caller only ever sees a generic
 *   failure.
 * - {@link McpClientError} is thrown by the client to the application that
 *   called a remote server. Its message is written here, never copied from
 *   the remote side (remote text is untrusted); the SDK failure it came from,
 *   when there is one, is its `cause`.
 *
 * {@link MCP_ERROR_CODES} lists every code each class can carry, and under
 * `tool` the fixed codes the serving layer itself puts in a tool error's
 * `{ code, message }` body, so the framework error registry and remote callers
 * can match on them without reading the source.
 */

import { JsailsError, type JsailsErrorContextValue } from 'jsails/plugin-sdk';

const mcpErrorCodes = {
  definition: [
    'invalid_name',
    'invalid_definition',
    'invalid_schema',
    'invalid_uri',
    'invalid_uri_template',
    'invalid_access',
    'invalid_icon',
    'invalid_cache_hint',
    'invalid_option',
    'duplicate_tool',
    'duplicate_resource',
    'duplicate_prompt',
    'missing_gate',
    'invalid_input_request',
  ],
  serving: [
    'handler_failed',
    'invalid_result',
    'result_too_large',
    'timed_out',
    'gate_failed',
    'invalid_gate_decision',
    'request_state_rejected',
    'input_rounds_exceeded',
    'authentication_failed',
    'invalid_authentication',
    'transport_error',
  ],
  client: [
    'invalid_option',
    'connect_failed',
    'unsupported_protocol',
    'unauthorized',
    'forbidden',
    'credentials_failed',
    'protocol_error',
    'unknown_tool',
    'input_required',
    'input_rounds_exceeded',
    'elicit_failed',
    'timeout',
    'aborted',
    'closed',
    'result_too_large',
    'invalid_result',
  ],
  tool: [
    'tool_failed',
    'invalid_arguments',
    'timed_out',
    'result_too_large',
    'aborted',
    'insufficient_scope',
    'not_confirmed',
    'confirmation_unavailable',
    'input_unavailable',
    'too_many_input_rounds',
  ],
} as const;
/**
 * Every code a {@link McpDefinitionError}, {@link McpServingError}, or
 * {@link McpClientError} can carry, and the fixed tool-error codes the serving
 * layer sends (`tool`). A {@link McpToolFailure} thrown by a handler carries
 * its author's own code instead.
 */
export const MCP_ERROR_CODES: typeof mcpErrorCodes = Object.freeze({
  definition: Object.freeze(mcpErrorCodes.definition),
  serving: Object.freeze(mcpErrorCodes.serving),
  client: Object.freeze(mcpErrorCodes.client),
  tool: Object.freeze(mcpErrorCodes.tool),
});

/** Codes carried by {@link McpDefinitionError}. */
export type McpDefinitionErrorCode = (typeof MCP_ERROR_CODES.definition)[number];

/** Codes carried by {@link McpServingError}. */
export type McpServingErrorCode = (typeof MCP_ERROR_CODES.serving)[number];

/** Codes carried by {@link McpClientError}. */
export type McpClientErrorCode = (typeof MCP_ERROR_CODES.client)[number];

/** The fixed codes the serving layer sends in a tool error's structured body. */
export type McpToolErrorCode = (typeof MCP_ERROR_CODES.tool)[number];

/** Raised when a definition, a server, or serving options are malformed. */
export class McpDefinitionError extends JsailsError {
  constructor(
    readonly code: McpDefinitionErrorCode,
    message: string,
    context?: Readonly<Record<string, JsailsErrorContextValue>>,
  ) {
    super(message, context === undefined ? undefined : { context });
  }
}

/** What the serving layer was handling when a {@link McpServingError} happened. */
export type McpServingSite =
  'tool' | 'resource' | 'resource-template' | 'prompt' | 'completion' | 'transport';

/**
 * Reported to the serving `onError` hook; never sent to the caller. `cause`
 * holds the original failure (a handler throw, a gate throw) when there is one.
 */
export class McpServingError extends JsailsError {
  constructor(
    readonly code: McpServingErrorCode,
    message: string,
    site: { readonly kind: McpServingSite; readonly name: string },
    cause?: unknown,
  ) {
    super(message, {
      context: { kind: site.kind, name: site.name },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** The client-audience code shape: lowercase snake case, at most 64 characters. */
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Thrown by a tool handler to fail the call with a code and message the
 * caller (and the model behind it) may read. The message is client-audience:
 * write it for the caller and keep secrets and raw input out of it. A code
 * that is not lowercase snake case turns the failure into a generic one.
 */
export class McpToolFailure extends JsailsError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** True when `failure` can be sent as written. */
export function isSendableFailure(failure: McpToolFailure): boolean {
  return (
    typeof failure.code === 'string' &&
    FAILURE_CODE.test(failure.code) &&
    typeof failure.message === 'string' &&
    failure.message.length > 0
  );
}

/** What a {@link McpClientError} may carry besides its code. */
export interface McpClientErrorDetails {
  /** The JSON-RPC error code the server answered with (`protocol_error`). */
  readonly rpcCode?: number;
  /** The HTTP status the server answered with (`unauthorized`, `forbidden`, `connect_failed`). */
  readonly status?: number;
  /** The scopes a `403 insufficient_scope` challenge named (`forbidden`). */
  readonly scopes?: readonly string[];
  /** The failure this error describes (an SDK error, a thrown handler error). */
  readonly cause?: unknown;
}

/**
 * Thrown by the MCP client: a connection that could not be opened, a request
 * the server refused or answered with something unusable, a deadline, an
 * abort. A tool that ran and reported a failure is not one of these; it is a
 * `tool_error` call outcome.
 */
export class McpClientError extends JsailsError {
  readonly rpcCode: number | undefined;
  readonly status: number | undefined;
  readonly scopes: readonly string[] | undefined;

  constructor(
    readonly code: McpClientErrorCode,
    message: string,
    details: McpClientErrorDetails = {},
  ) {
    super(message, {
      context: {
        code,
        ...(details.rpcCode === undefined ? {} : { rpcCode: details.rpcCode }),
        ...(details.status === undefined ? {} : { status: details.status }),
      },
      ...(details.cause === undefined ? {} : { cause: details.cause }),
    });
    this.rpcCode = details.rpcCode;
    this.status = details.status;
    this.scopes = details.scopes === undefined ? undefined : Object.freeze([...details.scopes]);
  }
}
