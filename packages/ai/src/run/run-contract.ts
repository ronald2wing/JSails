/**
 * The public shapes of a run: its options, the events it streams, each step,
 * and the result it always settles with.
 *
 * A run separates trusted `history` (loaded by the server) from untrusted
 * `input` (what a browser just sent, through `parseUserInput`), so a client
 * can never forge an assistant tool call or an approval. Its result settles
 * as `completed`, `awaiting-approval`, `aborted`, or `failed`, never as a
 * bare rejection, and always lists the messages it `appended` (the input
 * first), so work whose tools already had side effects is never lost.
 */

import type { AiError } from '../errors/ai-error.js';
import type { AiUserInput } from '../content/user-input.js';
import type {
  AiBaseContext,
  AiEffort,
  AiFinishReason,
  AiMessage,
  AiToolOutput,
  AiToolResultPart,
} from '../content/types.js';
import type {
  AiInstruction,
  AiModel,
  AiProviderOptions,
  AiProviderResponse,
} from '../provider/contract.js';
import type { AiTool } from '../tools/define-tool.js';
import type { AiToolErrorCode } from '../tools/tool-invocation.js';
import type { AiPricing } from '../usage/pricing.js';
import type { AiUsage } from '../usage/usage.js';

/** Bounds on one run. Every bound is checked before the step it would exceed. */
export interface AiLimits {
  /** Most provider calls in the run (default 8). */
  readonly maxSteps?: number;
  /** Most tool calls one response may make; more fails the run (default 16). */
  readonly maxToolCallsPerStep?: number;
  /** Most tool calls running at once (default 4). */
  readonly toolConcurrency?: number;
  /** Cap on the characters of one tool result (default 100 000). */
  readonly maxToolResultChars?: number;
  /** Cap on the decoded image bytes of one tool result (default 20 MiB). */
  readonly maxToolResultMediaBytes?: number;
  /** Cap on the images in one tool result (default 16). */
  readonly maxToolResultImages?: number;
  /** Most input tokens across the run's provider calls. */
  readonly maxInputTokens?: number;
  /** Most output tokens across the run; each call's cap is clamped to what remains. */
  readonly maxOutputTokensTotal?: number;
  /** Most spend in micro-USD across the run; needs `pricing`. */
  readonly maxCostMicroUsd?: number;
}

/** A human decision on one call that awaited approval, bound to that exact call. */
export interface AiApproval {
  readonly id: string;
  readonly name: string;
  /** The `inputDigest` of the pending call the decision was made on. */
  readonly inputDigest: string;
  readonly decision: 'approve' | 'deny';
}

/** A tool call that waits for a human decision. */
export interface AiPendingToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /**
   * A SHA-256 digest of the actor, the call id, the tool name, and the input.
   * An approval must quote it, so a decision only ever applies to the call the
   * person saw, made for the same actor.
   */
  readonly inputDigest: string;
  /**
   * Whether the tool lets the browser see this call's input, and so its
   * digest. Carried on the call itself, so a resumed run that emits no
   * `tool-call` event still projects the approval correctly.
   */
  readonly exposeToBrowser: boolean;
}

/** What the checkpoint hooks receive. */
export interface AiCheckpoint {
  /** The provider step that produced the newest messages; resumed calls report 0. */
  readonly step: number;
  /** Every message the run has added so far, the input first. */
  readonly appended: readonly AiMessage[];
  /** The full transcript so far: history, input, and appended messages. */
  readonly messages: readonly AiMessage[];
  /** Usage of the run so far. */
  readonly usage: AiUsage;
  /** Fires when the run is aborted or times out. */
  readonly signal: AbortSignal;
}

/** Options every run accepts, whether or not it offers tools. */
export interface AiRunCommonOptions {
  readonly model: AiModel;
  readonly instructions?: string | readonly AiInstruction[];
  /**
   * Server-held, trusted transcript. It may end with an assistant message
   * whose tool calls have no results yet: the run then resumes those calls
   * (approval decisions, or interrupted calls) instead of taking new input.
   */
  readonly history?: readonly AiMessage[];
  /**
   * New user content, untrusted: a string, or the message `parseUserInput`
   * made from what the browser sent. Any other message is refused with
   * `invalid_input` (`reason: 'unparsed'`), so the parser's checks (no cache
   * flags, URL sources only when allowed, media sniffing, size limits) always
   * apply.
   */
  readonly input?: string | AiUserInput;
  /** Decisions for calls that awaited approval; see {@link AiApproval}. */
  readonly approvals?: readonly AiApproval[];
  /** `none` forbids tool calls this run (tools are still described, keeping the cache warm). */
  readonly toolChoice?: 'auto' | 'none';
  /** Let one response call several tools (default `true`). */
  readonly parallelToolCalls?: boolean;
  /** Output-token cap per provider call (default 16 000). */
  readonly maxOutputTokens?: number;
  readonly effort?: AiEffort;
  readonly reasoning?: 'omitted' | 'summarized';
  readonly stopSequences?: readonly string[];
  /** Prompt caching (default `auto`). */
  readonly cache?: 'auto' | 'off';
  readonly limits?: AiLimits;
  /** Prices each response's usage iterations; required by `limits.maxCostMicroUsd`. */
  readonly pricing?: AiPricing;
  /** A deadline for the whole run in milliseconds; 0 or absent means none. */
  readonly timeoutMs?: number;
  /** The longest silence between two streamed parts (default 60 000; 0 means none). */
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Propagation headers (traceparent, tracestate, baggage) sent with every provider call. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerOptions?: AiProviderOptions;
  /**
   * Awaited after each provider step's assistant message is final and before
   * any of its tools runs: persist `appended` here, so a crash during tool
   * execution leaves a transcript a later run can resume. A throw fails the
   * run with `checkpoint_failed` and no tool runs.
   */
  readonly onStepFinish?: (checkpoint: AiCheckpoint) => void | Promise<void>;
  /**
   * Awaited after a step's tool results are appended and before the next
   * provider call: persist them, so completed side effects are recorded as
   * soon as they happen. A throw fails the run with `checkpoint_failed`.
   */
  readonly onToolResults?: (checkpoint: AiCheckpoint) => void | Promise<void>;
}

