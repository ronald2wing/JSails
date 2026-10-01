/**
 * Running one tool call: schema profile choice, input restore and
 * validation, authorization, approval, the deadline, output validation,
 * serialization, and truncation (text characters, image bytes, image count).
 *
 * Every failure becomes a fixed, value-free error result the model can read
 * (an input mismatch also names the failing paths and issue codes, which come
 * from the schema, never the value), plus a code for the run's events. Only
 * an {@link AiToolFailure} puts the tool's own words in front of the model.
 * The run loop owns step bounds, concurrency, and approvals across turns.
 */

import { readToolOutput } from '../content/validate-messages.js';
import type { AiBaseContext, AiToolOutput } from '../content/types.js';
import type { AiProviderCapabilities, AiToolSpec } from '../provider/contract.js';
import { isUnparsedInput } from '../provider/wire-format.js';
import { lowerJsonSchema, type AiSchemaProfile } from '../structured-output/schema-lowering.js';
import { AI_TOOL, type AiInputCheck, type AiTool, type AiToolContext } from './define-tool.js';
import { AiToolFailure } from './tool-failure.js';
import {
  DEFAULT_MAX_TOOL_RESULT_IMAGES,
  DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
  limitToolOutput,
  serializeToolValue,
} from './tool-serialization.js';

/** The fixed texts a tool error result carries. */
export const TOOL_ERROR_TEXT: Readonly<{
  inputInvalid: string;
  failed: string;
  timedOut: string;
  notPermitted: string;
  outputInvalid: string;
  aborted: string;
  unknownTool: string;
  deniedByUser: string;
  interrupted: string;
}> = Object.freeze({
  inputInvalid: "error: the input does not match the tool's input schema",
  failed: 'error: the tool failed',
  timedOut: 'error: the tool timed out',
  notPermitted: 'error: not permitted',
  outputInvalid: 'error: the tool produced an invalid result',
  aborted: 'error: the tool call was aborted',
  unknownTool: 'error: no tool with this name is available',
  deniedByUser: 'error: denied by the user',
  interrupted: 'error: the tool call was interrupted before it finished',
});

/**
 * Why a tool call ended in an error result. `tool_denied` is the tool's own
 * `authorize` saying no; `approval_denied` is a human declining the call;
 * `interrupted` is a call from an earlier run that never reported a result.
 */
export type AiToolErrorCode =
  | 'tool_input_invalid'
  | 'tool_denied'
  | 'approval_denied'
  | 'unknown_tool'
  | 'interrupted'
  | 'tool_failed'
  | 'tool_timed_out'
  | 'tool_output_invalid'
  | 'aborted';

/** The result of executing one tool call. */
export interface AiToolOutcome {
  readonly output: AiToolOutput;
  readonly isError: boolean;
  /** Set when `isError`. */
  readonly code?: AiToolErrorCode;
}

/** The default cap on result characters when neither the tool nor the run sets one. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 100_000;

/** A frozen error outcome with a fixed text. */
export function toolFailure(code: AiToolErrorCode, output: string): AiToolOutcome {
  return Object.freeze({ output, isError: true, code });
}

/**
 * The lowering profile a tool is sent with to a provider: the provider's
 * strict profile when both the tool and the provider use strict mode, else
 * `loose`.
 */
export function toolSchemaProfile(
  tool: AiTool,
  capabilities: AiProviderCapabilities,
): AiSchemaProfile {
  return tool.strict && capabilities.strictTools ? capabilities.schemaProfile : 'loose';
}

/** The provider-facing spec of a tool under `profile` (deterministic and memoized). */
export function toolSpec(tool: AiTool, profile: AiSchemaProfile): AiToolSpec {
  const lowered = lowerJsonSchema(tool[AI_TOOL].inputJsonSchema, profile, 'invalid_tool');
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: lowered.schema,
    strict: profile !== 'loose',
  });
}

/** The text of an input-validation error result: the fixed sentence plus paths and codes. */
function inputErrorText(check: Extract<AiInputCheck<unknown>, { ok: false }>): string {
  if (check.issues.length === 0) return TOOL_ERROR_TEXT.inputInvalid;
  const details = check.issues.map((issue) => `${issue.path}: ${issue.code}`).join('; ');
  return `${TOOL_ERROR_TEXT.inputInvalid} (${details})`;
}

