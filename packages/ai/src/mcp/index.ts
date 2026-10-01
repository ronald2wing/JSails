/**
 * The `@jsails/ai/mcp` entry: MCP server tools as `AiTool`s. A structural
 * `McpToolSource`, `fromMcpClient` for the official `@modelcontextprotocol/client`
 * (pagination and cancellation), and `mcpTools`, which treats every server as
 * untrusted unless told otherwise: untrusted tools always need approval and
 * annotations count only for trusted servers.
 *
 * ```ts
 * import { fromMcpClient, mcpTools } from '@jsails/ai/mcp';
 *
 * const { tools, skipped } = await mcpTools(fromMcpClient(client), {
 *   trusted: false,
 *   prefix: 'docs_',
 * });
 * ```
 */

export {
  DEFAULT_MCP_MAX_PAGES,
  DEFAULT_MCP_MAX_TOOLS,
  fromMcpClient,
  type FromMcpClientOptions,
  type McpContentBlock,
  type McpToolAnnotations,
  type McpToolDescriptor,
  type McpToolResultLike,
  type McpToolSource,
  type OfficialMcpClientLike,
} from './mcp-source.js';
export {
  mcpTools,
  type McpApproval,
  type McpSkipReason,
  type McpSkippedTool,
  type McpTool,
  type McpToolCall,
  type McpToolInput,
  type McpToolset,
  type McpToolsOptions,
} from './mcp-tools.js';
