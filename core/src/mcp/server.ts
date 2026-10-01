/**
 * The JSails developer MCP server (`jsails mcp`): the read-only introspection
 * tools served over stdio on the official SDK.
 *
 * - Era. `serveStdio` decides per connection: a `server/discover` probe or any
 *   2026-07-28 request is served on the modern revision, an `initialize`
 *   handshake on the 2025 revisions. The same factory serves both.
 * - Errors. A tool's {@link JsailsError} becomes a tool error carrying its
 *   code, message, context, and suggestion. Any other throw becomes a generic
 *   `tool_failed` tool error, because the SDK would otherwise send the raw
 *   message (a driver's SQL, a file path) to the model; the detail goes to
 *   stderr, the developer's log.
 * - Lifecycle. {@link serveJsailsDevMcp} resolves when the connection closes:
 *   stdin reaching end of file, the signal aborting, or a transport fault.
 *   {@link runJsailsDevMcp} adds the stdout guard and closes on SIGINT and
 *   SIGTERM.
 *
 * Server-only: imports the SDK's stdio transport.
 */

import type { Readable, Writable } from 'node:stream';

import {
  McpServer,
  type CallToolResult,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type StandardSchemaWithJSON,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { JsailsError } from '../errors/jsails-error.js';
import { readFrameworkVersion } from '../plugins/check.js';
import {
  createJsailsMcpTools,
  type JsailsMcpTool,
  type JsailsMcpToolsOptions,
} from './builtin-tools.js';
import { onFirstProcessSignal, type SignalSource } from '../cli/shutdown.js';
import { guardStdout } from './stdout-guard.js';
import { detach, escalate } from '../support/detach.js';

/** Options for {@link runJsailsDevMcp}: the config modules the tools read. */
export type JsailsDevMcpOptions = JsailsMcpToolsOptions;

/** Options for {@link serveJsailsDevMcp}. */
export interface JsailsDevMcpServeOptions extends JsailsDevMcpOptions {
  /** The connection's transport. The server owns it from here on. */
  readonly transport: Transport;
  /** Closes the connection when aborted. */
  readonly signal?: AbortSignal;
  /** Where operator reports go. Default: process stderr. */
  readonly log?: (line: string) => void;
  /** The `serverInfo.version`. Default: the framework's package version. */
  readonly version?: string;
}

const INSTRUCTIONS = [
  'Read-only introspection of the JSails app in the working directory.',
  'Start with jsails_describe for the whole app, jsails_inspect_routes for routes,',
  'jsails_explain_route to see which route serves a path, and jsails_schema for',
  'the entity schema. No tool writes files or opens a database connection.',
].join(' ');

/** The text body of a tool result, mirrored in `structuredContent` when it is an object. */
function toolResult(value: unknown, isError: boolean): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {};
  return {
    content: [{ type: 'text', text }],
    ...structured,
    ...(isError ? { isError: true } : {}),
  };
}

function errorBody(error: JsailsError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    ...(Object.keys(error.context).length > 0 ? { context: error.context } : {}),
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
  };
}

const TOOL_FAILED = Object.freeze({
  code: 'tool_failed',
  message: 'the tool failed; the server log has the details',
});

/**
 * A Standard Schema that advertises the tool's JSON Schema and accepts every
 * value: validation is the tool's own (value-free) job, so the SDK never
 * writes its own error text about a caller's arguments.
 */
function advertised(json: Readonly<Record<string, unknown>>): StandardSchemaWithJSON {
  const emit = (): Record<string, unknown> => ({ ...json });
  return {
    '~standard': {
      version: 1,
      vendor: 'jsails',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: emit, output: emit },
    },
  };
}

/**
 * A failure's log text, as the CLI reports one (the renderer is loaded on
 * failure only): a framework error's message, a fixed line for any other
 * error, then the value-free cause chain, so a log line carries no message a
 * tool's dependency, the SDK or the client's input put in an error unless
 * `JSAILS_DEBUG=1` is set.
 */
async function describeFailure(error: unknown, label: string): Promise<string> {
  const { renderFailureReport } = await import('../errors/cause-chain.server.js');
  return renderFailureReport(error, {
    program: 'jsails mcp',
    label,
    fallback: 'an error that is not a framework error',
    env: process.env,
  }).join('\n');
}

