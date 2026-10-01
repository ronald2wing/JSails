/**
 * The run loop: one streaming path for every run, with or without tools.
 *
 * Each step checks the step bound and the budgets, streams one provider
 * response, and then, in this order: counts usage and cost; refuses a
 * refusal or content-filter stop (`refused`, the response not appended);
 * refuses tool calls cut off at the token limit (`output_truncated`), tool
 * calls under `toolChoice: 'none'`, and more calls than the per-step bound;
 * appends the assistant message; emits `step-finish` and awaits
 * `onStepFinish`; then ends the run, continues a paused turn, waits for
 * approvals, or runs the tools and appends their results in one user
 * message. A run whose history ends with unanswered calls first resumes them.
 *
 * Every exit settles a result with everything appended so far; a stopped run
 * reports why it stopped (`aborted`, or `timed_out` for the deadline and the
 * idle timeout) whatever error the interrupted work raised.
 */

import { AiError, isAiError } from '../errors/ai-error.js';
import type { AiBaseContext, AiMessage } from '../content/types.js';
import { readMessage, toolCallsOf } from '../content/validate-messages.js';
import type { AiProviderResponse } from '../provider/contract.js';
import { providerFailed, readResponseMessage } from '../provider/provider-response.js';
import { streamProviderResponse } from './provider-stream.js';
import type { AiCheckpoint, AiResult, AiRunEvent } from './run-contract.js';
import { stopError, type RunControl } from './run-control.js';
import type { RunSetup } from './run-options.js';
import { RunState } from './run-state.js';
import {
  decidedCalls,
  executeToolCalls,
  pendingCalls,
  planToolCalls,
  resolveResume,
  type DecidedCall,
} from './tool-calls.js';

type Hook = ((checkpoint: AiCheckpoint) => void | Promise<void>) | undefined;

function throwIfStopped(control: RunControl): void {
  const reason = control.stopReason();
  if (reason !== undefined) throw stopError(reason);
}

/**
 * `work`, unless the run stops first: then the stop's error, at once, so no
 * app callback the work awaits (a tool's `needsApproval` or `authorize`) can
 * hold a stopped run open.
 */
function untilStopped<T>(work: Promise<T>, control: RunControl): Promise<T> {
  const signal = control.signal;
  return new Promise<T>((resolve, reject) => {
    const stopped = (): void => reject(stopError(control.stopReason() ?? 'aborted'));
    if (signal.aborted) {
      stopped();
      return;
    }
    signal.addEventListener('abort', stopped, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
  });
}

/** Await a checkpoint hook; a throw is `checkpoint_failed`, a stop wins over both. */
async function checkpoint<C extends AiBaseContext>(
  hook: Hook,
  state: RunState<C>,
  step: number,
  control: RunControl,
): Promise<void> {
  if (hook === undefined) return;
  const signal = control.signal;
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new AiError('aborted', 'the run was stopped'));
        return;
      }
      const onAbort = (): void => reject(new AiError('aborted', 'the run was stopped'));
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => hook(state.checkpoint(step, signal)))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  } catch (error) {
    throwIfStopped(control);
    throw new AiError('checkpoint_failed', 'the checkpoint hook failed', { cause: error });
  }
}

/** Run decided calls, stream their results, append the results message, and checkpoint it. */
async function* runTools<C extends AiBaseContext>(
  setup: RunSetup<C>,
  state: RunState<C>,
  decided: readonly DecidedCall<C>[],
  step: number | undefined,
  control: RunControl,
): AsyncGenerator<AiRunEvent, void> {
  const execution = executeToolCalls(setup, decided, step ?? 0, control.signal);
  let next = await execution.next();
  while (next.done !== true) {
    const { call, outcome, exposeToBrowser } = next.value;
    yield Object.freeze({
      type: 'tool-result',
      id: call.id,
      name: call.name,
      isError: outcome.isError,
      output: outcome.output,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      exposeToBrowser,
    });
    next = await execution.next();
  }
  const results = next.value;
  const message = readMessage({ role: 'user', parts: results }, state.length);
  state.append(message);
  state.recordToolResults(step, results);
  yield Object.freeze({ type: 'tool-results', message });
  if (!control.signal.aborted) await checkpoint(setup.onToolResults, state, step ?? 0, control);
}

/** Stream one provider response, yielding its deltas as events. */
async function* streamStep<C extends AiBaseContext>(
  setup: RunSetup<C>,
  state: RunState<C>,
  step: number,
  maxOutputTokens: number,
  control: RunControl,
): AsyncGenerator<AiRunEvent, AiProviderResponse> {
  const stream = streamProviderResponse(
    setup.provider,
    state.request(maxOutputTokens),
    { signal: control.signal, headers: setup.headers },
    setup.idleTimeoutMs,
    control,
  );
  let next = await stream.next();
  while (next.done !== true) {
    yield Object.freeze({ ...next.value, step });
    next = await stream.next();
  }
  return next.value;
}

