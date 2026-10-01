/**
 * Tools: definition, validation, authorization, execution under a deadline,
 * and result serialization.
 */

export {
  AI_TOOL,
  AI_TOOL_NAME_PATTERN,
  DEFAULT_TOOL_TIMEOUT_MS,
  defineTool,
  isAiTool,
  type AiInputCheck,
  type AiInputIssue,
  type AiOutputCheck,
  type AiTool,
  type AiToolContext,
  type AiToolDefinition,
  type AiToolResultSchema,
  type DefineToolNaming,
  type DefineToolSpec,
} from './define-tool.js';
export { AiToolFailure, MAX_PUBLIC_MESSAGE_LENGTH } from './tool-failure.js';
export {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  TOOL_ERROR_TEXT,
  authorizeToolCall,
  executeTool,
  parseToolInput,
  toolNeedsApproval,
  toolSchemaProfile,
  toolFailure,
  toolSpec,
  type AiToolErrorCode,
  type AiToolInputResult,
  type AiToolOutcome,
  type ExecuteToolOptions,
} from './tool-invocation.js';
export {
  DEFAULT_MAX_TOOL_RESULT_IMAGES,
  DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
  TRUNCATION_MARKER,
  limitToolOutput,
  serializeToolValue,
  truncateText,
  type AiToolOutputLimits,
  type ToolValueText,
} from './tool-serialization.js';
