/**
 * The server factory: one defined server plus serving options in, a fresh SDK
 * `McpServer` per serving unit out (one HTTP request, one stdio connection).
 *
 * `tools/call` and `prompts/get` are served by the factory's own request
 * handlers (registered after the items, which keep their SDK registration for
 * listing, header validation, and scope challenges), so every refusal they
 * make, from an unknown name to a rejected request state, is an error the
 * factory phrases itself, never one that echoes the caller's input.
 *
 * Multi-round-trip input: a handler may return `inputRequired(...)`. Its state
 * is sealed with {@link createStateSeal} under a binding of the actor, the
 * credential, the method, the target, and the arguments, and a retry's state
 * is opened under the same binding before the handler runs. Units on a
 * stateless legacy channel cannot carry input at all and answer with a
 * value-free failure; connected legacy units (stdio) let the SDK's legacy shim
 * ask the client with server-to-client requests, when the client declared the
 * elicitation modes asked for, and answer with the same failure otherwise. A
 * tool's confirmation answer counts only on the retry of the round that asked
 * it, as the sealed state records, so a client cannot pre-fill it.
 *
 * Per unit the factory asks the injected gate about every non-public item
 * once, then registers only what the actor may see, in the definition's
 * order, from descriptors precomputed at define time. A hidden item is simply
 * not registered, so calling it fails byte for byte like calling a name that
 * never existed. A challenged item is registered with the SDK's scope
 * challenge, so the HTTP entry answers `403 insufficient_scope` before any
 * handler runs; on transports without HTTP the call fails with an
 * `insufficient_scope` error instead.
 *
 * Every handler runs under a deadline and the request's abort signal, and
 * nothing a handler does reaches the SDK's own error path, which would send a
 * raw `error.message`: a {@link McpToolFailure} becomes a tool error with its
 * code and message, invalid arguments become a value-free `invalid_arguments`
 * tool error, and anything else (a throw, a malformed or oversized result, a
 * timeout) becomes a generic failure on the wire and a {@link McpServingError}
 * on the operator's `onError` hook.
 */

import {
  inputRequired as sdkInputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  UriTemplate,
  type CallToolResult,
  type GetPromptResult,
  type InputRequiredResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type ServerCapabilities,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { Awaitable } from 'jsails/plugin-sdk';
import { isRecord } from 'jsails/plugin-sdk';

import {
  checkDecision,
  isPublicAccess,
  type CheckedDecision,
  type McpActor,
  type McpAuthorize,
  type McpScopes,
} from './access.js';
import {
  answerReader,
  clientInfoOf,
  progressReporter,
  type McpCallContext,
} from './call-context.js';
import {
  InvalidContentError,
  isAbsoluteUri,
  isToolResult,
  jsonByteLength,
  strictJson,
  wireContentList,
  wireResourceContent,
  type JsonValue,
  type WireContent,
} from './content.js';
import {
  itemName,
  serverRecord,
  type McpCompleter,
  type McpServerDefinition,
  type PromptRecord,
  type ResourceRecord,
  type ServerRecord,
  type TemplateRecord,
  type ToolRecord,
} from './definitions.js';
import {
  isSendableFailure,
  McpDefinitionError,
  McpServingError,
  McpToolFailure,
  type McpServingErrorCode,
  type McpServingSite,
  type McpToolErrorCode,
} from './errors.js';
import {
  CONFIRM_KEY,
  confirmationRequest,
  inputRequiredRecord,
  type InputRequiredRecord,
} from './input-required.js';
import {
  createStateSeal,
  invalidRequestState,
  MAX_SEALED_ROUNDS,
  type InputMethod,
  type SealedPayload,
  type StateBinding,
} from './request-state.js';
import { validateValue } from './schema-projection.js';
import { decodeVariables } from './uri-template.js';

/** One serving unit: who is calling, over what, and which protocol era it serves. */
export interface McpServingUnit {
  readonly actor: McpActor;
  readonly era: 'modern' | 'legacy';
  /** The identifier of the credential the actor presented, bound into request state. */
  readonly credential?: string;
  /**
   * `connected` (the default: stdio, in-memory) can carry server-to-client
   * requests, so a legacy unit's input requests are asked by the SDK's legacy
   * shim. `stateless` (HTTP) cannot; a legacy unit there refuses input
   * requests with a value-free failure.
   */
  readonly channel?: 'connected' | 'stateless';
  /** Told the scopes of a challenged item when a request for it is refused with a challenge. */
  readonly onChallenge?: (scopes: McpScopes) => void;
}

/** How the factory serves a definition. */
export interface McpServingOptions {
  /** The gate for non-public items. Required when the server has any. */
  readonly authorize?: McpAuthorize;
  /** Receives every operator-audience failure. Defaults to `console.error`; must not throw. */
  readonly onError?: (error: McpServingError) => void;
  /** The largest result (tool result, resource contents, prompt messages) sent, in UTF-8 bytes of JSON. Default 1 MiB. */
  readonly maxResultBytes?: number;
  /** The handler deadline when a tool sets none, and for every other handler. Default 30 s. */
  readonly timeoutMs?: number;
  /** The most array elements plus object members one `tools/call` may carry. Default 10 000. */
  readonly maxToolInputElements?: number;
  /**
   * The key request state is sealed with, at least 32 bytes. Every process
   * that may receive a retry needs the same key; a fresh random key per
   * factory is used when omitted, which suits one process (stdio) only.
   */
  readonly requestStateKey?: Uint8Array;
  /** How long sealed request state stays valid, in seconds. Default 600. */
  readonly requestStateTtlSeconds?: number;
  /**
   * Input rounds per call, on every protocol era, before the call fails with
   * `too_many_input_rounds` (a protocol error for resources and prompts).
   * Default 8.
   */
  readonly maxInputRounds?: number;
}

/** Builds a fresh SDK server for one serving unit. */
export type McpServerFactory = (unit: McpServingUnit) => Promise<McpServer>;

const DEFAULT_MAX_RESULT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOL_INPUT_ELEMENTS = 10_000;
const DEFAULT_MAX_INPUT_ROUNDS = 8;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_COMPLETIONS = 100;

/** Reports one operator-audience serving failure. */
export type Report = (
  code: McpServingErrorCode,
  message: string,
  site: Site,
  cause?: unknown,
) => void;

/** Where a serving failure happened. */
export interface Site {
  readonly kind: McpServingSite;
  readonly name: string;
}

function positiveInteger(value: unknown, fallback: number, field: string, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new McpDefinitionError('invalid_option', `${field} must be a positive integer`, {
      option: field,
    });
  }
  return value;
}

