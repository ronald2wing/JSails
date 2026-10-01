/**
 * The MCP client: {@link connectMcp} opens a connection to a remote server
 * over Streamable HTTP or stdio, on the official client, and returns a
 * {@link McpRemoteServer} whose every answer has been checked.
 *
 * - Era. `protocol: 'auto'` (the default) probes with `server/discover` and
 *   falls back to the 2025 `initialize` handshake for a server that does not
 *   speak 2026-07-28; `'modern'` requires 2026-07-28 and `'legacy'` uses
 *   only the handshake.
 * - Lists walk every page (with a page cap and a repeated-cursor check). A
 *   tool is left out of the list, and reported through `onToolExcluded`,
 *   when its name breaks the MCP name rule or repeats an earlier one, when an
 *   `x-mcp-header` declaration in its input schema breaks the Streamable HTTP
 *   rules, or when its output schema does not compile. The same rules apply on
 *   every era and transport, so the callable set does not depend on how the
 *   server was reached; only listed tools can be called.
 * - A call's outcome keeps the three cases apart: `ok` (structured output
 *   checked against the tool's output schema), `tool_error` (the tool ran
 *   and reported a failure), and `input_required` (the server needs input
 *   and no `elicit` handler can give it). Everything else, from a refused
 *   request to an unusable answer, is a thrown {@link McpClientError}.
 * - Input. With an `elicit` handler, the client answers a 2026-07-28 server's
 *   input requests and retries (echoing its request state) up to
 *   `maxInputRounds` times, and answers a 2025 server's elicitation requests
 *   as they come; without one it declares no elicitation capability.
 * - Every request runs under a deadline, the caller's abort signal, and the
 *   result size cap; content blocks and resource bodies are re-validated and
 *   returned frozen. A request the signal or the deadline ends is cancelled
 *   on the server too, on every transport and era (see `remote-transport`).
 */

import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type CallToolResult,
  type ClientCapabilities,
  type RequestOptions,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { deepCloneJson, deepFreeze, isRecord, type Awaitable } from 'jsails/plugin-sdk';

import {
  InvalidContentError,
  strictJson,
  wireContent,
  wireContentList,
  wireResourceContent,
  type JsonValue,
  type McpContent,
  type McpPromptMessage,
  type McpResourceContents,
} from './content.js';
import type { McpToolAnnotations } from './definitions.js';
import { McpClientError, type McpClientErrorCode } from './errors.js';
import {
  BodyLimitError,
  checkTransport,
  ConnectReplies,
  CredentialsError,
  MessageGuard,
  sdkTransport,
  type McpClientTransport,
} from './remote-transport.js';
import { scanHeaderDeclarations } from './schema-projection.js';

/** One input request from the server, as the `elicit` handler sees it. */
export type McpElicitation =
  | {
      readonly mode: 'form';
      /**
       * The server's identifier for the request on a 2026-07-28 connection;
       * `undefined` for a 2025 server's elicitation request.
       */
      readonly key: string | undefined;
      readonly message: string;
      /** The restricted JSON Schema of the fields to fill in. */
      readonly schema: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly mode: 'url';
      readonly key: string | undefined;
      readonly message: string;
      /** An `https:` URL (or `http:` on a loopback host) to send the user to. */
      readonly url: string;
    };

/** A form field value an elicitation answer may carry. */
export type McpElicitValue = string | number | boolean | readonly string[];

/** The user's answer to one input request. */
export type McpElicitReply =
  | {
      readonly action: 'accept';
      /** The filled-in fields; required for a form, ignored for a URL. */
      readonly content?: Readonly<Record<string, McpElicitValue>>;
    }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' };

/** Answers input requests; `signal` aborts when the call it belongs to does. */
export type McpElicitHandler = (
  request: McpElicitation,
  context: { readonly signal: AbortSignal },
) => Awaitable<McpElicitReply>;

/** Why a listed tool was left out. */
export type McpToolExclusionReason =
  'invalid_name' | 'duplicate_name' | 'invalid_header_declaration' | 'invalid_output_schema';

/** A tool the server listed and the client left out. */
export interface McpToolExclusion {
  /** The listed name; for `invalid_name`, remote text to treat with care. */
  readonly name: string;
  readonly reason: McpToolExclusionReason;
}

/** Options every client connection takes. */
export interface McpRemoteOptions {
  /** How this client names itself to the server. Default `{ name: 'jsails-mcp-client', version: '1.0.0' }`. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** The protocol era: probe and fall back (default), 2026-07-28 only, or 2025 only. */
  readonly protocol?: 'auto' | 'modern' | 'legacy';
  /** The deadline of each request (and of connecting), in milliseconds. Default 60 000. */
  readonly timeoutMs?: number;
  /** The largest result accepted, in UTF-8 bytes of JSON. Default 1 MiB. */
  readonly maxResultBytes?: number;
  /** How many times one call may be retried with answers. Default 8. */
  readonly maxInputRounds?: number;
  /** Answers the server's input requests. Without it the client declares no elicitation support. */
  readonly elicit?: McpElicitHandler;
  /** Told about every listed tool that was left out. Default: a process warning. */
  readonly onToolExcluded?: (exclusion: McpToolExclusion) => void;
  /** Aborts connecting. */
  readonly signal?: AbortSignal;
}

