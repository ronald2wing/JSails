/**
 * The ai.v1 wire protocol: the events a run sends to a browser over
 * server-sent events, the projection from run events, and the SSE encoder.
 *
 * The wire is a deliberate, smaller view of a run. Tool calls appear by id,
 * name, and state; their input and output (and the approval digest) cross
 * only for a tool marked `exposeToBrowser`. Reasoning crosses only when the
 * server opts in. An `error` event carries the code alone, and `finish`
 * carries status, finish reason, and token usage, never cost. Each event is
 * one `event:` line and one `data:` line of JSON, which never holds a raw
 * CR or LF, so no payload can forge a field or end an event early.
 */

import type { AiErrorCode } from '../errors/ai-error.js';
import type { AiFinishReason, AiToolOutput } from '../content/types.js';
import type { AiRunEvent, AiRunStatus } from '../run/run-contract.js';
import type { AiToolErrorCode } from '../tools/tool-invocation.js';
import type { AiUsage } from '../usage/usage.js';

/** The wire protocol version a `start` event announces. */
export const AI_WIRE_VERSION = 1;

/** Where a tool call is, as the browser sees it. */
export type AiWireToolState = 'started' | 'called' | 'done' | 'failed';

/** Every {@link AiWireToolState}. */
export const AI_WIRE_TOOL_STATES: readonly AiWireToolState[] = Object.freeze([
  'started',
  'called',
  'done',
  'failed',
]);

/** Every {@link AiRunStatus}. */
export const AI_RUN_STATUSES: readonly AiRunStatus[] = Object.freeze([
  'completed',
  'awaiting-approval',
  'aborted',
  'failed',
]);

const TOOL_ERROR_CODES: Readonly<Record<AiToolErrorCode, true>> = {
  tool_input_invalid: true,
  tool_denied: true,
  approval_denied: true,
  unknown_tool: true,
  interrupted: true,
  tool_failed: true,
  tool_timed_out: true,
  tool_output_invalid: true,
  aborted: true,
};

/** Every {@link AiToolErrorCode}. */
export const AI_TOOL_ERROR_CODES: readonly AiToolErrorCode[] = Object.freeze(
  Object.keys(TOOL_ERROR_CODES) as AiToolErrorCode[],
);

/** A tool call's progress on the wire. */
export interface AiWireTool {
  readonly id: string;
  readonly name: string;
  readonly state: AiWireToolState;
  /** The model's input; only for a tool marked `exposeToBrowser`, once `called`. */
  readonly input?: unknown;
  /** The result; only for a tool marked `exposeToBrowser`, once `done` or `failed`. */
  readonly output?: AiToolOutput;
  /** Why the call failed, when `state` is `failed`. */
  readonly code?: AiToolErrorCode;
}

/** A call that waits for a human decision, as the browser sees it. */
export interface AiWireApprovalCall {
  readonly id: string;
  readonly name: string;
  /**
   * Only for a tool marked `exposeToBrowser`, with `input`: the digest binds
   * a decision to the input the person saw. For a hidden tool the server
   * builds the approval from its own `pendingApprovals`.
   */
  readonly inputDigest?: string;
  readonly input?: unknown;
}

/** How the run ended, as the browser sees it. */
export interface AiWireFinish {
  readonly status: AiRunStatus;
  /** Absent when no provider call finished. */
  readonly finishReason?: AiFinishReason;
  readonly usage: AiUsage;
}

/** One ai.v1 event. The first is `start`; the last is `finish`. */
export type AiWireEvent =
  | { readonly event: 'start'; readonly data: { readonly v: 1 } }
  | { readonly event: 'step'; readonly data: { readonly index: number } }
  | { readonly event: 'text'; readonly data: { readonly delta: string } }
  | { readonly event: 'reasoning'; readonly data: { readonly delta: string } }
  | { readonly event: 'tool'; readonly data: AiWireTool }
  | { readonly event: 'approval'; readonly data: { readonly calls: readonly AiWireApprovalCall[] } }
  | { readonly event: 'error'; readonly data: { readonly code: AiErrorCode } }
  | { readonly event: 'finish'; readonly data: AiWireFinish };

