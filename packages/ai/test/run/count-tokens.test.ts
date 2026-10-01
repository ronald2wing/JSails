/**
 * `countTokens`: the same request a run would send first, an unsupported
 * provider, a malformed count, header passthrough, and abort.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError, type AiErrorCode } from '../../src/errors/ai-error.js';
import { countTokens } from '../../src/run/count-tokens.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { scriptedProvider } from './scripted-provider.js';

const tool = defineTool({
  name: 'noop',
  description: 'Does nothing.',
  input: z.object({ id: z.string().optional() }),
  execute: () => 'ok',
});

function rejectsWith(promise: Promise<unknown>, code: AiErrorCode): Promise<void> {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof AiError && error.code === code,
  );
}

describe('countTokens', () => {
  it('counts the request a run would send first', async () => {
    const provider = scriptedProvider([], {}, async () => 42);
    const count = await countTokens({
      model: provider.model(),
      instructions: 'Be brief.',
      input: 'Hi',
      tools: [tool],
      context: { actor: { kind: 'user', id: 'u1' } },
      headers: { traceparent: '00-a-b-01' },
    });
    assert.equal(count, 42);
    const request = provider.requests[0];
    assert.equal(request?.messages.length, 1);
    assert.equal(request?.tools[0]?.name, 'noop');
    assert.deepEqual(request?.instructions, [{ text: 'Be brief.' }]);
    assert.deepEqual(provider.inits[0]?.headers, { traceparent: '00-a-b-01' });
  });

  it('refuses a provider that cannot count', async () => {
    await rejectsWith(
      countTokens({ model: scriptedProvider([], { countTokens: false }).model(), input: 'Hi' }),
      'unsupported_capability',
    );
    await rejectsWith(
      countTokens({ model: scriptedProvider([]).model(), input: 'Hi' }),
      'unsupported_capability',
    );
  });

  it('refuses a malformed count and maps provider errors', async () => {
    await rejectsWith(
      countTokens({ model: scriptedProvider([], {}, async () => -3).model(), input: 'Hi' }),
      'provider_failed',
    );
    await rejectsWith(
      countTokens({
        model: scriptedProvider([], {}, () => Promise.reject(new Error('boom'))).model(),
        input: 'Hi',
      }),
      'provider_failed',
    );
  });

  it('stops on abort and on its deadline', async () => {
    const hanging = scriptedProvider([], {}, () => new Promise(() => undefined));
    await rejectsWith(
      countTokens({ model: hanging.model(), input: 'Hi', signal: AbortSignal.abort() }),
      'aborted',
    );
    await rejectsWith(
      countTokens({ model: hanging.model(), input: 'Hi', timeoutMs: 10 }),
      'timed_out',
    );
  });
});
