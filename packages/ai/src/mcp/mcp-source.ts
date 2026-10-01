/**
 * The MCP tool source seam and {@link fromMcpClient}, its adapter for the
 * official `@modelcontextprotocol/client` `Client`.
 *
 * {@link McpToolSource} is structural: anything that can list tools and call
 * one by name fits, so the bridge never imports an MCP SDK. `fromMcpClient`
 * asks for the first page without a cursor and follows any `nextCursor` it
 * is given (bounded page and tool counts, a repeated cursor is an error),
 * forwarding the abort signal on every request, which the official client
 * turns into `notifications/cancelled`.
 *
 * The official client (2.x) answers a cursor-less `listTools` by walking
 * every page itself, capped by its own `ClientOptions.listMaxPages` (default
 * 64), and returns no `nextCursor`. That call is kept on purpose: it fills the
 * client's response cache, which its `callTool` reads for output-schema
 * validation and SEP-2243 parameter headers. With the official client the
 * page bound is therefore `listMaxPages`, and `maxPages` and the cursor checks
 * apply only to a structural source that pages by `nextCursor`; `maxTools`
 * applies to both.
 * Listing failures are `AiError('mcp_failed')` with a static reason; the
 * server's own error is kept only as `cause`.
 */

import { AiError } from '../errors/ai-error.js';

/** Tool behaviour hints a server declares. Hints, never guarantees. */
export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One tool as `tools/list` describes it. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** A JSON Schema whose root is an object schema. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: McpToolAnnotations;
}

/** One content block of a `tools/call` result. */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: { readonly uri?: string; readonly text?: string; readonly mimeType?: string };
}

/** What `tools/call` returns. */
export interface McpToolResultLike {
  readonly content: readonly McpContentBlock[];
  /** Any JSON value the tool returns besides its content. */
  readonly structuredContent?: unknown;
  /** The tool ran and reported a failure. */
  readonly isError?: boolean;
}

/**
 * Where MCP tools come from. Results are untrusted: the bridge checks every
 * descriptor and result it receives.
 */
export interface McpToolSource {
  listTools(options: { readonly signal?: AbortSignal }): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal },
  ): Promise<McpToolResultLike>;
}

/** The part of the official MCP `Client` that {@link fromMcpClient} uses. */
export interface OfficialMcpClientLike {
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ readonly tools: readonly unknown[]; readonly nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Options for {@link fromMcpClient}. */
export interface FromMcpClientOptions {
  /**
   * Most `tools/list` pages to follow by `nextCursor` (default 64). The
   * official client walks its pages itself, bounded by its own
   * `listMaxPages`, so this bound applies to structural sources.
   */
  readonly maxPages?: number;
  /** Most tools to accept (default 1 000). */
  readonly maxTools?: number;
}

/** The default page bound of {@link fromMcpClient}. */
export const DEFAULT_MCP_MAX_PAGES = 64;

/** The default tool bound of {@link fromMcpClient}. */
export const DEFAULT_MCP_MAX_TOOLS = 1_000;

/** The value-free error for an MCP server that failed or broke the protocol. */
export function mcpFailed(reason: string, cause?: unknown): AiError {
  return new AiError('mcp_failed', 'the MCP server failed to list its tools', {
    context: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

function readBound(value: unknown, fallback: number, reason: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new AiError('invalid_options', 'the MCP client options are invalid', {
      context: { reason },
    });
  }
  return value;
}

function hasMethods(value: unknown): value is OfficialMcpClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<OfficialMcpClientLike>).listTools === 'function' &&
    typeof (value as Partial<OfficialMcpClientLike>).callTool === 'function'
  );
}

/** Read through a call so a check after an `await` is not narrowed away. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortedListing(): AiError {
  return new AiError('aborted', 'listing the MCP tools was aborted');
}

/** An {@link McpToolSource} over a connected official MCP client. */
export function fromMcpClient(
  client: OfficialMcpClientLike,
  options: FromMcpClientOptions = {},
): McpToolSource {
  if (!hasMethods(client)) {
    throw new AiError('invalid_options', 'fromMcpClient needs an MCP client', {
      context: { reason: 'client' },
    });
  }
  const maxPages = readBound(options.maxPages, DEFAULT_MCP_MAX_PAGES, 'max_pages');
  const maxTools = readBound(options.maxTools, DEFAULT_MCP_MAX_TOOLS, 'max_tools');

  return Object.freeze({
    async listTools(
      init: { readonly signal?: AbortSignal } = {},
    ): Promise<readonly McpToolDescriptor[]> {
      const signal = init.signal;
      const tools: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (isAborted(signal)) throw abortedListing();
        if (page >= maxPages) throw mcpFailed('page_limit');
        let result: unknown;
        try {
          result = await client.listTools(
            cursor === undefined ? undefined : { cursor },
            signal === undefined ? undefined : { signal },
          );
        } catch (error) {
          if (isAborted(signal)) throw abortedListing();
          throw mcpFailed('list_failed', error);
        }
        if (typeof result !== 'object' || result === null) throw mcpFailed('malformed_list');
        const { tools: pageTools, nextCursor } = result as {
          readonly tools?: unknown;
          readonly nextCursor?: unknown;
        };
        if (!Array.isArray(pageTools)) throw mcpFailed('malformed_list');
        tools.push(...(pageTools as readonly unknown[]));
        if (tools.length > maxTools) throw mcpFailed('tool_limit');
        if (nextCursor === undefined || nextCursor === null) break;
        if (typeof nextCursor !== 'string' || cursors.has(nextCursor)) {
          throw mcpFailed('pagination_loop');
        }
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      // Descriptors stay unchecked here; `mcpTools` checks each one.
      return Object.freeze(tools) as readonly McpToolDescriptor[];
    },
    async callTool(
      name: string,
      args: Readonly<Record<string, unknown>>,
      init: { readonly signal: AbortSignal },
    ): Promise<McpToolResultLike> {
      return (await client.callTool(
        { name, arguments: { ...args } },
        { signal: init.signal },
      )) as McpToolResultLike;
    },
  });
}