/** The name of an {@link AiWireEvent}. */
export type AiWireEventName = AiWireEvent['event'];

/** What the projection lets through. */
export interface AiWireProjectionOptions {
  /** Send reasoning deltas (default `false`: reasoning can paraphrase instructions). */
  readonly reasoning?: boolean;
}

/** Turns a run's events into wire events. */
export interface AiWireProjector {
  /** The events for one run event (often none). */
  project(event: AiRunEvent): readonly AiWireEvent[];
}

const NONE: readonly AiWireEvent[] = Object.freeze([]);

function wire(event: AiWireEvent): readonly AiWireEvent[] {
  return Object.freeze([Object.freeze(event)]);
}

/**
 * A projection of one run's events onto the wire. Whether a call is exposed
 * is read from each event itself, so the projection of a resumed run (which
 * emits no `tool-call` events for the calls it resumes) is as complete as the
 * first run's.
 */
export function createWireProjector(options: AiWireProjectionOptions = {}): AiWireProjector {
  const reasoning = options.reasoning === true;
  return {
    project(event: AiRunEvent): readonly AiWireEvent[] {
      switch (event.type) {
        case 'step-start':
          return wire({ event: 'step', data: { index: event.step } });
        case 'text-delta':
          return event.delta.length === 0
            ? NONE
            : wire({ event: 'text', data: { delta: event.delta } });
        case 'reasoning-delta':
          return !reasoning || event.delta.length === 0
            ? NONE
            : wire({ event: 'reasoning', data: { delta: event.delta } });
        case 'tool-call-start':
          return wire({
            event: 'tool',
            data: { id: event.id, name: event.name, state: 'started' },
          });
        case 'tool-call':
          return wire({
            event: 'tool',
            data: {
              id: event.id,
              name: event.name,
              state: 'called',
              ...(event.exposeToBrowser ? { input: event.input } : {}),
            },
          });
        case 'approval-required':
          return wire({
            event: 'approval',
            data: {
              calls: Object.freeze(
                event.calls.map((call) =>
                  Object.freeze({
                    id: call.id,
                    name: call.name,
                    ...(call.exposeToBrowser
                      ? { inputDigest: call.inputDigest, input: call.input }
                      : {}),
                  }),
                ),
              ),
            },
          });
        case 'tool-result':
          return wire({
            event: 'tool',
            data: {
              id: event.id,
              name: event.name,
              state: event.isError ? 'failed' : 'done',
              ...(event.exposeToBrowser ? { output: event.output } : {}),
              ...(event.isError && event.code !== undefined ? { code: event.code } : {}),
            },
          });
        case 'finish': {
          const result = event.result;
          const finish: AiWireEvent = {
            event: 'finish',
            data: {
              status: result.status,
              ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
              usage: result.usage,
            },
          };
          return result.error === undefined
            ? wire(finish)
            : Object.freeze([
                Object.freeze({ event: 'error', data: { code: result.error.code } } as const),
                Object.freeze(finish),
              ]);
        }
        case 'step-finish':
        case 'tool-results':
          return NONE;
      }
    },
  };
}

/** The SSE comment that keeps an idle connection open. Parsers ignore it. */
export const SSE_HEARTBEAT = ':\n\n';

/**
 * One wire event as SSE text. A payload that cannot be JSON (it never
 * happens for model JSON) loses its tool `input` rather than break the
 * stream.
 */
export function encodeWireEvent(event: AiWireEvent): string {
  let data: string;
  try {
    data = JSON.stringify(event.data);
  } catch {
    const copy: Record<string, unknown> = { ...event.data };
    delete copy.input;
    data = JSON.stringify(copy);
  }
  return `event: ${event.event}\ndata: ${data}\n\n`;
}
