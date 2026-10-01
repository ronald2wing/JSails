/**
 * The context every tool handler, resource reader, prompt renderer, and
 * completer receives: who is calling, which client, an abort signal, a
 * progress reporter, and, on a multi-round-trip retry, the user's answers and
 * the handler's own sealed state.
 *
 * The signal aborts when the client cancels the request (with
 * `notifications/cancelled` on a connection, by closing the request's stream
 * over HTTP), when the transport closes, or when the handler's deadline
 * passes. Progress is sent only when the request carried a progress token,
 * and only for strictly increasing values, as the specification requires;
 * otherwise it is a no-op.
 *
 * Answers arrive from the client unverified: `answer(key, schema)` validates
 * the accepted content with the author's schema and reads an invalid answer as
 * no answer. The state is the value the handler passed to `inputRequired`,
 * returned only after the seal verified it for this caller and this call.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { isRecord } from 'jsails/plugin-sdk';

import type { McpActor } from './access.js';
import type { JsonValue } from './content.js';
import type { McpElicitAnswer } from './input-required.js';
import { validateValue, type McpSchema, type McpSchemaOutput } from './schema-projection.js';

/** The calling client, as far as the protocol reveals it. */
export interface McpClientInfo {
  readonly name?: string;
  readonly version?: string;
  /**
   * The protocol revision of this request: from the request envelope, the
   * legacy handshake, or the `MCP-Protocol-Version` header of a stateless
   * legacy request; `'unknown'` when none of them names one.
   */
  readonly protocolVersion: string;
  /** `modern` for 2026-07-28 traffic, `legacy` for the 2025 revisions. */
  readonly era: 'modern' | 'legacy';
  /** Which elicitation modes the client declared. */
  readonly elicitation: { readonly form: boolean; readonly url: boolean };
}

/** The per-call context. */
export interface McpCallContext {
  readonly actor: McpActor;
  readonly signal: AbortSignal;
  readonly client: McpClientInfo;
  /**
   * Report progress. A no-op when the client sent no progress token, and for
   * a value that does not exceed the last one sent.
   */
  progress(done: number, total?: number, message?: string): void;
  /**
   * The answer to the request sent under `key` in the previous round, or
   * `undefined` when there is none. With `schema`, accepted content is
   * validated with it and an invalid answer reads as `undefined`; without,
   * the content is the client's raw JSON object.
   */
  answer<S extends McpSchema>(
    key: string,
    schema: S,
  ): Promise<McpElicitAnswer<McpSchemaOutput<S>> | undefined>;
  answer(key: string): Promise<McpElicitAnswer<Readonly<Record<string, JsonValue>>> | undefined>;
  /** The state the handler passed to `inputRequired` in the previous round, verified. */
  state<T extends JsonValue = JsonValue>(): T | undefined;
}

/** The context's answer reader. */
export type AnswerReader = McpCallContext['answer'];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function elicitationModes(capabilities: unknown): McpClientInfo['elicitation'] {
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined;
  if (!isRecord(elicitation)) {
    return { form: false, url: false };
  }
  // A bare `elicitation: {}` predates the mode split and means form support.
  const form = elicitation.form !== undefined || elicitation.url === undefined;
  return { form, url: elicitation.url !== undefined };
}

/** Read the client identity from the request envelope, or the legacy handshake. */
export function clientInfoOf(
  ctx: ServerContext,
  server: McpServer,
  era: 'modern' | 'legacy',
): McpClientInfo {
  const envelope: unknown = ctx.mcpReq.envelope;
  const meta = isRecord(envelope) ? envelope : {};
  const info = isRecord(meta[CLIENT_INFO_META_KEY])
    ? meta[CLIENT_INFO_META_KEY]
    : server.server.getClientVersion();
  const capabilities =
    meta[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities() ?? {};
  const protocolVersion =
    text(meta[PROTOCOL_VERSION_META_KEY]) ??
    text(server.server.getNegotiatedProtocolVersion()) ??
    text(ctx.http?.req?.headers.get('mcp-protocol-version')) ??
    'unknown';
  const name = isRecord(info) ? text(info.name) : undefined;
  const version = isRecord(info) ? text(info.version) : undefined;
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    protocolVersion,
    era,
    elicitation: Object.freeze(elicitationModes(capabilities)),
  });
}

/** Build the progress reporter for one request. */
export function progressReporter(
  ctx: ServerContext,
  report: (failure: unknown) => void,
): McpCallContext['progress'] {
  const token: unknown = ctx.mcpReq._meta?.progressToken;
  if (typeof token !== 'string' && typeof token !== 'number') {
    return () => undefined;
  }
  let last = Number.NEGATIVE_INFINITY;
  return (done, total, message) => {
    if (!Number.isFinite(done) || done <= last || ctx.mcpReq.signal.aborted) {
      return;
    }
    last = done;
    const params = {
      progressToken: token,
      progress: done,
      ...(typeof total === 'number' && Number.isFinite(total) ? { total } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
    ctx.mcpReq.notify({ method: 'notifications/progress', params }).catch(report);
  };
}

/**
 * Build the answer reader for one request. Only elicitation answers count;
 * a sampling or roots response under a key reads as no answer.
 */
export function answerReader(ctx: ServerContext): AnswerReader {
  const responses = ctx.mcpReq.inputResponses;
  function answer<S extends McpSchema>(
    key: string,
    schema: S,
  ): Promise<McpElicitAnswer<McpSchemaOutput<S>> | undefined>;
  function answer(
    key: string,
  ): Promise<McpElicitAnswer<Readonly<Record<string, JsonValue>>> | undefined>;
  async function answer(
    key: string,
    schema?: McpSchema,
  ): Promise<McpElicitAnswer<unknown> | undefined> {
    if (responses === undefined || typeof key !== 'string') {
      return undefined;
    }
    const view = inputResponse(responses, key);
    if (view.kind !== 'elicit') {
      return undefined;
    }
    if (view.action !== 'accept') {
      return Object.freeze({ action: view.action });
    }
    const content: unknown = view.content ?? {};
    if (schema === undefined) {
      return isRecord(content) ? Object.freeze({ action: 'accept' as const, content }) : undefined;
    }
    const checked = await validateValue(schema, content);
    return checked.ok
      ? Object.freeze({ action: 'accept' as const, content: checked.value })
      : undefined;
  }
  return answer;
}