/** The outcome of {@link parseToolInput}. */
export type AiToolInputResult<I> =
  | { readonly ok: true; readonly input: I }
  | { readonly ok: false; readonly outcome: AiToolOutcome };

/** The issue an input that was never a JSON object reports. */
const UNPARSED_INPUT: Extract<AiInputCheck<unknown>, { ok: false }> = Object.freeze({
  ok: false,
  issues: Object.freeze([Object.freeze({ path: '(root)', code: 'invalid_json' })]),
});

/**
 * Restore the model's raw input for the profile the tool was sent with, then
 * validate it through the tool's schema. Invalid input yields a ready error
 * outcome; it must never reach `execute`. Input the adapter could not parse
 * (wrapped under the reserved `INVALID_JSON` key) fails before the schema
 * runs, whatever the schema would make of it.
 */
export function parseToolInput<I>(
  tool: AiTool<I, unknown, never>,
  raw: unknown,
  profile: AiSchemaProfile,
): AiToolInputResult<I> {
  if (isUnparsedInput(raw)) {
    return {
      ok: false,
      outcome: toolFailure('tool_input_invalid', inputErrorText(UNPARSED_INPUT)),
    };
  }
  const definition = tool[AI_TOOL];
  const restored = lowerJsonSchema(definition.inputJsonSchema, profile, 'invalid_tool').restore(
    raw,
  );
  const check = definition.validateInput(restored);
  if (check.ok) return { ok: true, input: check.value };
  return { ok: false, outcome: toolFailure('tool_input_invalid', inputErrorText(check)) };
}

/** Options for {@link executeTool}. */
export interface ExecuteToolOptions {
  /** The run's cap on result characters; the tool's own cap applies when lower. */
  readonly maxResultChars?: number;
  /** The run's cap on decoded image bytes in one result; the tool's own cap applies when lower. */
  readonly maxResultMediaBytes?: number;
  /** The run's cap on images in one result. */
  readonly maxResultImages?: number;
}

const TIMEOUT = Symbol('timeout');
const ABORTED = Symbol('aborted');
type Stop = typeof TIMEOUT | typeof ABORTED;

/** A signal that fires on run abort or at the tool's deadline, and a promise of which came first. */
interface Deadline {
  readonly signal: AbortSignal;
  readonly stopped: Promise<Stop>;
  reason(): Stop;
  dispose(): void;
}

function startDeadline(timeoutMs: number, runSignal: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onRunAbort = (): void => controller.abort();
  runSignal.addEventListener('abort', onRunAbort, { once: true });
  const signal = controller.signal;
  const reason = (): Stop => (timedOut ? TIMEOUT : ABORTED);
  const stopped = new Promise<Stop>((resolve) => {
    if (signal.aborted) resolve(reason());
    else signal.addEventListener('abort', () => resolve(reason()), { once: true });
  });
  return {
    signal,
    stopped,
    reason,
    dispose() {
      clearTimeout(timer);
      runSignal.removeEventListener('abort', onRunAbort);
    },
  };
}

function interrupted(reason: Stop): AiToolOutcome {
  return reason === TIMEOUT
    ? toolFailure('tool_timed_out', TOOL_ERROR_TEXT.timedOut)
    : toolFailure('aborted', TOOL_ERROR_TEXT.aborted);
}

/**
 * Whether this call needs a human decision, asked under the tool's deadline
 * and the run signal (the predicate receives a signal that fires at either).
 * A throwing predicate, one that misses the deadline, and one cut short by a
 * stopped run all count as "needs approval", so a broken or stalled check
 * fails closed and never holds the run.
 */
export async function toolNeedsApproval<I, C extends AiBaseContext>(
  tool: AiTool<I, unknown, C>,
  input: I,
  ctx: AiToolContext<C>,
): Promise<boolean> {
  if (ctx.signal.aborted) return true;
  const deadline = startDeadline(tool.timeoutMs, ctx.signal);
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() =>
        tool[AI_TOOL].needsApproval(input, { ...ctx, signal: deadline.signal }),
      ),
      deadline.stopped,
    ]);
    return answer !== false;
  } catch {
    return true;
  } finally {
    deadline.dispose();
  }
}