/** Options for {@link connectMcp}. */
export interface McpClientOptions extends McpRemoteOptions {
  readonly transport: McpClientTransport;
}

/** Per-call options. */
export interface McpCallOptions {
  readonly signal?: AbortSignal;
  /** This call's deadline per request, in milliseconds. Default: the connection's `timeoutMs`. */
  readonly timeoutMs?: number;
}

/** Options for {@link McpRemoteServer.callTool}. */
export interface McpToolCallOptions extends McpCallOptions {
  /** Told about progress the server reports (only increasing values reach it). */
  readonly onProgress?: (progress: number, total?: number, message?: string) => void;
}

/** What the server said about itself when the connection opened. */
export interface McpServerInfo {
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly title: string | undefined;
  /** The negotiated protocol revision, such as `2026-07-28` or `2025-11-25`. */
  readonly protocolVersion: string;
  readonly era: 'modern' | 'legacy';
  readonly instructions: string | undefined;
  readonly capabilities: Readonly<Record<string, JsonValue>>;
}

/** A tool the server lists. */
export interface McpRemoteTool {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema: Readonly<Record<string, JsonValue>> | undefined;
  readonly annotations: McpToolAnnotations;
}

/** A resource the server lists. */
export interface McpRemoteResource {
  readonly uri: string;
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly mimeType: string | undefined;
}

/** A resource template the server lists. */
export interface McpRemoteResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly mimeType: string | undefined;
}

/** A prompt the server lists. */
export interface McpRemotePrompt {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly arguments: readonly {
    readonly name: string;
    readonly description: string | undefined;
    readonly required: boolean;
  }[];
}

/** The outcome of a tool call. */
export type McpCallOutcome =
  | {
      readonly status: 'ok';
      readonly content: readonly McpContent[];
      /** Present when the tool returned structured output; checked against its output schema. */
      readonly structured: JsonValue | undefined;
    }
  | {
      /** The tool ran and reported a failure (`isError`); `structured` is not schema-checked. */
      readonly status: 'tool_error';
      readonly content: readonly McpContent[];
      readonly structured: JsonValue | undefined;
    }
  | {
      /**
       * The server needs input this client cannot give: no `elicit` handler,
       * a mode it does not support, or a connection that cannot carry the
       * request (the server answered `input_unavailable`).
       */
      readonly status: 'input_required';
    };

/** A connected remote server. Every method throws {@link McpClientError} on failure. */
export interface McpRemoteServer {
  readonly info: McpServerInfo;
  listTools(options?: McpCallOptions): Promise<readonly McpRemoteTool[]>;
  callTool(
    name: string,
    args?: Readonly<Record<string, JsonValue>>,
    options?: McpToolCallOptions,
  ): Promise<McpCallOutcome>;
  listResources(options?: McpCallOptions): Promise<readonly McpRemoteResource[]>;
  listResourceTemplates(options?: McpCallOptions): Promise<readonly McpRemoteResourceTemplate[]>;
  readResource(uri: string, options?: McpCallOptions): Promise<McpResourceContents>;
  listPrompts(options?: McpCallOptions): Promise<readonly McpRemotePrompt[]>;
  getPrompt(
    name: string,
    args?: Readonly<Record<string, string>>,
    options?: McpCallOptions,
  ): Promise<readonly McpPromptMessage[]>;
  /** Close the connection (and stop a spawned server). Idempotent. */
  close(): Promise<void>;
}

/** Client settings after validation. */
export interface ClientSettings {
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly protocol: 'auto' | 'modern' | 'legacy';
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly maxInputRounds: number;
  readonly elicit: McpElicitHandler | undefined;
  readonly onToolExcluded: (exclusion: McpToolExclusion) => void;
  readonly signal: AbortSignal | undefined;
}

const MODERN_REVISION = '2026-07-28';
const DEFAULT_CLIENT_INFO = Object.freeze({ name: 'jsails-mcp-client', version: '1.0.0' });
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULT_BYTES = 1_048_576;
const DEFAULT_MAX_INPUT_ROUNDS = 8;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RESULT_BYTES = 268_435_456;
const MAX_INPUT_ROUNDS = 100;
const MAX_LIST_PAGES = 64;
/** The MCP tool name rule (2025-11-25 and later). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
const REMOTE_OPTION_KEYS: readonly string[] = [
  'clientInfo',
  'protocol',
  'timeoutMs',
  'maxResultBytes',
  'maxInputRounds',
  'elicit',
  'onToolExcluded',
  'signal',
];

function invalidOption(option: string, reason: string): McpClientError {
  return new McpClientError('invalid_option', `${option} ${reason}`);
}

function boundedInteger(value: unknown, fallback: number, option: string, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw invalidOption(option, `must be a positive integer of at most ${max}`);
  }
  return value;
}

function defaultExclusionReport(exclusion: McpToolExclusion): void {
  const subject =
    exclusion.reason === 'invalid_name'
      ? 'a tool with an invalid name'
      : `tool "${exclusion.name}"`;
  process.emitWarning(
    `The MCP server listed ${subject}, which was left out (${exclusion.reason}).`,
    {
      code: 'JSAILS_MCP_TOOL_EXCLUDED',
    },
  );
}

/**
 * Validate the options every connection takes; `extraKeys` are the fields the
 * calling entry point adds (such as `transport`).
 */