async function callTool(
  tool: JsailsMcpTool,
  args: unknown,
  log: (line: string) => void,
): Promise<CallToolResult> {
  try {
    return toolResult(await tool.call(args), false);
  } catch (error) {
    if (error instanceof JsailsError) {
      if (error.cause !== undefined) {
        log(await describeFailure(error, tool.name));
      }
      return toolResult(errorBody(error), true);
    }
    log(await describeFailure(error, `${tool.name} failed`));
    return toolResult(TOOL_FAILED, true);
  }
}

/**
 * Build one SDK server instance with every developer tool registered. The
 * tools (and their projected schemas) are built once and shared by every
 * instance the factory returns.
 */
export function createJsailsDevMcpFactory(
  options: JsailsDevMcpOptions & {
    readonly version: string;
    readonly log: (line: string) => void;
  },
): () => McpServer {
  const tools = createJsailsMcpTools(options);
  return () => {
    const server = new McpServer(
      { name: 'jsails', version: options.version },
      { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
    );
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: advertised(tool.inputSchema),
          annotations: { ...tool.annotations },
        },
        (args: unknown) => callTool(tool, args, options.log),
      );
    }
    return server;
  };
}

/**
 * The transport `serveStdio` owns, wrapped so the connection's end is
 * observable: the SDK entry assigns its own `onclose`, and this wrapper calls
 * it and then reports the close.
 */
class ObservedTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?:
    (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly closed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.onclose?.();
      this.closed();
    };
    try {
      await this.inner.start();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Serve the developer tools on one connection until it closes. Rejects with
 * the transport's error when it cannot be started.
 */
export async function serveJsailsDevMcp(options: JsailsDevMcpServeOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const factory = createJsailsDevMcpFactory({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.dbConfigPath === undefined ? {} : { dbConfigPath: options.dbConfigPath }),
    version: options.version ?? readFrameworkVersion(),
    log,
  });
  const signal = options.signal;
  await new Promise<void>((resolve, reject) => {
    let abort: () => void = () => undefined;
    const transport = new ObservedTransport(
      options.transport,
      () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      },
      (failure) => {
        signal?.removeEventListener('abort', abort);
        reject(failure);
      },
    );
    const handle = serveStdio(factory, {
      legacy: 'serve',
      transport,
      onerror: (error) => {
        // The SDK's message can quote what the client sent; the report
        // prints the error's value-free facts instead.
        detach(describeFailure(error, 'the stdio transport reported an error').then(log), escalate);
      },
    });
    abort = () => {
      detach(handle.close(), escalate);
    };
    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

/** Process seams for {@link runJsailsDevMcp}; tests replace them. */
export interface JsailsDevMcpProcess {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** The process whose SIGINT and SIGTERM stop the server. */
  readonly signals?: SignalSource;
}

/**
 * Run the developer server on the process's stdio: install the stdout guard
 * (before any app module loads, since the tools load config lazily), serve
 * until stdin ends or SIGINT/SIGTERM arrives, then put stdout back. The first
 * signal closes the server; a second one ends the process (Node's default),
 * because a close blocked on a client that stopped reading has nothing left
 * to abort.
 */
export async function runJsailsDevMcp(
  options: JsailsDevMcpOptions = {},
  io: JsailsDevMcpProcess = {},
): Promise<void> {
  const stderr = io.stderr ?? process.stderr;
  const guard = guardStdout({
    ...(io.stdout === undefined ? {} : { stdout: io.stdout }),
    stderr,
  });
  const controller = new AbortController();
  const detachSignals = onFirstProcessSignal(
    ['SIGINT', 'SIGTERM'],
    () => {
      controller.abort();
    },
    io.signals,
  );
  try {
    await serveJsailsDevMcp({
      ...options,
      transport: new StdioServerTransport(io.stdin ?? process.stdin, guard.frames),
      signal: controller.signal,
      log: (line) => {
        stderr.write(`${line}\n`);
      },
    });
  } finally {
    detachSignals();
    guard.restore();
  }
}