/** The serving reporter: `onError`, or `console.error`; a throwing hook becomes a process warning. */
export function reporter(onError: McpServingOptions['onError']): Report {
  const sink =
    onError ??
    ((error: McpServingError) => {
      console.error(error);
    });
  return (code, message, site, cause) => {
    try {
      sink(new McpServingError(code, message, site, cause));
    } catch (_reporterFailure) {
      process.emitWarning('The MCP onError hook threw; a serving error was not reported.', {
        code: 'JSAILS_MCP_REPORTER_FAILED',
      });
    }
  };
}

type Outcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'thrown'; readonly error: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/**
 * Run `work` under the request signal and a deadline. The returned promise
 * settles when the work settles or the signal fires, whichever is first; a
 * late settlement of abandoned work is absorbed.
 */
async function bounded(
  work: (signal: AbortSignal) => Awaitable<unknown>,
  requestSignal: AbortSignal,
  timeoutMs: number,
): Promise<Outcome> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([requestSignal, deadline]);
  if (signal.aborted) {
    return { kind: 'aborted' };
  }
  let stop: () => void = () => undefined;
  const stopped = new Promise<Outcome>((resolve) => {
    stop = () => {
      resolve(requestSignal.aborted ? { kind: 'aborted' } : { kind: 'timeout' });
    };
    signal.addEventListener('abort', stop, { once: true });
  });
  const settled = (async (): Promise<Outcome> => {
    try {
      return { kind: 'value', value: await work(signal) };
    } catch (error) {
      return { kind: 'thrown', error };
    }
  })();
  try {
    return await Promise.race([settled, stopped]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

function internalError(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InternalError, 'Internal error');
}

function insufficientScope(scopes: McpScopes): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Insufficient scope', {
    reason: 'insufficient_scope',
    scopes: [...scopes],
  });
}

function failureResult(
  code: string,
  message: string,
  extra?: Readonly<Record<string, unknown>>,
): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message, ...extra },
    isError: true,
  };
}

/** A tool error the serving layer phrases itself, with one of its fixed codes. */
function toolFailure(
  code: McpToolErrorCode,
  message: string,
  extra?: Readonly<Record<string, unknown>>,
): CallToolResult {
  return failureResult(code, message, extra);
}

const GENERIC_TOOL_FAILURE = (): CallToolResult => toolFailure('tool_failed', 'The tool failed.');

function invalidArguments(paths: readonly string[]): CallToolResult {
  return toolFailure('invalid_arguments', `Invalid arguments at: ${paths.join(', ')}.`);
}

/** One fixed text for a hidden and a nonexistent tool alike; the caller's name is never echoed. */
function toolNotFound(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
}

/** As {@link toolNotFound}, for prompts. */
function promptNotFound(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown prompt');
}

function tooManyRounds(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    'The request asked for input more times than allowed',
  );
}

const TOO_MANY_ROUNDS = (): CallToolResult =>
  toolFailure('too_many_input_rounds', 'The tool asked for input more times than allowed.');

function inputUnavailable(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    'Input is required, but this connection cannot carry input requests',
    { reason: 'input_unavailable' },
  );
}