export function checkRemoteOptions(options: unknown, extraKeys: readonly string[]): ClientSettings {
  if (!isRecord(options)) {
    throw invalidOption('options', 'must be an object');
  }
  const known = new Set([...REMOTE_OPTION_KEYS, ...extraKeys]);
  if (Object.keys(options).some((key) => !known.has(key))) {
    throw invalidOption('options', 'have an unknown field');
  }
  let clientInfo: ClientSettings['clientInfo'] = DEFAULT_CLIENT_INFO;
  if (options.clientInfo !== undefined) {
    const info = options.clientInfo;
    if (
      !isRecord(info) ||
      typeof info.name !== 'string' ||
      info.name.length === 0 ||
      typeof info.version !== 'string' ||
      info.version.length === 0
    ) {
      throw invalidOption('clientInfo', 'must have a non-empty name and version');
    }
    clientInfo = Object.freeze({ name: info.name, version: info.version });
  }
  const protocol = options.protocol ?? 'auto';
  if (protocol !== 'auto' && protocol !== 'modern' && protocol !== 'legacy') {
    throw invalidOption('protocol', "must be 'auto', 'modern', or 'legacy'");
  }
  if (options.elicit !== undefined && typeof options.elicit !== 'function') {
    throw invalidOption('elicit', 'must be a function');
  }
  if (options.onToolExcluded !== undefined && typeof options.onToolExcluded !== 'function') {
    throw invalidOption('onToolExcluded', 'must be a function');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidOption('signal', 'must be an AbortSignal');
  }
  return Object.freeze({
    clientInfo,
    protocol,
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS),
    maxResultBytes: boundedInteger(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      'maxResultBytes',
      MAX_RESULT_BYTES,
    ),
    maxInputRounds: boundedInteger(
      options.maxInputRounds,
      DEFAULT_MAX_INPUT_ROUNDS,
      'maxInputRounds',
      MAX_INPUT_ROUNDS,
    ),
    elicit: options.elicit as McpElicitHandler | undefined,
    onToolExcluded:
      (options.onToolExcluded as ClientSettings['onToolExcluded'] | undefined) ??
      defaultExclusionReport,
    signal: options.signal,
  });
}

/** The cause chain of an error, nearest first, bounded against cycles. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

const MESSAGES: Readonly<Record<McpClientErrorCode, string>> = Object.freeze({
  invalid_option: 'The client options are invalid.',
  connect_failed: 'The MCP server could not be reached.',
  unsupported_protocol: 'The MCP server does not speak a protocol revision this client can use.',
  unauthorized: 'The MCP server requires valid credentials.',
  forbidden: 'The MCP server refused the credentials for this request.',
  credentials_failed: 'The credentials for the MCP server could not be produced.',
  protocol_error: 'The MCP server refused the request.',
  unknown_tool: 'The MCP server lists no such tool.',
  input_required: 'The MCP server needs input this client cannot give.',
  input_rounds_exceeded: 'The MCP server asked for input more times than allowed.',
  elicit_failed: 'The elicitation handler failed or gave an invalid answer.',
  timeout: 'The MCP server did not answer in time.',
  aborted: 'The request was aborted.',
  closed: 'The connection to the MCP server is closed.',
  result_too_large: 'The MCP server sent a result larger than allowed.',
  invalid_result: 'The MCP server sent a result that does not match the protocol or the schema.',
});

function clientError(
  code: McpClientErrorCode,
  details: ConstructorParameters<typeof McpClientError>[2] = {},
): McpClientError {
  return new McpClientError(code, MESSAGES[code], details);
}

const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function scopesOf(value: unknown): readonly string[] | undefined {
  const listed = typeof value === 'string' ? value.split(' ') : Array.isArray(value) ? value : [];
  const scopes = (listed as unknown[]).filter(
    (scope): scope is string => typeof scope === 'string' && SCOPE_TOKEN.test(scope),
  );
  return scopes.length === 0 ? undefined : scopes;
}

/** Translate whatever a request or connect threw into a {@link McpClientError}. */
function translate(
  error: unknown,
  phase: 'connect' | 'request',
  guard: MessageGuard,
  signal: AbortSignal | undefined,
  replies?: ConnectReplies,
): McpClientError {
  if (error instanceof McpClientError) {
    return error;
  }
  if (signal?.aborted === true) {
    return clientError('aborted', { cause: error });
  }
  const chain = causes(error);
  if (
    chain.some(
      (link) =>
        link instanceof BodyLimitError ||
        (link instanceof ProtocolError && guard.isTooLarge(link.data)),
    )
  ) {
    return clientError('result_too_large', { cause: error });
  }
  if (chain.some((link) => link instanceof CredentialsError)) {
    return clientError('credentials_failed', { cause: error });
  }
  const scopeError = chain.find((link) => link instanceof InsufficientScopeError);
  if (scopeError instanceof InsufficientScopeError) {
    const scopes = scopesOf(scopeError.requiredScope);
    return clientError('forbidden', {
      status: 403,
      cause: error,
      ...(scopes === undefined ? {} : { scopes }),
    });
  }
  if (chain.some((link) => link instanceof UnauthorizedError)) {
    return clientError('unauthorized', { status: 401, cause: error });
  }
  const http = chain.find((link) => link instanceof SdkHttpError);
  if (http instanceof SdkHttpError) {
    const status = http.status;
    if (status === 401) {
      return clientError('unauthorized', { status, cause: error });
    }
    if (status === 403) {
      return clientError('forbidden', { status, cause: error });
    }
    return clientError(phase === 'connect' ? 'connect_failed' : 'protocol_error', {
      status,
      cause: error,
    });
  }
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return clientError('timeout', { cause: error });
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.SendFailed:
        return clientError(phase === 'connect' ? 'connect_failed' : 'closed', { cause: error });
      case SdkErrorCode.EraNegotiationFailed:
        // The SDK reports a server that failed the probe like one that does
        // not speak the revision; only the reply codes tell them apart.
        return clientError(
          error.cause === undefined && replies?.serverFailed() !== true
            ? 'unsupported_protocol'
            : 'connect_failed',
          { cause: error },
        );
      case SdkErrorCode.InvalidResult:
      case SdkErrorCode.UnsupportedResultType:
      case SdkErrorCode.ListPaginationExceeded:
      case SdkErrorCode.ClientHttpUnexpectedContent:
        return clientError('invalid_result', { cause: error });
      default:
        return clientError(phase === 'connect' ? 'connect_failed' : 'protocol_error', {
          cause: error,
        });
    }
  }
  if (error instanceof ProtocolError) {
    if (error.code === Number(ProtocolErrorCode.UnsupportedProtocolVersion)) {
      return clientError('unsupported_protocol', { rpcCode: error.code, cause: error });
    }
    if (isRecord(error.data) && error.data.reason === 'input_unavailable') {
      return clientError('input_required', { rpcCode: error.code, cause: error });
    }
    if (isRecord(error.data) && error.data.reason === 'insufficient_scope') {
      const scopes = scopesOf(error.data.scopes);
      return clientError('forbidden', {
        rpcCode: error.code,
        cause: error,
        ...(scopes === undefined ? {} : { scopes }),
      });
    }
    return clientError(phase === 'connect' ? 'connect_failed' : 'protocol_error', {
      rpcCode: error.code,
      cause: error,
    });
  }
  return clientError(phase === 'connect' ? 'connect_failed' : 'protocol_error', { cause: error });
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function frozenJson(value: unknown): Readonly<Record<string, JsonValue>> {
  return deepFreeze(deepCloneJson(value as Record<string, JsonValue>));
}