/** Run `authorize` under the deadline; `undefined` means allowed, else the error outcome. */
async function authorizeWithin<I, C extends AiBaseContext>(
  tool: AiTool<I, unknown, C>,
  input: I,
  ctx: AiToolContext<C>,
  deadline: Deadline,
): Promise<AiToolOutcome | undefined> {
  let allowed: unknown;
  try {
    allowed = await Promise.race([
      Promise.resolve().then(() => tool[AI_TOOL].authorize(input, ctx)),
      deadline.stopped,
    ]);
  } catch {
    allowed = false;
  }
  if (allowed === TIMEOUT || allowed === ABORTED) return interrupted(allowed);
  if (allowed !== true) return toolFailure('tool_denied', TOOL_ERROR_TEXT.notPermitted);
  return undefined;
}

/**
 * Run only the tool's `authorize` for a validated call, under the tool's
 * deadline. The run loop calls this before asking a human to approve a call,
 * so nobody is asked to approve what the caller may not do; `executeTool`
 * authorizes again right before `execute`. Returns `undefined` when allowed,
 * else the error outcome (a denial or a throw is `tool_denied`).
 */
export async function authorizeToolCall<I, C extends AiBaseContext>(
  tool: AiTool<I, unknown, C>,
  input: I,
  ctx: AiToolContext<C>,
): Promise<AiToolOutcome | undefined> {
  if (ctx.signal.aborted) return toolFailure('aborted', TOOL_ERROR_TEXT.aborted);
  const deadline = startDeadline(tool.timeoutMs, ctx.signal);
  try {
    return await authorizeWithin(tool, input, { ...ctx, signal: deadline.signal }, deadline);
  } finally {
    deadline.dispose();
  }
}

function toModelOutput<O>(tool: AiTool<unknown, O, never>, value: O): AiToolOutput | undefined {
  const definition = tool[AI_TOOL];
  if (definition.toModelOutput === undefined) {
    const serialized = serializeToolValue(value);
    return serialized.ok ? serialized.text : undefined;
  }
  try {
    return readToolOutput(definition.toModelOutput(value), 0);
  } catch {
    return undefined;
  }
}

/**
 * Authorize and execute one validated call under its deadline. `ctx.signal`
 * is the run's signal; `execute` receives a signal that also fires at the
 * tool's deadline. A tool that ignores its signal is abandoned, not awaited,
 * once the signal fires.
 */
export async function executeTool<I, O, C extends AiBaseContext>(
  tool: AiTool<I, O, C>,
  input: I,
  ctx: AiToolContext<C>,
  options: ExecuteToolOptions = {},
): Promise<AiToolOutcome> {
  const definition = tool[AI_TOOL];
  if (ctx.signal.aborted) return toolFailure('aborted', TOOL_ERROR_TEXT.aborted);
  const deadline = startDeadline(tool.timeoutMs, ctx.signal);
  const signal = deadline.signal;
  const toolCtx: AiToolContext<C> = { ...ctx, signal };

  try {
    const refused = await authorizeWithin(tool, input, toolCtx, deadline);
    if (refused !== undefined) return refused;

    let result: unknown;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => definition.execute(input, toolCtx)),
        deadline.stopped,
      ]);
    } catch (error) {
      if (signal.aborted) return interrupted(deadline.reason());
      if (error instanceof AiToolFailure) {
        return toolFailure('tool_failed', `error: ${error.publicMessage}`);
      }
      return toolFailure('tool_failed', TOOL_ERROR_TEXT.failed);
    }
    if (result === TIMEOUT || result === ABORTED) return interrupted(result);

    const checked = definition.validateOutput(result);
    if (!checked.ok) return toolFailure('tool_output_invalid', TOOL_ERROR_TEXT.outputInvalid);
    const output = toModelOutput(tool as AiTool<unknown, O, never>, checked.value);
    if (output === undefined)
      return toolFailure('tool_output_invalid', TOOL_ERROR_TEXT.outputInvalid);
    const limited = limitToolOutput(output, {
      maxChars: Math.min(
        tool.maxResultChars ?? Number.POSITIVE_INFINITY,
        options.maxResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
      ),
      maxMediaBytes: Math.min(
        tool.maxResultMediaBytes ?? Number.POSITIVE_INFINITY,
        options.maxResultMediaBytes ?? DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
      ),
      maxImages: options.maxResultImages ?? DEFAULT_MAX_TOOL_RESULT_IMAGES,
    });
    return Object.freeze({ output: limited, isError: false });
  } finally {
    deadline.dispose();
  }
}
