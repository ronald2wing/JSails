/**
 * {@link countTokens}: the input tokens a run's first request would use.
 *
 * The request is built exactly as `run` builds its first step (the same
 * option checks, transcript split, tool lowering, and request shape), so the
 * count matches what the run would send. A provider without token counting
 * is `unsupported_capability`.
 */

import { AiError } from '../errors/ai-error.js';
import type { AiBaseContext } from '../content/types.js';
import { isTokenCount } from '../usage/usage.js';
import { providerError } from './provider-stream.js';
import type { AiRunCommonOptions, AiRunOptions } from './run-contract.js';
import { createRunControl, stopError } from './run-control.js';
import { readRunOptions } from './run-options.js';
import { RunState } from './run-state.js';

/** Options for {@link countTokens}: the request-shaping subset of a run's options. */
export type CountTokensOptions<C extends AiBaseContext = AiBaseContext> = Pick<
  AiRunCommonOptions,
  | 'model'
  | 'instructions'
  | 'history'
  | 'input'
  | 'toolChoice'
  | 'parallelToolCalls'
  | 'maxOutputTokens'
  | 'effort'
  | 'reasoning'
  | 'stopSequences'
  | 'cache'
  | 'timeoutMs'
  | 'signal'
  | 'headers'
  | 'providerOptions'
> &
  Pick<AiRunOptions<C>, 'tools' | 'context'>;

/**
 * Count the input tokens of the request a run with these options would send
 * first. Throws a value-free `AiError`.
 */
export async function countTokens<C extends AiBaseContext = AiBaseContext>(
  options: CountTokensOptions<C>,
): Promise<number> {
  const setup = readRunOptions(options as AiRunOptions<C>);
  const provider = setup.provider;
  if (!provider.capabilities.countTokens || typeof provider.countTokens !== 'function') {
    throw new AiError('unsupported_capability', 'the provider cannot count tokens', {
      context: { capability: 'count_tokens' },
    });
  }
  const request = new RunState(setup).request(setup.maxOutputTokens);
  const control = createRunControl(setup.timeoutMs, setup.signal);
  control.start();
  try {
    const count = await new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => reject(new AiError('aborted', 'the call was stopped'));
      if (control.signal.aborted) onAbort();
      control.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() =>
          provider.countTokens?.(request, { signal: control.signal, headers: setup.headers }),
        )
        .then(resolve, reject)
        .finally(() => control.signal.removeEventListener('abort', onAbort));
    });
    if (!isTokenCount(count)) {
      throw new AiError('provider_failed', 'the provider returned a malformed response', {
        context: { reason: 'token_count' },
      });
    }
    return count;
  } catch (error) {
    const reason = control.stopReason();
    if (reason !== undefined) throw stopError(reason);
    throw providerError(error);
  } finally {
    control.dispose();
  }
}