function annotationsOf(value: unknown): McpToolAnnotations {
  if (!isRecord(value)) {
    return Object.freeze({});
  }
  const pick = (key: string): boolean | undefined =>
    typeof value[key] === 'boolean' ? value[key] : undefined;
  const hints = {
    readOnly: pick('readOnlyHint'),
    destructive: pick('destructiveHint'),
    idempotent: pick('idempotentHint'),
    openWorld: pick('openWorldHint'),
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(hints).filter(([, hint]) => hint !== undefined)),
  );
}

/** One listed, admitted tool and what calling it needs. */
interface ToolEntry {
  readonly tool: McpRemoteTool;
  /** What the SDK gets for `Mcp-Param-*` mirroring; no output schema, so it does not validate. */
  readonly definition: Tool;
  readonly validate: ((value: unknown) => boolean) | undefined;
}

interface ToolIndex {
  readonly list: readonly McpRemoteTool[];
  readonly byName: ReadonlyMap<string, ToolEntry>;
}

/**
 * Index a listing: drop the tools a conforming client must not offer, and
 * compile each admitted output schema once (on a fresh validator per listing,
 * so a schema `$id` cannot shadow another listing's).
 */
function indexTools(
  raw: readonly Tool[],
  report: (exclusion: McpToolExclusion) => void,
): ToolIndex {
  const validator = new AjvJsonSchemaValidator();
  const byName = new Map<string, ToolEntry>();
  const ids = new Set<string>();
  const list: McpRemoteTool[] = [];
  for (const tool of raw) {
    const name = tool.name;
    let reason: McpToolExclusionReason | undefined;
    let validate: ToolEntry['validate'];
    if (!TOOL_NAME.test(name)) {
      reason = 'invalid_name';
    } else if (byName.has(name)) {
      reason = 'duplicate_name';
    } else if (scanHeaderDeclarations(tool.inputSchema) !== undefined) {
      reason = 'invalid_header_declaration';
    } else if (tool.outputSchema !== undefined) {
      const schema = deepCloneJson(tool.outputSchema);
      const id = schema.$id;
      if (typeof id === 'string' && ids.has(id)) {
        reason = 'invalid_output_schema';
      } else {
        try {
          const check = validator.getValidator(schema);
          validate = (value) => check(value).valid;
          if (typeof id === 'string') {
            ids.add(id);
          }
        } catch (_compileError) {
          reason = 'invalid_output_schema';
        }
      }
    }
    if (reason !== undefined) {
      report(Object.freeze({ name, reason }));
      continue;
    }
    const remote: McpRemoteTool = Object.freeze({
      name,
      title: optionalText(tool.title) ?? optionalText(tool.annotations?.title),
      description: optionalText(tool.description),
      inputSchema: frozenJson(tool.inputSchema),
      outputSchema: tool.outputSchema === undefined ? undefined : frozenJson(tool.outputSchema),
      annotations: annotationsOf(tool.annotations),
    });
    list.push(remote);
    byName.set(name, {
      tool: remote,
      definition: { name, inputSchema: deepCloneJson(tool.inputSchema) },
      validate,
    });
  }
  return { list: Object.freeze(list), byName };
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || IPV4_LOOPBACK.test(hostname);
}

