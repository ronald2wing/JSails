/**
 * The mutable state of one run: what it appended, its steps, its usage and
 * cost, the next provider request, the budget check before each step, and
 * the frozen {@link AiResult} it settles with.
 *
 * The transcript only grows: every append re-checks the whole transcript, so
 * a provider that repeats a tool-call id, or any other rule break, is caught
 * before the message can reach a tool or a later request.
 */

import { AiError, isAiError } from '../errors/ai-error.js';
import { textOf } from '../content/messages.js';
import type { AiBaseContext, AiMessage, AiToolResultPart } from '../content/types.js';
import { checkTranscript } from '../content/validate-messages.js';
import type { AiProviderRequest, AiProviderResponse } from '../provider/contract.js';
import { providerFailed } from '../provider/provider-response.js';
import { costMicroUsd } from '../usage/pricing.js';
import { ZERO_USAGE, addUsage, type AiUsage } from '../usage/usage.js';
import type {
  AiCheckpoint,
  AiPendingToolCall,
  AiResult,
  AiRunStatus,
  AiStep,
} from './run-contract.js';
import type { RunSetup } from './run-options.js';

interface StepRecord {
  readonly index: number;
  readonly response: AiProviderResponse;
  readonly costMicroUsd: number | undefined;
  readonly message: AiMessage | undefined;
  toolResults: readonly AiToolResultPart[];
}

/** How a run ends, beyond its status. */
export interface RunEnding {
  readonly error?: AiError;
  readonly pendingApprovals?: readonly AiPendingToolCall[];
}

function budgetExceeded(budget: string): AiError {
  return new AiError('budget_exceeded', 'the run budget is exhausted', { context: { budget } });
}

/** The state of one run. */
export class RunState<C extends AiBaseContext> {
  readonly #setup: RunSetup<C>;
  readonly #messages: AiMessage[];
  readonly #appended: AiMessage[] = [];
  readonly #steps: StepRecord[] = [];
  #usage: AiUsage = ZERO_USAGE;
  #cost = 0;
  #lastInputTokens = 0;

  constructor(setup: RunSetup<C>) {
    this.#setup = setup;
    this.#messages = [...setup.history];
    if (setup.input !== undefined) {
      this.#messages.push(setup.input);
      this.#appended.push(setup.input);
    }
  }

  /** The number of messages in the transcript so far. */
  get length(): number {
    return this.#messages.length;
  }

  /** Usage of the run so far. */
  get usage(): AiUsage {
    return this.#usage;
  }

