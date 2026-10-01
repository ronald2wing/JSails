/**
 * The tool calls of one step: planning each call, resolving a resumed step,
 * and executing the runnable calls under the concurrency cap.
 *
 * Planning validates a call's input, asks the tool whether the call needs a
 * human decision, and, when it does, runs the tool's `authorize` first so
 * nobody is asked to approve what the caller may not do. A step whose calls
 * need approval runs none of them: every result of a step goes into one user
 * message, so the step waits until every decision is in.
 *
 * A resumed step (history ending with calls that have no results) is either
 * an approval resume, when the step has calls that need approval and every
 * one of them has a decision, or an interruption: then a call that does not
 * need approval re-runs only when its tool is `idempotent`, and otherwise
 * reports the fixed `interrupted` result, because it may already have had its
 * side effect.
 */

import { AiError } from '../errors/ai-error.js';
import type { AiBaseContext, AiToolCallPart, AiToolResultPart } from '../content/types.js';
import type { AiTool, AiToolContext } from '../tools/define-tool.js';
import {
  TOOL_ERROR_TEXT,
  authorizeToolCall,
  executeTool,
  parseToolInput,
  toolFailure,
  toolNeedsApproval,
  type AiToolOutcome,
} from '../tools/tool-invocation.js';
import { toolCallDigest } from './approvals.js';
import type { AiApproval, AiPendingToolCall } from './run-contract.js';
import type { RunSetup } from './run-options.js';
import { detach, escalate } from 'jsails/support';

/** One planned call: already settled, waiting for approval, or ready to execute. */
export type PlannedCall<C extends AiBaseContext> =
  | {
      readonly kind: 'settled';
      readonly call: AiToolCallPart;
      readonly exposeToBrowser: boolean;
      readonly outcome: AiToolOutcome;
    }
  | {
      readonly kind: 'approval';
      readonly call: AiToolCallPart;
      readonly tool: AiTool<unknown, unknown, C>;
      readonly input: unknown;
      readonly inputDigest: string;
    }
  | {
      readonly kind: 'execute';
      readonly call: AiToolCallPart;
      readonly tool: AiTool<unknown, unknown, C>;
      readonly input: unknown;
    };

/** A planned call with no decision outstanding. */
export type DecidedCall<C extends AiBaseContext> = Exclude<PlannedCall<C>, { kind: 'approval' }>;

/** The plan as decided calls, or `undefined` when a call waits for approval. */
export function decidedCalls<C extends AiBaseContext>(
  planned: readonly PlannedCall<C>[],
): readonly DecidedCall<C>[] | undefined {
  const decided: DecidedCall<C>[] = [];
  for (const entry of planned) {
    if (entry.kind === 'approval') return undefined;
    decided.push(entry);
  }
  return decided;
}

/** A call whose outcome is known. */
export interface FinishedCall {
  readonly call: AiToolCallPart;
  readonly exposeToBrowser: boolean;
  readonly outcome: AiToolOutcome;
}

function settledCall<C extends AiBaseContext>(
  call: AiToolCallPart,
  exposeToBrowser: boolean,
  outcome: AiToolOutcome,
): DecidedCall<C> {
  return { kind: 'settled', call, exposeToBrowser, outcome };
}

function actorOf<C extends AiBaseContext>(setup: RunSetup<C>): NonNullable<RunSetup<C>['actor']> {
  if (setup.actor === undefined) {
    throw new AiError('invalid_options', 'the run options are invalid', {
      context: { reason: 'context' },
    });
  }
  return setup.actor;
}

/** The context a tool receives for one call. */
export function toolContext<C extends AiBaseContext>(
  setup: RunSetup<C>,
  toolCallId: string,
  step: number,
  signal: AbortSignal,
): AiToolContext<C> {
  return { ...(setup.context as C), toolCallId, step, signal };
}

async function planCall<C extends AiBaseContext>(
  setup: RunSetup<C>,
  call: AiToolCallPart,
  step: number,
  signal: AbortSignal,
): Promise<PlannedCall<C>> {
  const tool = setup.tools.get(call.name);
  if (tool === undefined) {
    return settledCall(call, false, toolFailure('unknown_tool', TOOL_ERROR_TEXT.unknownTool));
  }
  const parsed = parseToolInput(tool, call.input, setup.toolProfiles.get(call.name) ?? 'loose');
  if (!parsed.ok) return settledCall(call, tool.exposeToBrowser, parsed.outcome);
  const ctx = toolContext(setup, call.id, step, signal);
  if (!(await toolNeedsApproval(tool, parsed.input, ctx))) {
    return { kind: 'execute', call, tool, input: parsed.input };
  }
  const refused = await authorizeToolCall(tool, parsed.input, ctx);
  if (refused !== undefined) return settledCall(call, tool.exposeToBrowser, refused);
  return {
    kind: 'approval',
    call,
    tool,
    input: parsed.input,
    inputDigest: toolCallDigest(actorOf(setup), call),
  };
}

/** Plan every call of a step, in call order. */
export function planToolCalls<C extends AiBaseContext>(
  setup: RunSetup<C>,
  calls: readonly AiToolCallPart[],
  step: number,
  signal: AbortSignal,
): Promise<readonly PlannedCall<C>[]> {
  return Promise.all(calls.map((call) => planCall(setup, call, step, signal)));
}