/** An input request in its checked form, or `undefined` for a kind this client does not answer. */
function elicitationOf(request: unknown, key: string | undefined): McpElicitation | undefined {
  if (!isRecord(request) || request.method !== 'elicitation/create' || !isRecord(request.params)) {
    return undefined;
  }
  return elicitationParams(request.params, key);
}

function elicitationParams(
  params: Record<string, unknown>,
  key: string | undefined,
): McpElicitation {
  if (typeof params.message !== 'string') {
    throw clientError('invalid_result');
  }
  if (params.mode === 'url') {
    const url = params.url;
    if (typeof url !== 'string' || !URL.canParse(url)) {
      throw clientError('invalid_result');
    }
    const parsed = new URL(url);
    const secure =
      parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback(parsed.hostname));
    if (!secure) {
      throw clientError('invalid_result');
    }
    return Object.freeze({ mode: 'url', key, message: params.message, url: parsed.href });
  }
  if ((params.mode !== undefined && params.mode !== 'form') || !isRecord(params.requestedSchema)) {
    throw clientError('invalid_result');
  }
  return Object.freeze({
    mode: 'form',
    key,
    message: params.message,
    schema: frozenJson(params.requestedSchema),
  });
}

function isElicitValue(value: unknown): value is McpElicitValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return Array.isArray(value) && (value as unknown[]).every((item) => typeof item === 'string');
}

/** An elicitation answer as the wire carries it. */
type WireReply = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
};

/**
 * `content` with every field the user left out filled from the form's own
 * `default` (SEP-1034: a field shown pre-filled and accepted unchanged is
 * answered with its default). A default that is not a form value is ignored;
 * the schema check that follows decides whether the answer is complete.
 */
