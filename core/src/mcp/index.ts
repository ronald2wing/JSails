/**
 * JSails developer MCP server — barrel.
 *
 * The developer server (`jsails mcp`) serves read-only introspection of the
 * app in the working directory over stdio:
 *
 * ```ts
 * import { runJsailsDevMcp } from 'jsails/mcp';
 * await runJsailsDevMcp({ configPath: 'jsails.app.js' });
 * ```
 *
 * Defining an app's own MCP tools, resources, and prompts, serving them, and
 * connecting to MCP servers is `@jsails/mcp`.
 *
 * Server-only: `runJsailsDevMcp` imports the MCP SDK's stdio transport.
 */

export { runJsailsDevMcp } from './server.js';
export type { JsailsDevMcpOptions, JsailsDevMcpProcess } from './server.js';

export { JSAILS_MCP_TOOL_ANNOTATIONS, JsailsMcpToolError } from './builtin-tools.js';
export type { JsailsMcpToolErrorCode } from './builtin-tools.js';