/** The calls of a plan that wait for a decision, as the run reports them. */
export function pendingCalls<C extends AiBaseContext>(
  planned: readonly PlannedCall<C>[],
): readonly AiPendingToolCall[] {
  const pending: AiPendingToolCall[] = [];
  for (const entry of planned) {
    if (entry.kind !== 'approval') continue;
    pending.push(
      Object.freeze({
        id: entry.call.id,
        name: entry.call.name,
        input: entry.call.input,
        inputDigest: entry.inputDigest,
        exposeToBrowser: entry.tool.exposeToBrowser,
      }),
    );
  }
  return Object.freeze(pending);
}

/** What resuming a step comes to: still waiting, or a plan with every call decided. */
export type ResumePlan<C extends AiBaseContext> =
  | { readonly kind: 'waiting'; readonly pending: readonly AiPendingToolCall[] }
  | { readonly kind: 'ready'; readonly planned: readonly DecidedCall<C>[] };

/**
 * Apply decisions to a resumed step. `run` has already bound every decision
 * to one of the step's calls (`bindApprovals`), so a forged one never gets
 * here. See the module comment for how undecided and interrupted calls are
 * treated.
 */
export function resolveResume<C extends AiBaseContext>(
  setup: RunSetup<C>,
  planned: readonly PlannedCall<C>[],
): ResumePlan<C> {
  const approvals: ReadonlyMap<string, AiApproval> = setup.approvals;
  const awaiting = planned.filter((entry) => entry.kind === 'approval');
  const undecided = awaiting.filter((entry) => !approvals.has(entry.call.id));
  if (undecided.length > 0) return { kind: 'waiting', pending: pendingCalls(undecided) };
  const approvalResume = awaiting.length > 0;
  const ready = planned.map((entry): DecidedCall<C> => {
    if (entry.kind === 'approval') {
      if (approvals.get(entry.call.id)?.decision === 'approve') {
        return { kind: 'execute', call: entry.call, tool: entry.tool, input: entry.input };
      }
      return settledCall(
        entry.call,
        entry.tool.exposeToBrowser,
        toolFailure('approval_denied', TOOL_ERROR_TEXT.deniedByUser),
      );
    }
    if (entry.kind === 'execute' && !approvalResume && !entry.tool.idempotent) {
      return settledCall(
        entry.call,
        entry.tool.exposeToBrowser,
        toolFailure('interrupted', TOOL_ERROR_TEXT.interrupted),
      );
    }
    return entry;
  });
  return { kind: 'ready', planned: ready };
}

/**
 * Execute a decided plan. Settled calls finish at once; runnable calls start
 * in call order, at most `setup.toolConcurrency` at a time, each under its own
 * deadline and the run signal. Yields each call as it finishes and returns the
 * results in call order. Once the run signal fires, calls not yet started
 * report the fixed `aborted` result without running.
 */
export async function* executeToolCalls<C extends AiBaseContext>(
  setup: RunSetup<C>,
  planned: readonly DecidedCall<C>[],
  step: number,
  signal: AbortSignal,
): AsyncGenerator<FinishedCall, readonly AiToolResultPart[]> {
  const finished: (FinishedCall | undefined)[] = planned.map(() => undefined);
  const ready: number[] = [];
  let wake: (() => void) | undefined;
  const complete = (index: number, entry: FinishedCall): void => {
    finished[index] = entry;
    ready.push(index);
    wake?.();
  };

  const runnable: number[] = [];
  planned.forEach((entry, index) => {
    if (entry.kind === 'settled') complete(index, entry);
    else runnable.push(index);
  });

  let next = 0;
  const launch = (): void => {
    const index = runnable[next];
    if (index === undefined) return;
    next += 1;
    const entry = planned[index];
    if (entry?.kind !== 'execute') return;
    const ctx = toolContext(setup, entry.call.id, step, signal);
    detach(
      executeTool(entry.tool, entry.input, ctx, {
        maxResultChars: setup.maxToolResultChars,
        maxResultMediaBytes: setup.maxToolResultMediaBytes,
        maxResultImages: setup.maxToolResultImages,
      })
        .catch(() => toolFailure('tool_failed', TOOL_ERROR_TEXT.failed))
        .then((outcome) => {
          complete(index, {
            call: entry.call,
            exposeToBrowser: entry.tool.exposeToBrowser,
            outcome,
          });
          launch();
        }),
      escalate,
    );
  };
  for (let slot = 0; slot < setup.toolConcurrency; slot += 1) launch();

  let yielded = 0;
  while (yielded < planned.length) {
    if (ready.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
      continue;
    }
    const index = ready.shift();
    const entry = index === undefined ? undefined : finished[index];
    if (entry === undefined) continue;
    yielded += 1;
    yield entry;
  }

  return Object.freeze(
    finished.map((entry): AiToolResultPart => {
      if (entry === undefined) throw new AiError('tool_failed', 'a tool call did not finish');
      return Object.freeze({
        type: 'tool-result',
        id: entry.call.id,
        name: entry.call.name,
        output: entry.outcome.output,
        isError: entry.outcome.isError,
      });
    }),
  );
}