export function withDefaults(
  content: Record<string, string | number | boolean | string[]>,
  schema: Readonly<Record<string, JsonValue>>,
): Record<string, string | number | boolean | string[]> {
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return content;
  }
  for (const [name, field] of Object.entries(properties)) {
    if (Object.hasOwn(content, name) || !isRecord(field) || !Object.hasOwn(field, 'default')) {
      continue;
    }
    const fallback: unknown = field.default;
    if (isElicitValue(fallback)) {
      // Defined, not assigned: the field name is remote text and may be `__proto__`.
      Object.defineProperty(content, name, {
        value: Array.isArray(fallback) ? [...(fallback as string[])] : fallback,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return content;
}

/** The wire answer for a handler's reply, checked against the request. */
function wireReply(request: McpElicitation, reply: unknown): WireReply {
  if (!isRecord(reply)) {
    throw clientError('elicit_failed');
  }
  if (reply.action === 'decline' || reply.action === 'cancel') {
    return { action: reply.action };
  }
  if (reply.action !== 'accept') {
    throw clientError('elicit_failed');
  }
  if (request.mode === 'url') {
    return { action: 'accept' };
  }
  const content = reply.content;
  if (!isRecord(content) || !Object.values(content).every(isElicitValue)) {
    throw clientError('elicit_failed');
  }
  const copy = withDefaults(
    deepCloneJson(content as Record<string, string | number | boolean | string[]>),
    request.schema,
  );
  let valid: boolean;
  try {
    valid = new AjvJsonSchemaValidator().getValidator(deepCloneJson(request.schema))(copy).valid;
  } catch (cause) {
    throw clientError('invalid_result', { cause });
  }
  if (!valid) {
    throw clientError('elicit_failed');
  }
  return { action: 'accept', content: copy };
}

/** A tool result the server sent, checked: content re-validated, structured output plain JSON. */
function checkedResult(result: CallToolResult): {
  readonly content: readonly McpContent[];
  readonly structured: JsonValue | undefined;
} {
  try {
    const content = deepFreeze(wireContentList(result.content ?? []));
    const raw: unknown = result.structuredContent;
    const structured =
      raw === undefined ? undefined : deepFreeze(JSON.parse(strictJson(raw)) as JsonValue);
    return { content, structured };
  } catch (cause) {
    if (cause instanceof InvalidContentError) {
      throw clientError('invalid_result', { cause });
    }
    throw cause;
  }
}

/** The marker for a call that needs input the client cannot give. */
const NEEDS_INPUT = Symbol('needs-input');

/** An abort signal that fires when any of `signals` does. */
function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) {
    return present[0];
  }
  return AbortSignal.any(present);
}

/**
 * Wrap a connected SDK client. `onClosed` runs once when the connection
 * closes (the in-memory server's teardown).
 */
export function remoteServer(
  client: Client,
  settings: ClientSettings,
  guard: MessageGuard,
  onClosed: () => Promise<void>,
): McpRemoteServer {
  const era = client.getProtocolEra() === 'modern' ? 'modern' : 'legacy';
  const version = client.getServerVersion();
  const info: McpServerInfo = Object.freeze({
    name: optionalText(version?.name),
    version: optionalText(version?.version),
    title: optionalText(version?.title),
    protocolVersion: client.getNegotiatedProtocolVersion() ?? MODERN_REVISION,
    era,
    instructions: optionalText(client.getInstructions()),
    capabilities: frozenJson(client.getServerCapabilities() ?? {}),
  });
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  let tools: ToolIndex | undefined;
  let toolsLoading: Promise<ToolIndex> | undefined;

  const previousOnClose = client.onclose;
  client.onclose = () => {
    previousOnClose?.();
    lifetime.abort();
  };

  function assertOpen(): void {
    if (lifetime.signal.aborted) {
      throw clientError('closed');
    }
  }

  function requestOptions(options: McpCallOptions | undefined): RequestOptions {
    const timeout = boundedInteger(
      options?.timeoutMs,
      settings.timeoutMs,
      'timeoutMs',
      MAX_TIMEOUT_MS,
    );
    if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw invalidOption('signal', 'must be an AbortSignal');
    }
    const signal = options?.signal;
    return { timeout, ...(signal === undefined ? {} : { signal }) };
  }

  async function guarded<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    assertOpen();
    if (signal?.aborted === true) {
      throw clientError('aborted');
    }
    try {
      return await work();
    } catch (error) {
      if (lifetime.signal.aborted && !(error instanceof McpClientError)) {
        throw clientError('closed', { cause: error });
      }
      throw translate(error, 'request', guard, signal);
    }
  }

  async function walk<T>(
    method: 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list',
    pick: (page: Record<string, unknown>) => unknown,
    options: McpCallOptions | undefined,
  ): Promise<T[]> {
    const sendOptions = requestOptions(options);
    return guarded(async () => {
      const items: T[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result: Record<string, unknown> = await client.request(
          { method, params: cursor === undefined ? {} : { cursor } },
          sendOptions,
        );
        const picked = pick(result);
        if (!Array.isArray(picked)) {
          throw clientError('invalid_result');
        }
        items.push(...(picked as T[]));
        const next = result.nextCursor;
        if (next === undefined) {
          return items;
        }
        if (typeof next !== 'string' || cursors.has(next)) {
          throw clientError('invalid_result');
        }
        cursors.add(next);
        cursor = next;
      }
      throw clientError('invalid_result');
    }, sendOptions.signal);
  }

  async function loadTools(options: McpCallOptions | undefined): Promise<ToolIndex> {
    if (client.getServerCapabilities()?.tools === undefined) {
      return { list: Object.freeze([]), byName: new Map() };
    }
    const raw = await walk<Tool>('tools/list', (page) => page.tools, options);
    const index = indexTools(raw, settings.onToolExcluded);
    tools = index;
    return index;
  }

  async function knownTools(options: McpCallOptions | undefined): Promise<ToolIndex> {
    if (tools !== undefined) {
      return tools;
    }
    toolsLoading ??= loadTools(options).finally(() => {
      toolsLoading = undefined;
    });
    return toolsLoading;
  }

  async function answer(
    request: McpElicitation,
    signal: AbortSignal | undefined,
  ): Promise<WireReply> {
    const elicit = settings.elicit;
    if (elicit === undefined) {
      throw clientError('input_required');
    }
    const handlerSignal = anySignal([signal, lifetime.signal]) ?? lifetime.signal;
    let reply: unknown;
    try {
      reply = await elicit(request, { signal: handlerSignal });
    } catch (cause) {
      if (handlerSignal.aborted) {
        throw clientError(lifetime.signal.aborted ? 'closed' : 'aborted', { cause });
      }
      throw clientError('elicit_failed', { cause });
    }
    return wireReply(request, reply);
  }

  /**
   * Send a request that may answer `input_required`, answering and retrying
   * until it completes, the round limit is hit, or input cannot be given.
   */
  async function withInput(
    params: Record<string, unknown>,
    sendOptions: RequestOptions,
    send: (params: Record<string, unknown>, options: RequestOptions) => Promise<unknown>,
  ): Promise<unknown> {
    let current = params;
    for (let round = 0; ; round += 1) {
      let result: unknown;
      try {
        result = await send(current, { ...sendOptions, allowInputRequired: true });
      } catch (error) {
        // A 2026-07-28 server refuses with -32021 instead of asking for input
        // the client declared no capability for: the same situation as an
        // input request this client cannot answer.
        if (
          error instanceof ProtocolError &&
          error.code === Number(ProtocolErrorCode.MissingRequiredClientCapability)
        ) {
          return NEEDS_INPUT;
        }
        throw error;
      }
      if (!isRecord(result) || result.resultType !== 'input_required') {
        return result;
      }
      if (round >= settings.maxInputRounds) {
        throw clientError('input_rounds_exceeded');
      }
      const requests = result.inputRequests ?? {};
      const state = result.requestState;
      if (!isRecord(requests) || (state !== undefined && typeof state !== 'string')) {
        throw clientError('invalid_result');
      }
      const entries = Object.entries(requests);
      const elicitations = entries.map(([key, request]) => elicitationOf(request, key));
      if (
        entries.length > 0 &&
        (settings.elicit === undefined || elicitations.some((item) => item === undefined))
      ) {
        return NEEDS_INPUT;
      }
      const responses: Record<string, WireReply> = {};
      for (const [index, [key]] of entries.entries()) {
        const elicitation = elicitations[index];
        if (elicitation !== undefined) {
          responses[key] = await answer(elicitation, sendOptions.signal);
        }
      }
      current = {
        ...params,
        ...(entries.length === 0 ? {} : { inputResponses: responses }),
        ...(state === undefined ? {} : { requestState: state }),
      };
    }
  }

  const remote: McpRemoteServer = {
    info,

    async listTools(options) {
      assertOpen();
      return (await loadTools(options)).list;
    },

    async callTool(name, args = {}, options = {}) {
      assertOpen();
      if (typeof name !== 'string' || name.length === 0) {
        throw invalidOption('name', 'must be a non-empty string');
      }
      let wireArgs: Record<string, unknown>;
      try {
        wireArgs = JSON.parse(strictJson(args)) as Record<string, unknown>;
      } catch (_notJson) {
        throw invalidOption('args', 'must be a JSON object');
      }
      if (!isRecord(wireArgs)) {
        throw invalidOption('args', 'must be a JSON object');
      }
      if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
        throw invalidOption('onProgress', 'must be a function');
      }
      const sendOptions = requestOptions(options);
      const cached = tools;
      let entry = (cached ?? (await knownTools(options))).byName.get(name);
      if (entry === undefined && cached !== undefined) {
        entry = (await loadTools(options)).byName.get(name);
      }
      if (entry === undefined) {
        throw clientError('unknown_tool');
      }
      const onProgress = options.onProgress;
      let last = -Infinity;
      const legOptions: RequestOptions = {
        ...sendOptions,
        ...(onProgress === undefined
          ? {}
          : {
              onprogress: (progress) => {
                const value = progress.progress;
                if (!Number.isFinite(value) || value <= last) {
                  return;
                }
                last = value;
                const total =
                  typeof progress.total === 'number' && Number.isFinite(progress.total)
                    ? progress.total
                    : undefined;
                onProgress(value, total, optionalText(progress.message));
              },
            }),
      };
      const definition = entry.definition;
      const result = await guarded(
        () =>
          withInput({ name, arguments: wireArgs }, legOptions, (params, legs) =>
            client.callTool(params as { name: string; arguments: Record<string, unknown> }, {
              ...legs,
              toolDefinition: definition,
            }),
          ),
        sendOptions.signal,
      );
      if (result === NEEDS_INPUT) {
        return Object.freeze({ status: 'input_required' });
      }
      const checked = checkedResult(result as CallToolResult);
      if ((result as CallToolResult).isError === true) {
        // A server that cannot carry its input request on this connection
        // (a 2025 one without the elicitation modes it needs, or stateless
        // HTTP) says so with this code; it is the same outcome as a modern
        // request this client cannot answer.
        if (isRecord(checked.structured) && checked.structured.code === 'input_unavailable') {
          return Object.freeze({ status: 'input_required' });
        }
        return Object.freeze({ status: 'tool_error', ...checked });
      }
      if (entry.validate !== undefined) {
        if (
          checked.structured === undefined ||
          !entry.validate(deepCloneJson(checked.structured))
        ) {
          throw clientError('invalid_result');
        }
      }
      return Object.freeze({ status: 'ok', ...checked });
    },

    async listResources(options) {
      assertOpen();
      if (client.getServerCapabilities()?.resources === undefined) {
        return Object.freeze([]);
      }
      const raw = await walk<Record<string, unknown>>(
        'resources/list',
        (page) => page.resources,
        options,
      );
      return Object.freeze(
        raw.map((resource) =>
          Object.freeze({
            uri: String(resource.uri),
            name: String(resource.name),
            title: optionalText(resource.title),
            description: optionalText(resource.description),
            mimeType: optionalText(resource.mimeType),
          }),
        ),
      );
    },

    async listResourceTemplates(options) {
      assertOpen();
      if (client.getServerCapabilities()?.resources === undefined) {
        return Object.freeze([]);
      }
      const raw = await walk<Record<string, unknown>>(
        'resources/templates/list',
        (page) => page.resourceTemplates,
        options,
      );
      return Object.freeze(
        raw.map((template) =>
          Object.freeze({
            uriTemplate: String(template.uriTemplate),
            name: String(template.name),
            title: optionalText(template.title),
            description: optionalText(template.description),
            mimeType: optionalText(template.mimeType),
          }),
        ),
      );
    },

    async readResource(uri, options) {
      assertOpen();
      if (typeof uri !== 'string' || !URL.canParse(uri)) {
        throw invalidOption('uri', 'must be an absolute URI');
      }
      const sendOptions = requestOptions(options);
      const result = await guarded(
        () =>
          withInput({ uri }, sendOptions, (params, legs) =>
            client.request({ method: 'resources/read', params }, legs),
          ),
        sendOptions.signal,
      );
      if (result === NEEDS_INPUT) {
        throw clientError('input_required');
      }
      const contents = isRecord(result) ? result.contents : undefined;
      if (!Array.isArray(contents)) {
        throw clientError('invalid_result');
      }
      try {
        return deepFreeze((contents as unknown[]).map((body) => wireResourceContent(body)));
      } catch (cause) {
        throw clientError('invalid_result', { cause });
      }
    },

    async listPrompts(options) {
      assertOpen();
      if (client.getServerCapabilities()?.prompts === undefined) {
        return Object.freeze([]);
      }
      const raw = await walk<Record<string, unknown>>(
        'prompts/list',
        (page) => page.prompts,
        options,
      );
      return Object.freeze(
        raw.map((prompt) =>
          Object.freeze({
            name: String(prompt.name),
            title: optionalText(prompt.title),
            description: optionalText(prompt.description),
            arguments: Object.freeze(
              (Array.isArray(prompt.arguments) ? (prompt.arguments as unknown[]) : [])
                .filter(isRecord)
                .map((argument) =>
                  Object.freeze({
                    name: String(argument.name),
                    description: optionalText(argument.description),
                    required: argument.required === true,
                  }),
                ),
            ),
          }),
        ),
      );
    },

    async getPrompt(name, args = {}, options) {
      assertOpen();
      if (typeof name !== 'string' || name.length === 0) {
        throw invalidOption('name', 'must be a non-empty string');
      }
      if (!isRecord(args) || !Object.values(args).every((value) => typeof value === 'string')) {
        throw invalidOption('args', 'must map argument names to strings');
      }
      const sendOptions = requestOptions(options);
      const result = await guarded(
        () =>
          withInput({ name, arguments: { ...args } }, sendOptions, (params, legs) =>
            client.request({ method: 'prompts/get', params }, legs),
          ),
        sendOptions.signal,
      );
      if (result === NEEDS_INPUT) {
        throw clientError('input_required');
      }
      const messages = isRecord(result) ? result.messages : undefined;
      if (!Array.isArray(messages)) {
        throw clientError('invalid_result');
      }
      try {
        return deepFreeze(
          (messages as unknown[]).map((message) => {
            if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) {
              throw new InvalidContentError('a prompt message needs a user or assistant role');
            }
            return { role: message.role, content: wireContent(message.content) };
          }),
        );
      } catch (cause) {
        throw clientError('invalid_result', { cause });
      }
    },

    async close() {
      closing ??= (async () => {
        lifetime.abort();
        try {
          await client.close();
        } finally {
          await onClosed();
        }
      })();
      return closing;
    },
  };
  return Object.freeze(remote);
}

