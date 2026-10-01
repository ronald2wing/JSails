/**
 * {@link run} and {@link generate}: start a run and drive it.
 *
 * `run` validates its options synchronously and returns an {@link AiRun}
 * that has not started. Iterating it drives the loop one event at a time, so
 * a paused consumer pauses the provider stream too; leaving the loop early
 * aborts the run and finishes it in the background so `result` still
 * settles. Reading `result` without iterating drives the run by itself and
 * keeps its events; a later iteration sees all of them and then drives the
 * run itself, so backpressure returns as soon as something iterates.
 * `generate` is `run(options).result`: the same path, never a separate one.
 */

import { AiError } from '../errors/ai-error.js';
import type { AiBaseContext } from '../content/types.js';
import type { AiResult, AiRun, AiRunEvent, AiRunOptions } from './run-contract.js';
import { createRunControl } from './run-control.js';
import { runLoop } from './run-loop.js';
import { readRunOptions } from './run-options.js';
import { detach, escalate } from 'jsails/support';

type Pull = IteratorResult<AiRunEvent, AiResult>;

/**
 * Start a run. Throws a value-free `AiError` for invalid options, messages,
 * input, or approvals; after that, every outcome is a settled
 * {@link AiResult}.
 */
export function run<C extends AiBaseContext = AiBaseContext>(options: AiRunOptions<C>): AiRun {
  const setup = readRunOptions(options);
  const control = createRunControl(setup.timeoutMs, setup.signal);
  const loop = runLoop(setup, control);

  let settle: (result: AiResult) => void = () => undefined;
  const result = new Promise<AiResult>((resolve) => {
    settle = resolve;
  });

  // Pulls are serialized: a generator must not be advanced concurrently.
  let chain: Promise<unknown> = Promise.resolve();
  let done = false;
  const pull = (): Promise<Pull> => {
    const next = chain.then(async (): Promise<Pull> => {
      const step = await loop.next();
      // `finish` carries the final result, so `result` settles as soon as a
      // consumer has seen it, even if it never pulls the iterator's end.
      const final =
        step.done === true
          ? step.value
          : step.value.type === 'finish'
            ? step.value.result
            : undefined;
      if (final !== undefined && !done) {
        done = true;
        settle(final);
      }
      return step;
    });
    chain = next;
    return next;
  };
  const drain = async (): Promise<void> => {
    for (;;) {
      const step = await pull();
      if (step.done === true) return;
    }
  };

  // Reading `result` before anything iterates makes the run drive itself,
  // logging its events. When a consumer claims the iterator it reads that log
  // and then drives the run itself, so backpressure applies from then on,
  // whichever of the two was touched first (`void run.result.then(save)`
  // before `toEventStreamResponse(run)` is the common order).
  let claimed = false;
  let selfDriving = false;
  let handedOver = false;
  let ended = false;
  const log: AiRunEvent[] = [];
  let selfLoop: Promise<void> = Promise.resolve();

  const selfDrive = (): void => {
    selfDriving = true;
    selfLoop = (async (): Promise<void> => {
      while (!handedOver) {
        const step = await pull();
        if (step.done === true) {
          ended = true;
          return;
        }
        log.push(step.value);
      }
    })();
  };

  const consumerIterator = (): AsyncIterator<AiRunEvent> => {
    let closed = false;
    let index = 0;
    const close = (): IteratorResult<AiRunEvent> => {
      closed = true;
      return { done: true, value: undefined };
    };
    return {
      async next(): Promise<IteratorResult<AiRunEvent>> {
        if (closed) return { done: true, value: undefined };
        // A self-driving loop finishes its pull in flight before handing over.
        await selfLoop;
        if (closed) return { done: true, value: undefined };
        const logged = log[index];
        if (logged !== undefined) {
          index += 1;
          return { done: false, value: logged };
        }
        if (ended) return close();
        const step = await pull();
        if (step.done === true) {
          ended = true;
          return close();
        }
        return { done: false, value: step.value };
      },
      async return(): Promise<IteratorResult<AiRunEvent>> {
        if (!closed) {
          closed = true;
          if (!done) {
            control.stop('aborted');
            detach(selfLoop.then(drain), escalate);
          }
        }
        return { done: true, value: undefined };
      },
    };
  };

  return Object.freeze({
    get result(): Promise<AiResult> {
      if (!claimed && !selfDriving) selfDrive();
      return result;
    },
    abort(): void {
      control.stop('aborted');
    },
    [Symbol.asyncIterator](): AsyncIterator<AiRunEvent> {
      if (claimed) {
        throw new AiError('invalid_options', 'a run can be iterated only once', {
          context: { reason: 'iterated_twice' },
        });
      }
      claimed = true;
      handedOver = true;
      return consumerIterator();
    },
  });
}

/** Run to the end and return the result: `run(options).result`. */
export async function generate<C extends AiBaseContext = AiBaseContext>(
  options: AiRunOptions<C>,
): Promise<AiResult> {
  return run(options).result;
}
