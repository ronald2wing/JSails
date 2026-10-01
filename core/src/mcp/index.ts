/**
 * JSails MCP introspection server — barrel.
 *
 * Re-exports the tool definition, server (official MCP SDK), the in-process
 * client, and the built-in JSails tool set:
 *
 * ```ts
 * import { createMcpServer, createMcpToolRegistry, jsailsMcpTools } from 'jsails/mcp';
 * await createMcpServer({
 *   name: 'jsails',
 *   version: '1.0.0',
 *   tools: createMcpToolRegistry(jsailsMcpTools),
 * });
 * ```
 *
 * Server-only: `createMcpServer` imports the MCP SDK's stdio transport.
 */

export { createMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';

export { createInProcessMcpClient, McpClientError } from './client.js';
export type { McpClient, McpCallResult } from './client.js';

export { defineMcpTool, createMcpToolRegistry, McpToolError } from './tool.js';
export type {
  McpTool,
  McpToolOptions,
  McpToolRegistry,
  McpToolResult,
  ToolDefinition,
  ToolInputSchema,
} from './tool.js';

export {
  createJsailsMcpTools,
  jsailsMcpTools,
  jsailsDescribeTool,
  jsailsInspectRoutesTool,
  jsailsExplainRouteTool,
  jsailsSchemaTool,
} from './builtin-tools.js';
export type { JsailsMcpToolsOptions } from './builtin-tools.js';

/**
 * Build a ready-to-run MCP stdio server for a JSails project with the built-in
 * tool set, bound to the given config modules (the defaults otherwise). The
 * paths are fixed here; no tool call can select a different module to load.
 */
export async function createJsailsMcpServer(options?: {
  readonly version?: string;
  readonly configPath?: string;
  readonly dbConfigPath?: string;
}): Promise<void> {
  const { createMcpToolRegistry } = await import('./tool.js');
  const { createMcpServer } = await import('./server.js');
  const { createJsailsMcpTools } = await import('./builtin-tools.js');

  return createMcpServer({
    name: 'jsails',
    version: options?.version ?? '1.0.0',
    tools: createMcpToolRegistry(
      createJsailsMcpTools({
        ...(options?.configPath !== undefined ? { configPath: options.configPath } : {}),
        ...(options?.dbConfigPath !== undefined ? { dbConfigPath: options.dbConfigPath } : {}),
      }),
    ),
  });
}