/** The client capabilities to declare: elicitation (form and URL) only with a handler. */
function capabilitiesFor(settings: ClientSettings): ClientCapabilities {
  return settings.elicit === undefined ? {} : { elicitation: { form: {}, url: {} } };
}

/**
 * Connect an SDK client over `transport` and wrap it. On failure the
 * transport is closed and `onClosed` runs before the error is thrown.
 */
export async function openRemote(
  transport: Transport,
  settings: ClientSettings,
  guard: MessageGuard,
  onClosed: () => Promise<void> = () => Promise.resolve(),
): Promise<McpRemoteServer> {
  const client = new Client(settings.clientInfo, {
    capabilities: capabilitiesFor(settings),
    versionNegotiation: {
      mode:
        settings.protocol === 'modern'
          ? { pin: MODERN_REVISION }
          : settings.protocol === 'legacy'
            ? 'legacy'
            : 'auto',
    },
    inputRequired: { autoFulfill: false },
  });
  if (settings.elicit !== undefined) {
    client.setRequestHandler('elicitation/create', async (request, ctx) => {
      const elicitation = elicitationParams(request.params, undefined);
      const elicit = settings.elicit;
      if (elicit === undefined) {
        throw clientError('input_required');
      }
      // The SDK answers the server with a handler error's message, so only a
      // value-free error of ours may leave this handler.
      let reply: unknown;
      try {
        reply = await elicit(elicitation, { signal: ctx.mcpReq.signal });
      } catch (cause) {
        throw clientError('elicit_failed', { cause });
      }
      return wireReply(elicitation, reply);
    });
  }
  const replies = new ConnectReplies(transport);
  try {
    settings.signal?.throwIfAborted();
    await client.connect(transport, {
      timeout: settings.timeoutMs,
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });
  } catch (error) {
    replies.release();
    // The connect failure is what the caller needs; a failing teardown adds nothing.
    await client.close().catch(() => undefined);
    await onClosed();
    throw translate(error, 'connect', guard, settings.signal, replies);
  }
  replies.release();
  guard.install(transport);
  return remoteServer(client, settings, guard, onClosed);
}

/**
 * Connect to a remote MCP server. Throws {@link McpClientError} with
 * `invalid_option` for malformed options, and with `connect_failed`,
 * `unsupported_protocol`, `unauthorized`, `forbidden`, `credentials_failed`,
 * `timeout`, or `aborted` when the connection cannot be opened.
 */
export async function connectMcp(options: McpClientOptions): Promise<McpRemoteServer> {
  const settings = checkRemoteOptions(options, ['transport']);
  const transport = checkTransport(options.transport);
  const guard = new MessageGuard(settings.maxResultBytes);
  return openRemote(sdkTransport(transport, settings.maxResultBytes, guard), settings, guard);
}