  /**
   * Append a message after checking the whole transcript. A rule break in a
   * message the provider produced is a provider failure.
   */
  append(message: AiMessage): void {
    const messages = [...this.#messages, message];
    try {
      checkTranscript(messages, 'transcript');
    } catch (error) {
      if (isAiError(error, 'invalid_messages')) {
        throw providerFailed(String(error.context.rule ?? 'transcript'));
      }
      throw error;
    }
    this.#messages.push(message);
    this.#appended.push(message);
  }

  /**
   * Count a finished response's usage and cost, and record it as a step.
   * Pricing runs first, so a pricing failure leaves the step unrecorded.
   */
  recordStep(index: number, response: AiProviderResponse, message: AiMessage | undefined): void {
    const pricing = this.#setup.pricing;
    const cost = pricing === undefined ? undefined : costMicroUsd(response.iterations, pricing);
    this.#usage = addUsage(this.#usage, response.usage);
    if (cost !== undefined) {
      this.#cost += cost;
      if (!Number.isSafeInteger(this.#cost)) {
        throw new AiError('invalid_options', 'the cost exceeds the representable range');
      }
    }
    this.#lastInputTokens = response.usage.inputTokens;
    this.#steps.push({ index, response, costMicroUsd: cost, message, toolResults: [] });
  }

  /** The cost of the most recent step, when pricing is on. */
  get lastStepCost(): number | undefined {
    return this.#steps.at(-1)?.costMicroUsd;
  }

  /** Attach tool results to the step that made the calls (resumed calls belong to no step). */
  recordToolResults(step: number | undefined, results: readonly AiToolResultPart[]): void {
    if (step === undefined) return;
    const record = this.#steps.find((candidate) => candidate.index === step);
    if (record !== undefined) record.toolResults = results;
  }

  /**
   * The output-token cap for the next call, or the budget error that stops
   * the run before it. The next request's input is at least the last one's
   * (the transcript only grows), so the input budget stops a step that would
   * certainly exceed it; the output cap is clamped to what remains.
   */
  nextStepBudget(): { readonly maxOutputTokens: number } | AiError {
    const setup = this.#setup;
    if (
      setup.maxInputTokens !== undefined &&
      this.#usage.inputTokens + this.#lastInputTokens > setup.maxInputTokens
    ) {
      return budgetExceeded('input');
    }
    if (setup.maxCostMicroUsd !== undefined && this.#cost >= setup.maxCostMicroUsd) {
      return budgetExceeded('cost');
    }
    let maxOutputTokens = setup.maxOutputTokens;
    if (setup.maxOutputTokensTotal !== undefined) {
      const remaining = setup.maxOutputTokensTotal - this.#usage.outputTokens;
      if (remaining <= 0) return budgetExceeded('output');
      maxOutputTokens = Math.min(maxOutputTokens, remaining);
    }
    return { maxOutputTokens };
  }

  /** The provider request for the next step. */
  request(maxOutputTokens: number): AiProviderRequest {
    const setup = this.#setup;
    return Object.freeze({
      model: setup.model.id,
      instructions: setup.instructions,
      messages: Object.freeze([...this.#messages]),
      tools: setup.toolSpecs,
      toolChoice: setup.toolChoice,
      parallelToolCalls: setup.parallelToolCalls,
      maxOutputTokens,
      cache: setup.cache,
      ...(setup.effort === undefined ? {} : { effort: setup.effort }),
      ...(setup.reasoning === undefined ? {} : { reasoning: setup.reasoning }),
      ...(setup.stopSequences === undefined ? {} : { stopSequences: setup.stopSequences }),
      ...(setup.providerOptions === undefined ? {} : { providerOptions: setup.providerOptions }),
    });
  }

  /** What a checkpoint hook receives. */
  checkpoint(step: number, signal: AbortSignal): AiCheckpoint {
    return Object.freeze({
      step,
      appended: Object.freeze([...this.#appended]),
      messages: Object.freeze([...this.#messages]),
      usage: this.#usage,
      signal,
    });
  }

  /** The frozen result the run settles with. */
  result(status: AiRunStatus, ending: RunEnding = {}): AiResult {
    let text = '';
    for (let index = this.#appended.length - 1; index >= 0; index -= 1) {
      const message = this.#appended[index];
      if (message?.role === 'assistant') {
        text = textOf(message);
        break;
      }
    }
    const steps = this.#steps.map((record): AiStep =>
      Object.freeze({
        index: record.index,
        response: record.response,
        usage: record.response.usage,
        ...(record.costMicroUsd === undefined ? {} : { costMicroUsd: record.costMicroUsd }),
        ...(record.message === undefined ? {} : { message: record.message }),
        toolResults: record.toolResults,
      }),
    );
    const finishReason = this.#steps.at(-1)?.response.finishReason;
    return Object.freeze({
      status,
      text,
      ...(finishReason === undefined ? {} : { finishReason }),
      appended: Object.freeze([...this.#appended]),
      messages: Object.freeze([...this.#messages]),
      steps: Object.freeze(steps),
      usage: this.#usage,
      ...(this.#setup.pricing === undefined ? {} : { costMicroUsd: this.#cost }),
      pendingApprovals: ending.pendingApprovals ?? Object.freeze([]),
      ...(ending.error === undefined ? {} : { error: ending.error }),
    });
  }
}