/**
 * True when the client declared every elicitation mode `requests` uses. A
 * state-only round (no requests) needs no capability.
 */
function modesDeclared(
  requests: InputRequiredRecord['requests'],
  declared: { readonly form: boolean; readonly url: boolean },
): boolean {
  return Object.values(requests ?? {}).every((request) => {
    const params: unknown = request.params;
    return isRecord(params) && params.mode === 'url' ? declared.url : declared.form;
  });
}

/** Count array elements and object members, stopping once past `max`. */
function elementCount(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      count += 1;
      if (count > max) {
        return count;
      }
      stack.push(child);
    }
  }
  return count;
}

/** Map a tool handler's return value to a wire result; throws InvalidContentError. */
async function toolResultOf(tool: ToolRecord, value: unknown): Promise<CallToolResult> {
  let content: WireContent[] = [];
  let structured: unknown;
  let hasStructured = false;
  if (isToolResult(value)) {
    if (value.content !== undefined) {
      content = wireContentList(value.content);
    }
    hasStructured = value.structured !== undefined;
    structured = value.structured;
  } else if (tool.output !== undefined) {
    hasStructured = value !== undefined;
    structured = value;
  } else if (typeof value === 'string') {
    content = [{ type: 'text', text: value }];
  } else if (value !== undefined) {
    content = [{ type: 'text', text: strictJson(value) }];
  }
  if (tool.output !== undefined) {
    if (!hasStructured) {
      throw new InvalidContentError(
        'the tool declares an output schema but returned no structured output',
      );
    }
    const checked = await validateValue(tool.output.schema, structured);
    if (!checked.ok) {
      throw new InvalidContentError('the structured output does not match the output schema');
    }
    structured = checked.value;
  }
  if (!hasStructured) {
    return { content };
  }
  const json = strictJson(structured);
  if (!content.some((block) => block.type === 'text')) {
    content = [...content, { type: 'text', text: json }];
  }
  const structuredContent: unknown = JSON.parse(json);
  return { content, structuredContent };
}

function resourceContentsOf(
  value: unknown,
  uri: string,
  mimeType: string | undefined,
): ReadResourceResult {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidContentError('a resource read must return a non-empty array of bodies');
  }
  const bodies: unknown[] = value;
  return { contents: bodies.map((body) => wireResourceContent(body, uri, mimeType)) };
}

function promptMessagesOf(value: unknown): GetPromptResult {
  if (!Array.isArray(value)) {
    throw new InvalidContentError('a prompt must render an array of messages');
  }
  const messages: unknown[] = value;
  return {
    messages: messages.map((message) => {
      if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) {
        throw new InvalidContentError('a prompt message needs a user or assistant role');
      }
      const [content] = wireContentList([message.content]);
      if (content === undefined) {
        throw new InvalidContentError('a prompt message needs content');
      }
      return { role: message.role, content };
    }),
  };
}

function listedResourcesOf(value: unknown, matcher: UriTemplate): ListResourcesResult {
  if (!Array.isArray(value)) {
    throw new InvalidContentError('a template list must return an array');
  }
  const entries: unknown[] = value;
  return {
    resources: entries.map((entry) => {
      if (!isRecord(entry) || !isAbsoluteUri(entry.uri) || matcher.match(entry.uri) === null) {
        throw new InvalidContentError('a listed resource needs a URI matching its template');
      }
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new InvalidContentError('a listed resource needs a name');
      }
      const optional = (field: 'title' | 'description' | 'mimeType') => {
        const fieldValue = entry[field];
        if (fieldValue !== undefined && typeof fieldValue !== 'string') {
          throw new InvalidContentError('a listed resource field must be a string');
        }
        return fieldValue === undefined ? {} : { [field]: fieldValue };
      };
      return {
        uri: entry.uri,
        name: entry.name,
        ...optional('title'),
        ...optional('description'),
        ...optional('mimeType'),
      };
    }),
  };
}

type AnyRecord = ToolRecord | ResourceRecord | TemplateRecord | PromptRecord;

type PromptRenderer = (
  args: unknown,
  ctx: ServerContext,
) => Promise<GetPromptResult | InputRequiredResult>;

async function decide(
  records: readonly AnyRecord[],
  actor: McpActor,
  authorize: McpAuthorize | undefined,
  report: Report,
): Promise<Map<AnyRecord, CheckedDecision>> {
  const decisions = new Map<AnyRecord, CheckedDecision>();
  await Promise.all(
    records.map(async (record) => {
      if (isPublicAccess(record.access)) {
        decisions.set(record, { kind: 'allow' });
        return;
      }
      const site = { kind: record.kind, name: itemName(record) };
      let answer: unknown;
      try {
        answer = await authorize?.(
          { kind: record.kind, name: site.name, access: record.access },
          actor,
        );
      } catch (error) {
        report('gate_failed', 'the authorize gate threw; the item is hidden', site, error);
        decisions.set(record, { kind: 'hidden' });
        return;
      }
      const decision = checkDecision(answer);
      if (decision === undefined) {
        report(
          'invalid_gate_decision',
          'the authorize gate answered something malformed; the item is hidden',
          site,
        );
      }
      decisions.set(record, decision ?? { kind: 'hidden' });
    }),
  );
  return decisions;
}

