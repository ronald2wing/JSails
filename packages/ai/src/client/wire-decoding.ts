/**
 * {@link decodeWireEvent}: one parsed SSE event checked against the ai.v1
 * shapes before the browser code sees it.
 *
 * An event name this version does not know is skipped (`undefined`), so a
 * newer server can add events without breaking an older client. A known
 * event with malformed data, or a `start` announcing another version, is
 * `AiError('stream_failed')` with a static reason; the payload is never
 * echoed.
 */

import { AI_ERROR_CODES, AiError, type AiErrorCode } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { AI_FINISH_REASONS, type AiFinishReason, type AiToolOutput } from '../content/types.js';
import { readToolOutput } from '../content/validate-messages.js';
import {
  AI_RUN_STATUSES,
  AI_TOOL_ERROR_CODES,
  AI_WIRE_TOOL_STATES,
  AI_WIRE_VERSION,
  type AiWireApprovalCall,
  type AiWireEvent,
  type AiWireToolState,
} from '../event-stream/wire-events.js';
import type { AiRunStatus } from '../run/run-contract.js';
import type { AiToolErrorCode } from '../tools/tool-invocation.js';
import { isAiUsage } from '../usage/usage.js';
import type { SseEvent } from './sse-parser.js';

/** The value-free error for a stream that is not well-formed ai.v1. */
export function streamFailed(reason: string, status?: number): AiError {
  return new AiError('stream_failed', 'the event stream is not a valid ai.v1 stream', {
    context: status === undefined ? { reason } : { reason, status },
  });
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readOutput(value: unknown): AiToolOutput {
  try {
    return readToolOutput(value, 0);
  } catch {
    throw streamFailed('tool_output');
  }
}

function readApprovalCall(value: unknown): AiWireApprovalCall {
  if (!isPlainObject(value) || !isLabel(value.id) || !isLabel(value.name)) {
    throw streamFailed('approval');
  }
  if (value.inputDigest !== undefined && !isLabel(value.inputDigest)) {
    throw streamFailed('approval');
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    ...(value.inputDigest === undefined ? {} : { inputDigest: value.inputDigest }),
    ...('input' in value ? { input: value.input } : {}),
  });
}

function decodeData(name: string, data: Record<string, unknown>): AiWireEvent | undefined {
  switch (name) {
    case 'start':
      if (data.v !== AI_WIRE_VERSION) throw streamFailed('version');
      return { event: 'start', data: { v: AI_WIRE_VERSION } };
    case 'step':
      if (!isIndex(data.index)) throw streamFailed('step');
      return { event: 'step', data: { index: data.index } };
    case 'text':
    case 'reasoning':
      if (typeof data.delta !== 'string') throw streamFailed(name);
      return { event: name, data: { delta: data.delta } };
    case 'tool': {
      if (!isLabel(data.id) || !isLabel(data.name)) throw streamFailed('tool');
      if (!AI_WIRE_TOOL_STATES.includes(data.state as AiWireToolState)) {
        throw streamFailed('tool');
      }
      if (data.code !== undefined && !AI_TOOL_ERROR_CODES.includes(data.code as AiToolErrorCode)) {
        throw streamFailed('tool');
      }
      return {
        event: 'tool',
        data: {
          id: data.id,
          name: data.name,
          state: data.state as AiWireToolState,
          ...('input' in data ? { input: data.input } : {}),
          ...(data.output === undefined ? {} : { output: readOutput(data.output) }),
          ...(data.code === undefined ? {} : { code: data.code as AiToolErrorCode }),
        },
      };
    }
    case 'approval':
      if (!Array.isArray(data.calls)) throw streamFailed('approval');
      return {
        event: 'approval',
        data: { calls: Object.freeze((data.calls as unknown[]).map(readApprovalCall)) },
      };
    case 'error':
      if (!AI_ERROR_CODES.includes(data.code as AiErrorCode)) throw streamFailed('error');
      return { event: 'error', data: { code: data.code as AiErrorCode } };
    case 'finish':
      if (!AI_RUN_STATUSES.includes(data.status as AiRunStatus)) throw streamFailed('finish');
      if (
        data.finishReason !== undefined &&
        !AI_FINISH_REASONS.includes(data.finishReason as AiFinishReason)
      ) {
        throw streamFailed('finish');
      }
      if (!isAiUsage(data.usage)) throw streamFailed('finish');
      return {
        event: 'finish',
        data: {
          status: data.status as AiRunStatus,
          ...(data.finishReason === undefined
            ? {}
            : { finishReason: data.finishReason as AiFinishReason }),
          usage: Object.freeze({ ...data.usage }),
        },
      };
    default:
      return undefined;
  }
}

const KNOWN = new Set([
  'start',
  'step',
  'text',
  'reasoning',
  'tool',
  'approval',
  'error',
  'finish',
]);

/** The ai.v1 event in `sse`, `undefined` for an event this version does not know. */
export function decodeWireEvent(sse: SseEvent): AiWireEvent | undefined {
  if (!KNOWN.has(sse.event)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    throw streamFailed('data');
  }
  if (!isPlainObject(data)) throw streamFailed('data');
  const event = decodeData(sse.event, data);
  if (event === undefined) return undefined;
  return Object.freeze({ event: event.event, data: Object.freeze(event.data) }) as AiWireEvent;
}