function stepFinish<C extends AiBaseContext>(
  state: RunState<C>,
  step: number,
  response: AiProviderResponse,
  appended: readonly AiMessage[],
): AiRunEvent {
  const cost = state.lastStepCost;
  return Object.freeze({
    type: 'step-finish',
    step,
    finishReason: response.finishReason,
    usage: response.usage,
    ...(cost === undefined ? {} : { costMicroUsd: cost }),
    appended: Object.freeze([...appended]),
  });
}

async function* runSteps<C extends AiBaseContext>(
  setup: RunSetup<C>,
  state: RunState<C>,
  control: RunControl,
): AsyncGenerator<AiRunEvent, AiResult> {
  if (setup.resume !== undefined) {
    const calls = toolCallsOf(setup.resume);
    const planned = await untilStopped(planToolCalls(setup, calls, 0, control.signal), control);
    const plan = resolveResume(setup, planned);
    throwIfStopped(control);
    if (plan.kind === 'waiting') {
      yield Object.freeze({ type: 'approval-required', calls: plan.pending });
      return state.result('awaiting-approval', { pendingApprovals: plan.pending });
    }
    yield* runTools(setup, state, plan.planned, undefined, control);
  }

  for (let step = 0; ; step += 1) {
    throwIfStopped(control);
    if (step >= setup.maxSteps) {
      return state.result('failed', {
        error: new AiError('step_limit', 'the run reached its step limit'),
      });
    }
    const budget = state.nextStepBudget();
    if (budget instanceof AiError) return state.result('failed', { error: budget });

    yield Object.freeze({ type: 'step-start', step });
    const response = yield* streamStep(setup, state, step, budget.maxOutputTokens, control);

    const reject = (error: AiError): AiResult => state.result('failed', { error });
    if (response.finishReason === 'refusal' || response.finishReason === 'content-filter') {
      state.recordStep(step, response, undefined);
      yield stepFinish(state, step, response, []);
      return reject(
        new AiError('refused', 'the model declined to answer', {
          context: { finishReason: response.finishReason },
        }),
      );
    }
    let message: AiMessage;
    try {
      message = readResponseMessage(response, setup.provider.id, state.length);
    } catch (error) {
      state.recordStep(step, response, undefined);
      yield stepFinish(state, step, response, []);
      throw error;
    }
    const calls = toolCallsOf(message);
    let refusal: AiError | undefined;
    if (calls.length > 0 && response.finishReason === 'length') {
      refusal = new AiError('output_truncated', 'a tool call was cut off at the token limit', {
        suggestion: 'Raise maxOutputTokens.',
      });
    } else if (calls.length > 0 && setup.toolChoice === 'none') {
      refusal = providerFailed('tool_choice');
    } else if (calls.length > setup.maxToolCallsPerStep) {
      refusal = new AiError('tool_call_limit', 'the model made more tool calls than allowed', {
        context: { calls: calls.length },
      });
    }
    if (refusal !== undefined) {
      state.recordStep(step, response, undefined);
      yield stepFinish(state, step, response, []);
      return reject(refusal);
    }

    try {
      state.append(message);
    } catch (error) {
      state.recordStep(step, response, undefined);
      yield stepFinish(state, step, response, []);
      throw error;
    }
    state.recordStep(step, response, message);
    for (const call of calls) {
      yield Object.freeze({
        type: 'tool-call',
        step,
        id: call.id,
        name: call.name,
        input: call.input,
        exposeToBrowser: setup.tools.get(call.name)?.exposeToBrowser ?? false,
      });
    }
    yield stepFinish(state, step, response, [message]);
    await checkpoint(setup.onStepFinish, state, step, control);

    if (calls.length === 0) {
      if (response.finishReason === 'pause') continue;
      return state.result('completed');
    }
    throwIfStopped(control);
    const planned = await untilStopped(planToolCalls(setup, calls, step, control.signal), control);
    const decided = decidedCalls(planned);
    throwIfStopped(control);
    if (decided === undefined) {
      const pending = pendingCalls(planned);
      yield Object.freeze({ type: 'approval-required', calls: pending });
      return state.result('awaiting-approval', { pendingApprovals: pending });
    }
    yield* runTools(setup, state, decided, step, control);
  }
}

/**
 * The whole run as an event generator whose return value is the result.
 * Never throws: every failure settles a `failed` or `aborted` result, and the
 * last event is always `finish`.
 */
export async function* runLoop<C extends AiBaseContext>(
  setup: RunSetup<C>,
  control: RunControl,
): AsyncGenerator<AiRunEvent, AiResult> {
  const state = new RunState(setup);
  let result: AiResult;
  control.start();
  try {
    result = yield* runSteps(setup, state, control);
  } catch (error) {
    const reason = control.stopReason();
    if (reason !== undefined) {
      result = state.result(reason === 'aborted' ? 'aborted' : 'failed', {
        error: stopError(reason),
      });
    } else {
      result = state.result('failed', {
        error: isAiError(error)
          ? error
          : new AiError('provider_failed', 'the run failed unexpectedly'),
      });
    }
  } finally {
    control.dispose();
  }
  yield Object.freeze({ type: 'finish', result });
  return result;
}
