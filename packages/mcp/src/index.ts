/**
 * Model Context Protocol support for JSails: tool, resource, resource
 * template, prompt, and server definitions validated at define time, the
 * access seam they are served through, the content, input-request, and error
 * types a handler works with, serving over stdio, and the client: connecting
 * to a remote server over Streamable HTTP or stdio, or to a defined server in
 * process for tests.
 */

export {
  isPublicAccess,
  publicAccess,
  type McpAccess,
  type McpActor,
  type McpAuthorize,
  type McpGateDecision,
  type McpGateItem,
  type McpItemKind,
  type McpScopes,
} from './access.js';
export type { McpCallContext, McpClientInfo } from './call-context.js';
export {
  toolResult,
  type JsonValue,
  type McpContent,
  type McpContentAnnotations,
  type McpIcon,
  type McpPromptMessage,
  type McpResourceContent,
  type McpResourceContents,
  type McpToolResult,
} from './content.js';
export {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  defineMcpServer,
  defineMcpTool,
  type McpCacheHint,
  type McpCompleter,
  type McpCompleters,
  type McpHandlerInput,
  type McpListedResource,
  type McpPrompt,
  type McpPromptSpec,
  type McpResource,
  type McpResourceSpec,
  type McpResourceTemplate,
  type McpResourceTemplateSpec,
  type McpServerDefinition,
  type McpServerSpec,
  type McpTool,
  type McpToolAnnotations,
  type McpToolReturn,
  type McpToolSpec,
} from './definitions.js';
export {
  inputRequired,
  type McpElicitAnswer,
  type McpFormRequest,
  type McpInputRequest,
  type McpInputRequired,
  type McpInputRequiredSpec,
  type McpUrlRequest,
} from './input-required.js';
export {
  MCP_ERROR_CODES,
  McpClientError,
  McpDefinitionError,
  McpServingError,
  McpToolFailure,
  type McpClientErrorCode,
  type McpClientErrorDetails,
  type McpDefinitionErrorCode,
  type McpServingErrorCode,
  type McpServingSite,
  type McpToolErrorCode,
} from './errors.js';
export { connectInMemory, type McpInMemoryOptions } from './in-memory.js';
export {
  connectMcp,
  type McpCallOptions,
  type McpCallOutcome,
  type McpClientOptions,
  type McpElicitation,
  type McpElicitHandler,
  type McpElicitReply,
  type McpElicitValue,
  type McpRemoteOptions,
  type McpRemotePrompt,
  type McpRemoteResource,
  type McpRemoteResourceTemplate,
  type McpRemoteServer,
  type McpRemoteTool,
  type McpServerInfo,
  type McpToolCallOptions,
  type McpToolExclusion,
  type McpToolExclusionReason,
} from './remote-client.js';
export type {
  McpClientTransport,
  McpFetch,
  McpHeaders,
  McpHttpTransport,
  McpStdioTransport,
} from './remote-transport.js';
export type { McpSchema, McpSchemaInput, McpSchemaOutput } from './schema-projection.js';
export type { McpServingOptions } from './server-factory.js';
export { serveMcpStdio, type McpStdioOptions } from './stdio.js';