/** A run without tools; the app context is optional. */
export interface AiRunWithoutTools<C extends AiBaseContext> extends AiRunCommonOptions {
  readonly tools?: undefined;
  readonly context?: C;
}

/** A run with tools; the app context (at least the actor) is required. */
export interface AiRunWithTools<C extends AiBaseContext> extends AiRunCommonOptions {
  readonly tools: readonly AiTool<unknown, unknown, C>[];
  /**
   * Passed to every tool as its context, with the call id, step, and signal
   * added. A plain object (a class instance is refused with
   * `invalid_options`), since each call receives a copy of its own properties.
   */
  readonly context: C;
}

/** Options for `run` and `generate`. */
export type AiRunOptions<C extends AiBaseContext = AiBaseContext> =
  AiRunWithoutTools<C> | AiRunWithTools<C>;

/** One provider call of a run. */
export interface AiStep {
  readonly index: number;
  readonly response: AiProviderResponse;
  readonly usage: AiUsage;
  /** Present when `pricing` was given. */
  readonly costMicroUsd?: number;
  /** The assistant message the step appended; absent when it was not appended (refusal, truncated tool call). */
  readonly message?: AiMessage;
  /** The results of the step's tool calls, in call order. */
  readonly toolResults: readonly AiToolResultPart[];
}

/** How a run ended. */
export type AiRunStatus = 'completed' | 'awaiting-approval' | 'aborted' | 'failed';

/** What a run settles with. Never a rejection. */
export interface AiResult {
  readonly status: AiRunStatus;
  /** The text of the last assistant message the run appended, or `''`. */
  readonly text: string;
  /** The last step's finish reason; absent when no provider call finished. */
  readonly finishReason?: AiFinishReason;
  /** Every message the run added to the history, the input first. */
  readonly appended: readonly AiMessage[];
  /** History, input, and appended messages. */
  readonly messages: readonly AiMessage[];
  readonly steps: readonly AiStep[];
  readonly usage: AiUsage;
  /** Present when `pricing` was given. */
  readonly costMicroUsd?: number;
  /** The calls waiting for a decision when `status` is `awaiting-approval`; else empty. */
  readonly pendingApprovals: readonly AiPendingToolCall[];
  /** Why the run stopped when `status` is `aborted` or `failed`. */
  readonly error?: AiError;
}

/** One event of a run, in order. The last event is always `finish`. */
export type AiRunEvent =
  | { readonly type: 'step-start'; readonly step: number }
  | { readonly type: 'text-delta'; readonly step: number; readonly delta: string }
  | { readonly type: 'reasoning-delta'; readonly step: number; readonly delta: string }
  | {
      readonly type: 'tool-call-start';
      readonly step: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool-call';
      readonly step: number;
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      /** Whether the tool lets the browser see its input and output. */
      readonly exposeToBrowser: boolean;
    }
  | {
      readonly type: 'step-finish';
      readonly step: number;
      readonly finishReason: AiFinishReason;
      readonly usage: AiUsage;
      readonly costMicroUsd?: number;
      /** The messages this step appended (empty when its response was not appended). */
      readonly appended: readonly AiMessage[];
    }
  | { readonly type: 'approval-required'; readonly calls: readonly AiPendingToolCall[] }
  | {
      readonly type: 'tool-result';
      readonly id: string;
      readonly name: string;
      readonly isError: boolean;
      readonly output: AiToolOutput;
      readonly code?: AiToolErrorCode;
      readonly exposeToBrowser: boolean;
    }
  | { readonly type: 'tool-results'; readonly message: AiMessage }
  | { readonly type: 'finish'; readonly result: AiResult };

/**
 * A running (or not yet started) run. Iterate it to stream events with
 * backpressure; the run advances only as fast as the iterator is pulled.
 * Reading `result` without iterating drives the run by itself; an
 * iteration started later replays the events so far and then drives the run
 * itself, with backpressure again. A run can be iterated once; leaving the loop early aborts it, and
 * `result` still settles (as `aborted`, with everything appended so far).
 */
export interface AiRun extends AsyncIterable<AiRunEvent> {
  readonly result: Promise<AiResult>;
  abort(): void;
}
