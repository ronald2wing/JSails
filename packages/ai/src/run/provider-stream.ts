/**
 * Reading one provider response stream: {@link streamProviderResponse}
 * pulls parts on demand, checks them against the stream contract, enforces
 * the idle timeout, and returns the final response.
 *
 * The contract: `response-start` first, then text, reasoning, and tool-input
 * parts (a tool-input delta only for a started tool input), then exactly one
 * `response-end`, then nothing. Any other part, a part out of order, or a
 * stream that ends without `response-end` is `AiError('provider_failed')`.
 * A part is pulled only when the run's consumer asks for the next event, so
 * a paused consumer stops pulling from the provider (backpressure).
 */

import { AiError, isAiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import type {
  AiCallInit,
  AiProvider,
  AiProviderRequest,
  AiProviderResponse,
  AiProviderStreamPart,
} from '../provider/contract.js';
import { checkProviderResponse, providerFailed } from '../provider/provider-response.js';
import type { RunControl } from './run-control.js';

/** A streamed part the run turns into an event. */
export type StreamedPart =
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'reasoning-delta'; readonly delta: string }
  | { readonly type: 'tool-call-start'; readonly id: string; readonly name: string };

const STOPPED = Symbol('stopped');

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Map anything a provider threw to an `AiError`; an unknown error is `provider_failed`. */
export function providerError(error: unknown): AiError {
  if (isAiError(error)) return error;
  return new AiError('provider_failed', 'the provider call failed');
}

/**
 * The iterator's next part, raced against the run signal and the idle timer.
 * Rejects with {@link STOPPED} when the run is stopped (an idle timeout stops
 * it first), so the caller reads the reason from the control.
 */
function nextPart(
  iterator: AsyncIterator<AiProviderStreamPart>,
  idleTimeoutMs: number,
  control: RunControl,
): Promise<IteratorResult<AiProviderStreamPart>> {
  const signal = control.signal;
  if (signal.aborted) return Promise.reject(STOPPED);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(STOPPED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (idleTimeoutMs > 0) timer = setTimeout(() => control.stop('idle'), idleTimeoutMs);
    iterator.next().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Close the provider's iterator without waiting on it (it may be blocked on a socket). */
function closeQuietly(iterator: AsyncIterator<AiProviderStreamPart>): void {
  // The stream has already ended for its consumer; a provider that rejects on
  // close (a torn-down socket) has nobody left to report to.
  Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}

/**
 * Stream one provider response. Yields text, reasoning, and tool-call-start
 * parts and returns the checked final response. Throws an `AiError`; when the
 * run was stopped, the thrown error is irrelevant and the caller reports the
 * control's stop reason instead.
 */
export async function* streamProviderResponse(
  provider: AiProvider,
  request: AiProviderRequest,
  init: AiCallInit,
  idleTimeoutMs: number,
  control: RunControl,
): AsyncGenerator<StreamedPart, AiProviderResponse> {
  let iterator: AsyncIterator<AiProviderStreamPart>;
  try {
    iterator = provider.stream(request, init)[Symbol.asyncIterator]();
  } catch (error) {
    throw providerError(error);
  }
  let started = false;
  let response: AiProviderResponse | undefined;
  const toolInputs = new Set<string>();
  let finished = false;
  try {
    for (;;) {
      let result: IteratorResult<AiProviderStreamPart>;
      try {
        result = await nextPart(iterator, idleTimeoutMs, control);
      } catch (error) {
        if (error === STOPPED) throw new AiError('aborted', 'the run was stopped');
        throw providerError(error);
      }
      if (result.done === true) break;
      const part: unknown = result.value;
      if (response !== undefined) throw providerFailed('part_after_end');
      if (!isPlainObject(part) || typeof part.type !== 'string') throw providerFailed('part');
      if (!started && part.type !== 'response-start') throw providerFailed('part_order');
      switch (part.type) {
        case 'response-start':
          if (started || !isLabel(part.id) || !isLabel(part.model)) {
            throw providerFailed('response_start');
          }
          started = true;
          break;
        case 'text-delta':
        case 'reasoning-delta':
          if (typeof part.delta !== 'string') throw providerFailed('delta');
          if (part.delta.length > 0) yield { type: part.type, delta: part.delta };
          break;
        case 'tool-input-start':
          if (!isLabel(part.id) || !isLabel(part.name) || toolInputs.has(part.id)) {
            throw providerFailed('tool_input_start');
          }
          toolInputs.add(part.id);
          yield { type: 'tool-call-start', id: part.id, name: part.name };
          break;
        case 'tool-input-delta':
          if (!isLabel(part.id) || !toolInputs.has(part.id) || typeof part.delta !== 'string') {
            throw providerFailed('tool_input_delta');
          }
          break;
        case 'response-end':
          response = checkProviderResponse(part.response);
          break;
        default:
          throw providerFailed('part_type');
      }
    }
    finished = true;
  } finally {
    if (!finished) closeQuietly(iterator);
  }
  if (response === undefined) throw providerFailed('no_response_end');
  return response;
}
