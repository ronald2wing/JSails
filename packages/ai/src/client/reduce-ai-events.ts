/**
 * {@link reduceAiEvents}: fold ai.v1 events into one renderable assistant
 * message.
 *
 * The state is immutable (every event returns a new frozen object, so it
 * suits React state and `useReducer`). Parts keep the order the model
 * produced them in: consecutive text deltas grow one text part, a tool call
 * sits between the text before and after it, and a tool part moves through
 * its states in place. Events after `finish` change nothing.
 */

import type { AiErrorCode } from '../errors/ai-error.js';
import type { AiFinishReason, AiToolOutput } from '../content/types.js';
import type {
  AiWireApprovalCall,
  AiWireEvent,
  AiWireTool,
  AiWireToolState,
} from '../event-stream/wire-events.js';
import type { AiRunStatus } from '../run/run-contract.js';
import type { AiToolErrorCode } from '../tools/tool-invocation.js';
import type { AiUsage } from '../usage/usage.js';

/** A tool call's state in the browser: its wire state, or waiting for a decision. */
export type AiClientToolState = AiWireToolState | 'awaiting-approval';

/** A tool call as the browser renders it. */
export interface AiClientToolPart {
  readonly type: 'tool';
  readonly id: string;
  readonly name: string;
  readonly state: AiClientToolState;
  /** Present only for a tool the server exposes to the browser. */
  readonly input?: unknown;
  readonly output?: AiToolOutput;
  readonly code?: AiToolErrorCode;
}

/** One renderable part, in the order the model produced it. */
export type AiClientPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | AiClientToolPart;

/** The assistant reply so far. */
export interface AiClientMessage {
  /** `streaming` until `finish`, then the run's status. */
  readonly status: 'streaming' | AiRunStatus;
  readonly parts: readonly AiClientPart[];
  /** Every text part, joined by a blank line. */
  readonly text: string;
  /** Every reasoning part, joined by a blank line. */
  readonly reasoning: string;
  /** The calls waiting for a decision (only while `awaiting-approval`). */
  readonly pendingApprovals: readonly AiWireApprovalCall[];
  readonly finishReason?: AiFinishReason;
  readonly usage?: AiUsage;
  /** Why the run stopped, when it was aborted or failed. */
  readonly error?: AiErrorCode;
}

const EMPTY: AiClientMessage = Object.freeze({
  status: 'streaming',
  parts: Object.freeze([]),
  text: '',
  reasoning: '',
  pendingApprovals: Object.freeze([]),
});

function joined(parts: readonly AiClientPart[], type: 'text' | 'reasoning'): string {
  return parts.flatMap((part) => (part.type === type ? [part.text] : [])).join('\n\n');
}

function withParts(state: AiClientMessage, parts: AiClientPart[]): AiClientMessage {
  const frozen = Object.freeze(parts);
  return Object.freeze({
    ...state,
    parts: frozen,
    text: joined(frozen, 'text'),
    reasoning: joined(frozen, 'reasoning'),
  });
}

function appendDelta(
  state: AiClientMessage,
  type: 'text' | 'reasoning',
  delta: string,
): AiClientMessage {
  const parts = [...state.parts];
  const last = parts.at(-1);
  if (last !== undefined && last.type === type) {
    parts[parts.length - 1] = Object.freeze({ type, text: last.text + delta });
  } else {
    parts.push(Object.freeze({ type, text: delta }));
  }
  return withParts(state, parts);
}

function toolPart(
  previous: AiClientToolPart | undefined,
  update: Pick<AiWireTool, 'id' | 'name' | 'input' | 'output' | 'code'> & {
    readonly state: AiClientToolState;
  },
  hasInput: boolean,
): AiClientToolPart {
  const input = hasInput
    ? { input: update.input }
    : previous !== undefined && 'input' in previous
      ? { input: previous.input }
      : {};
  const output = update.output ?? previous?.output;
  const code = update.code ?? previous?.code;
  return Object.freeze({
    type: 'tool',
    id: update.id,
    name: update.name,
    state: update.state,
    ...input,
    ...(output === undefined ? {} : { output }),
    ...(code === undefined ? {} : { code }),
  });
}

function upsertTool(
  state: AiClientMessage,
  update: Pick<AiWireTool, 'id' | 'name' | 'input' | 'output' | 'code'> & {
    readonly state: AiClientToolState;
  },
  hasInput: boolean,
): AiClientMessage {
  const parts = [...state.parts];
  const at = parts.findIndex((part) => part.type === 'tool' && part.id === update.id);
  if (at === -1) {
    parts.push(toolPart(undefined, update, hasInput));
  } else {
    parts[at] = toolPart(parts[at] as AiClientToolPart, update, hasInput);
  }
  return withParts(state, parts);
}

/**
 * The message after `event`. Pass `undefined` (or nothing) as the first
 * state.
 */
export function reduceAiEvents(
  state: AiClientMessage | undefined,
  event: AiWireEvent,
): AiClientMessage {
  const current = state ?? EMPTY;
  if (current.status !== 'streaming') return current;
  switch (event.event) {
    case 'start':
    case 'step':
      return current;
    case 'text':
    case 'reasoning':
      return event.data.delta.length === 0
        ? current
        : appendDelta(current, event.event, event.data.delta);
    case 'tool':
      return upsertTool(current, event.data, 'input' in event.data);
    case 'approval': {
      let next = current;
      for (const call of event.data.calls) {
        next = upsertTool(next, { ...call, state: 'awaiting-approval' }, 'input' in call);
      }
      return Object.freeze({ ...next, pendingApprovals: event.data.calls });
    }
    case 'error':
      return Object.freeze({ ...current, error: event.data.code });
    case 'finish':
      return Object.freeze({
        ...current,
        status: event.data.status,
        ...(event.data.finishReason === undefined ? {} : { finishReason: event.data.finishReason }),
        usage: event.data.usage,
        pendingApprovals:
          event.data.status === 'awaiting-approval'
            ? current.pendingApprovals
            : EMPTY.pendingApprovals,
      });
  }
}