function capabilitiesOf(record: ServerRecord): ServerCapabilities {
  return {
    ...(record.tools.length > 0 ? { tools: { listChanged: false } } : {}),
    ...(record.resources.length > 0 || record.templates.length > 0
      ? { resources: { listChanged: false } }
      : {}),
    ...(record.prompts.length > 0 ? { prompts: { listChanged: false } } : {}),
    ...(record.completions ? { completions: {} } : {}),
  };
}

function wireMetadata(record: ResourceRecord | TemplateRecord): {
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: NonNullable<ResourceRecord['icons']>;
} {
  return {
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
    ...(record.icons === undefined ? {} : { icons: record.icons }),
  };
}

/**
 * Create the per-unit factory for a defined server. Throws
 * {@link McpDefinitionError} when `server` is not a `defineMcpServer` result,
 * when an option is malformed, or when the server has non-public items and no
 * gate.
 */
export function createMcpServerFactory(
  server: McpServerDefinition,
  options: McpServingOptions = {},
): McpServerFactory {
  const found = serverRecord(server);
  if (found === undefined) {
    throw new McpDefinitionError(
      'invalid_definition',
      'the server must be a defineMcpServer result',
    );
  }
  const record: ServerRecord = found;
  const maxResultBytes = positiveInteger(
    options.maxResultBytes,
    DEFAULT_MAX_RESULT_BYTES,
    'maxResultBytes',
    Number.MAX_SAFE_INTEGER,
  );
  const defaultTimeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'timeoutMs',
    MAX_TIMEOUT_MS,
  );
  const maxToolInputElements = positiveInteger(
    options.maxToolInputElements,
    DEFAULT_MAX_TOOL_INPUT_ELEMENTS,
    'maxToolInputElements',
    Number.MAX_SAFE_INTEGER,
  );
  const maxInputRounds = positiveInteger(
    options.maxInputRounds,
    DEFAULT_MAX_INPUT_ROUNDS,
    'maxInputRounds',
    MAX_SEALED_ROUNDS,
  );
  if (options.authorize !== undefined && typeof options.authorize !== 'function') {
    throw new McpDefinitionError('invalid_option', 'authorize must be a function', {
      option: 'authorize',
    });
  }
  if (record.gated && options.authorize === undefined) {
    throw new McpDefinitionError(
      'missing_gate',
      'the server has items with non-public access, so serving it needs an authorize gate',
    );
  }
  const seal = createStateSeal({
    ...(options.requestStateKey === undefined ? {} : { key: options.requestStateKey }),
    ...(options.requestStateTtlSeconds === undefined
      ? {}
      : { ttlSeconds: options.requestStateTtlSeconds }),
  });
  const authorize = options.authorize;
  const report = reporter(options.onError);
  const everything: readonly AnyRecord[] = [
    ...record.tools,
    ...record.resources,
    ...record.templates,
    ...record.prompts,
  ];
  const capabilities = capabilitiesOf(record);
  const cacheHints = {
    'tools/list': record.listCache.tools,
    'resources/list': record.listCache.resources,
    'resources/templates/list': record.listCache.resources,
    'prompts/list': record.listCache.prompts,
  };

  return async (unit) => {
    const decisions = await decide(everything, unit.actor, authorize, report);
    const channel = unit.channel ?? 'connected';
    const carriesInput = unit.era === 'modern' || channel === 'connected';
    const mcp = new McpServer(
      {
        name: record.name,
        version: record.version,
        ...(record.title === undefined ? {} : { title: record.title }),
      },
      {
        capabilities,
        cacheHints,
        inputRequired: { legacyShim: channel === 'connected', maxRounds: maxInputRounds },
        ...(record.instructions === undefined ? {} : { instructions: record.instructions }),
      },
    );

    const contextFor = (
      ctx: ServerContext,
      signal: AbortSignal,
      site: Site,
      state: JsonValue | undefined,
    ): McpCallContext =>
      Object.freeze({
        actor: unit.actor,
        signal,
        client: clientInfoOf(ctx, mcp, unit.era),
        progress: progressReporter(ctx, (cause) => {
          report('handler_failed', 'a progress notification could not be sent', site, cause);
        }),
        answer: answerReader(ctx),
        state: <T extends JsonValue = JsonValue>() => state as T | undefined,
      });

    const run = (
      site: Site,
      ctx: ServerContext,
      timeoutMs: number,
      state: JsonValue | undefined,
      work: (context: McpCallContext) => Awaitable<unknown>,
    ): Promise<Outcome> =>
      bounded((signal) => work(contextFor(ctx, signal, site, state)), ctx.mcpReq.signal, timeoutMs);

    /** Turn a non-value outcome of a resource or prompt handler into a protocol error. */
    const protocolFailure = (
      outcome: Exclude<Outcome, { kind: 'value' }>,
      site: Site,
    ): ProtocolError => {
      if (outcome.kind === 'thrown') {
        report('handler_failed', 'the handler threw', site, outcome.error);
      } else if (outcome.kind === 'timeout') {
        report('timed_out', 'the handler did not finish before its deadline', site);
      }
      return internalError();
    };

    const capped = <T>(result: T, site: Site): T => {
      if (jsonByteLength(result) > maxResultBytes) {
        report('result_too_large', 'the result exceeds maxResultBytes', site);
        throw internalError();
      }
      return result;
    };

    const binding = (method: InputMethod, target: string, args: unknown): StateBinding => ({
      actor: unit.actor,
      credential: unit.credential,
      method,
      target,
      args,
    });

    /**
     * Open the request state a retry carries, if any. A state that fails
     * verification is reported and refused with the frozen `-32602`.
     */
    const openState = async (
      ctx: ServerContext,
      bound: StateBinding,
      site: Site,
    ): Promise<SealedPayload | undefined> => {
      const raw: unknown = ctx.mcpReq.requestState();
      if (raw === undefined) {
        return undefined;
      }
      if (typeof raw !== 'string') {
        throw invalidRequestState();
      }
      const opened = await seal.open(raw, bound, ctx);
      if (!opened.ok) {
        report(
          'request_state_rejected',
          'a request state failed verification',
          site,
          new Error(opened.reason),
        );
        throw invalidRequestState();
      }
      return opened.payload;
    };

    /**
     * True when this unit can carry `input` to the client: always on the
     * modern era (the client answers and retries; the SDK checks the
     * per-request capabilities), never on a stateless legacy channel, and on
     * a connected legacy one only when the client declared every elicitation
     * mode the requests use, so the SDK's legacy shim never answers with its
     * own text.
     */
    const canAsk = (input: InputRequiredRecord, ctx: ServerContext): boolean =>
      carriesInput &&
      (unit.era === 'modern' ||
        modesDeclared(input.requests, clientInfoOf(ctx, mcp, unit.era).elicitation));

    /**
     * Build the wire input-required result. The state is always sealed: it
     * carries the round count, so `maxInputRounds` bounds a modern client's
     * retries the way the legacy shim's `maxRounds` bounds a 2025 connection.
     * Returns `undefined` (after reporting) once the budget is spent.
     */
    const askForInput = async (
      input: InputRequiredRecord,
      bound: StateBinding,
      ctx: ServerContext,
      previous: SealedPayload | undefined,
      flags: { readonly confirmed?: boolean; readonly confirmAsked?: boolean },
      site: Site,
    ): Promise<InputRequiredResult | undefined> => {
      const rounds = (previous?.rounds ?? 0) + 1;
      if (rounds > maxInputRounds) {
        report(
          'input_rounds_exceeded',
          'the handler asked for input more times than allowed',
          site,
        );
        return undefined;
      }
      const payload: SealedPayload = {
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(flags.confirmed === true ? { confirmed: true as const } : {}),
        ...(flags.confirmAsked === true ? { confirmAsked: true as const } : {}),
        rounds,
      };
      return sdkInputRequired({
        ...(input.requests === undefined ? {} : { inputRequests: input.requests }),
        requestState: await seal.seal(payload, bound, ctx),
      });
    };

    const challengeOf = (target: AnyRecord): McpScopes | undefined => {
      const decision = decisions.get(target);
      return decision?.kind === 'challenge' ? decision.scopes : undefined;
    };
    const scopeChallengeFor = (scopes: McpScopes) => () => {
      unit.onChallenge?.(scopes);
      return { scopes };
    };
    const admitted = <R extends AnyRecord>(records: readonly R[]): R[] =>
      records.filter((item) => decisions.get(item)?.kind !== 'hidden');

    const tools = new Map<string, ToolRecord>();
    for (const tool of admitted(record.tools)) {
      tools.set(tool.name, tool);
      registerTool(tool, challengeOf(tool));
    }
    if (record.tools.length > 0) {
      mcp.server.setRequestHandler('tools/call', async (request, ctx) => {
        const tool = tools.get(request.params.name);
        if (tool === undefined) {
          throw toolNotFound();
        }
        return callTool(tool, challengeOf(tool), request.params.arguments, ctx);
      });
    }
    for (const resource of admitted(record.resources)) {
      registerResource(resource, challengeOf(resource));
    }
    const templates = admitted(record.templates);
    for (const template of templates) {
      registerTemplate(template, challengeOf(template));
    }
    const prompts = admitted(record.prompts);
    const renderers = new Map<string, PromptRenderer>();
    for (const prompt of prompts) {
      renderers.set(prompt.name, registerPrompt(prompt, challengeOf(prompt)));
    }
    if (record.prompts.length > 0) {
      // Replaces the SDK's prompts/get, whose unknown-name error echoes the name.
      mcp.server.setRequestHandler('prompts/get', async (request, ctx) => {
        const render = renderers.get(request.params.name);
        if (render === undefined) {
          throw promptNotFound();
        }
        return render(request.params.arguments, ctx);
      });
    }
    if (record.completions) {
      registerCompletion(templates, prompts);
    }
    return mcp;

    function registerTool(tool: ToolRecord, challenge: McpScopes | undefined): void {
      mcp.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputWire,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          ...(tool.output === undefined ? {} : { outputSchema: tool.output.wire }),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          ...(tool.icons === undefined ? {} : { icons: tool.icons }),
          ...(challenge === undefined ? {} : { scopeChallenge: scopeChallengeFor(challenge) }),
        },
        // Calls are served by the factory's own tools/call handler.
        () => GENERIC_TOOL_FAILURE(),
      );
    }

    /**
     * The tool confirmation step: `true` when the call may run, a result when
     * it must stop here (a refusal, or the confirmation request itself).
     */
    async function confirmation(
      tool: ToolRecord,
      input: unknown,
      bound: StateBinding,
      sealed: SealedPayload | undefined,
      ctx: ServerContext,
      site: Site,
    ): Promise<true | CallToolResult | InputRequiredResult> {
      const client = clientInfoOf(ctx, mcp, unit.era);
      if (!carriesInput || !client.elicitation.form) {
        return toolFailure(
          'confirmation_unavailable',
          'The tool needs a confirmation this client cannot give.',
        );
      }
      // An answer counts only on the retry of the round that asked: the
      // sealed state proves the question was put to this caller for this
      // call, so a first request carrying a ready-made answer is asked anyway.
      if (sealed?.confirmAsked === true) {
        const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
        if (answer.kind === 'elicit') {
          return answer.action === 'accept' && answer.content?.confirm === true
            ? true
            : toolFailure('not_confirmed', 'The call was not confirmed.');
        }
      }
      let request;
      try {
        const question: unknown = tool.confirm?.(input);
        if (typeof question !== 'string') {
          throw new InvalidContentError('confirm must return the question as a string');
        }
        request = confirmationRequest(question);
      } catch (error) {
        report('handler_failed', 'the confirm function threw or gave no question', site, error);
        return GENERIC_TOOL_FAILURE();
      }
      return (
        (await askForInput(
          { requests: { [CONFIRM_KEY]: request }, state: undefined },
          bound,
          ctx,
          sealed,
          { confirmAsked: true },
          site,
        )) ?? TOO_MANY_ROUNDS()
      );
    }

    async function callTool(
      tool: ToolRecord,
      challenge: McpScopes | undefined,
      args: unknown,
      ctx: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> {
      const site: Site = { kind: 'tool', name: tool.name };
      if (challenge !== undefined) {
        return toolFailure('insufficient_scope', 'The credential lacks a scope this tool needs.', {
          scopes: [...challenge],
        });
      }
      if (elementCount(args, maxToolInputElements) > maxToolInputElements) {
        return toolFailure('invalid_arguments', 'The arguments hold too many elements.');
      }
      let input: unknown = {};
      if (tool.input === undefined) {
        if (args !== undefined && !(isRecord(args) && Object.keys(args).length === 0)) {
          return invalidArguments(['(root)']);
        }
      } else {
        let checked;
        try {
          checked = await validateValue(tool.input.schema, args ?? {});
        } catch (error) {
          report('handler_failed', 'the input schema threw while validating', site, error);
          return GENERIC_TOOL_FAILURE();
        }
        if (!checked.ok) {
          return invalidArguments(checked.paths);
        }
        input = checked.value;
      }
      const bound = binding('tools/call', tool.name, args ?? {});
      const sealed = await openState(ctx, bound, site);
      let confirmed = sealed?.confirmed === true;
      if (tool.confirm !== undefined && !confirmed) {
        const step = await confirmation(tool, input, bound, sealed, ctx, site);
        if (step !== true) {
          return step;
        }
        confirmed = true;
      }
      const outcome = await run(
        site,
        ctx,
        tool.timeoutMs ?? defaultTimeoutMs,
        sealed?.state,
        (context) => tool.handler(input, context),
      );
      switch (outcome.kind) {
        case 'aborted':
          return toolFailure('aborted', 'The request was cancelled.');
        case 'timeout':
          report('timed_out', 'the handler did not finish before its deadline', site);
          return toolFailure('timed_out', 'The tool did not finish in time.');
        case 'thrown':
          if (outcome.error instanceof McpToolFailure && isSendableFailure(outcome.error)) {
            return failureResult(outcome.error.code, outcome.error.message);
          }
          report('handler_failed', 'the handler threw', site, outcome.error);
          return GENERIC_TOOL_FAILURE();
        case 'value':
          break;
      }
      const needed = inputRequiredRecord(outcome.value);
      if (needed !== undefined) {
        if (!canAsk(needed, ctx)) {
          return toolFailure(
            'input_unavailable',
            'The tool needs input this connection cannot carry.',
          );
        }
        const asked = await askForInput(
          needed,
          bound,
          ctx,
          sealed,
          { confirmed: tool.confirm !== undefined && confirmed },
          site,
        );
        if (asked === undefined) {
          return TOO_MANY_ROUNDS();
        }
        if (jsonByteLength(asked) > maxResultBytes) {
          report('result_too_large', 'the input request exceeds maxResultBytes', site);
          return toolFailure('result_too_large', 'The tool result is too large to send.');
        }
        return asked;
      }
      let result: CallToolResult;
      try {
        result = await toolResultOf(tool, outcome.value);
      } catch (error) {
        report('invalid_result', 'the handler returned a malformed result', site, error);
        return GENERIC_TOOL_FAILURE();
      }
      if (jsonByteLength(result) > maxResultBytes) {
        report('result_too_large', 'the result exceeds maxResultBytes', site);
        return toolFailure('result_too_large', 'The tool result is too large to send.');
      }
      return mcp.server.projectCallToolResult(result, tool.output?.json);
    }

    async function readBodies(
      site: Site,
      ctx: ServerContext,
      uri: URL,
      mimeType: string | undefined,
      challenge: McpScopes | undefined,
      work: (context: McpCallContext) => Awaitable<unknown>,
    ): Promise<ReadResourceResult | InputRequiredResult> {
      if (challenge !== undefined) {
        throw insufficientScope(challenge);
      }
      const bound = binding('resources/read', uri.href, undefined);
      const sealed = await openState(ctx, bound, site);
      const outcome = await run(site, ctx, defaultTimeoutMs, sealed?.state, work);
      if (outcome.kind !== 'value') {
        throw protocolFailure(outcome, site);
      }
      if (outcome.value === null || outcome.value === undefined) {
        throw new ResourceNotFoundError(uri.href);
      }
      const needed = inputRequiredRecord(outcome.value);
      if (needed !== undefined) {
        if (!canAsk(needed, ctx)) {
          throw inputUnavailable();
        }
        const asked = await askForInput(needed, bound, ctx, sealed, {}, site);
        if (asked === undefined) {
          throw tooManyRounds();
        }
        return capped(asked, site);
      }
      let result: ReadResourceResult;
      try {
        result = resourceContentsOf(outcome.value, uri.href, mimeType);
      } catch (error) {
        report('invalid_result', 'the reader returned malformed contents', site, error);
        throw internalError();
      }
      return capped(result, site);
    }

    function registerResource(resource: ResourceRecord, challenge: McpScopes | undefined): void {
      const site: Site = { kind: 'resource', name: resource.uri };
      mcp.registerResource(
        resource.name,
        resource.uri,
        {
          ...wireMetadata(resource),
          ...(resource.cache === undefined ? {} : { cacheHint: resource.cache }),
          ...(challenge === undefined ? {} : { scopeChallenge: scopeChallengeFor(challenge) }),
        },
        (uri, ctx) =>
          readBodies(site, ctx, uri, resource.mimeType, challenge, (context) =>
            resource.read(context),
          ),
      );
    }

    function registerTemplate(template: TemplateRecord, challenge: McpScopes | undefined): void {
      const site: Site = { kind: 'resource-template', name: template.name };
      const matcher = new UriTemplate(template.uriTemplate);
      const list =
        template.list === undefined
          ? undefined
          : async (ctx: ServerContext): Promise<ListResourcesResult> => {
              const listing = template.list;
              if (listing === undefined || challenge !== undefined) {
                return { resources: [] };
              }
              const outcome = await run(site, ctx, defaultTimeoutMs, undefined, (context) =>
                listing(context),
              );
              if (outcome.kind !== 'value') {
                protocolFailure(outcome, site);
                return { resources: [] };
              }
              try {
                return listedResourcesOf(outcome.value, matcher);
              } catch (error) {
                report(
                  'invalid_result',
                  'the template list returned malformed entries',
                  site,
                  error,
                );
                return { resources: [] };
              }
            };
      mcp.registerResource(
        template.name,
        new ResourceTemplate(matcher, { list }),
        {
          ...wireMetadata(template),
          ...(template.cache === undefined ? {} : { cacheHint: template.cache }),
          ...(challenge === undefined ? {} : { scopeChallenge: scopeChallengeFor(challenge) }),
        },
        async (uri, variables, ctx) => {
          if (challenge !== undefined) {
            throw insufficientScope(challenge);
          }
          let params;
          try {
            const decoded = decodeVariables(template.parsed, variables);
            params =
              decoded === undefined
                ? undefined
                : await validateValue(template.params.schema, decoded);
          } catch (error) {
            report('handler_failed', 'the params schema threw while validating', site, error);
            throw internalError();
          }
          if (params === undefined || !params.ok) {
            throw new ResourceNotFoundError(uri.href);
          }
          return readBodies(site, ctx, uri, template.mimeType, challenge, (context) =>
            template.read(params.value, context),
          );
        },
      );
    }

    function registerPrompt(
      prompt: PromptRecord,
      challenge: McpScopes | undefined,
    ): PromptRenderer {
      const site: Site = { kind: 'prompt', name: prompt.name };
      const render: PromptRenderer = async (
        args: unknown,
        ctx: ServerContext,
      ): Promise<GetPromptResult | InputRequiredResult> => {
        if (challenge !== undefined) {
          throw insufficientScope(challenge);
        }
        let input: unknown = {};
        if (prompt.args !== undefined) {
          let checked;
          try {
            checked = await validateValue(prompt.args.schema, args ?? {});
          } catch (error) {
            report('handler_failed', 'the args schema threw while validating', site, error);
            throw internalError();
          }
          if (!checked.ok) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Invalid prompt arguments at: ${checked.paths.join(', ')}.`,
            );
          }
          input = checked.value;
        }
        const bound = binding('prompts/get', prompt.name, args ?? {});
        const sealed = await openState(ctx, bound, site);
        const outcome = await run(site, ctx, defaultTimeoutMs, sealed?.state, (context) =>
          prompt.render(input, context),
        );
        if (outcome.kind !== 'value') {
          throw protocolFailure(outcome, site);
        }
        const needed = inputRequiredRecord(outcome.value);
        if (needed !== undefined) {
          if (!canAsk(needed, ctx)) {
            throw inputUnavailable();
          }
          const asked = await askForInput(needed, bound, ctx, sealed, {}, site);
          if (asked === undefined) {
            throw tooManyRounds();
          }
          return capped(asked, site);
        }
        let result: GetPromptResult;
        try {
          result = promptMessagesOf(outcome.value);
        } catch (error) {
          report('invalid_result', 'the prompt rendered malformed messages', site, error);
          throw internalError();
        }
        return capped(result, site);
      };
      const config = {
        ...(prompt.title === undefined ? {} : { title: prompt.title }),
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        ...(prompt.icons === undefined ? {} : { icons: prompt.icons }),
        ...(challenge === undefined ? {} : { scopeChallenge: scopeChallengeFor(challenge) }),
      };
      // The registration serves listing and the HTTP scope challenge; calls
      // go through the factory's own prompts/get handler.
      if (prompt.args === undefined) {
        mcp.registerPrompt(prompt.name, config, (ctx) => render(undefined, ctx));
      } else {
        mcp.registerPrompt(prompt.name, { ...config, argsSchema: prompt.args.wire }, render);
      }
      return render;
    }

    function registerCompletion(
      admittedTemplates: readonly TemplateRecord[],
      admittedPrompts: readonly PromptRecord[],
    ): void {
      const empty = { completion: { values: [], hasMore: false } };
      mcp.server.setRequestHandler('completion/complete', async (request, ctx) => {
        const { ref, argument } = request.params;
        let target: TemplateRecord | PromptRecord | undefined;
        if (ref.type === 'ref/prompt') {
          target = admittedPrompts.find((prompt) => prompt.name === ref.name);
        } else if (ref.type === 'ref/resource') {
          target = admittedTemplates.find((template) => template.uriTemplate === ref.uri);
          if (
            target === undefined &&
            admitted(record.resources).some((item) => item.uri === ref.uri)
          ) {
            return empty;
          }
        }
        if (target === undefined) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown completion reference');
        }
        const completer: McpCompleter | undefined = target.completers.get(argument.name);
        if (completer === undefined || challengeOf(target) !== undefined) {
          return empty;
        }
        const site: Site = { kind: 'completion', name: itemName(target) };
        const resolved = Object.freeze({ ...request.params.context?.arguments });
        const outcome = await run(site, ctx, defaultTimeoutMs, undefined, (context) =>
          completer(argument.value, context, resolved),
        );
        if (outcome.kind !== 'value') {
          protocolFailure(outcome, site);
          return empty;
        }
        if (!Array.isArray(outcome.value)) {
          report('invalid_result', 'the completer did not return an array', site);
          return empty;
        }
        const suggestions: unknown[] = outcome.value;
        const values = suggestions.filter((value): value is string => typeof value === 'string');
        return {
          completion: {
            values: values.slice(0, MAX_COMPLETIONS),
            total: values.length,
            hasMore: values.length > MAX_COMPLETIONS,
          },
        };
      });
    }
  };
}
