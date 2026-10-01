/**
 * `replayProvider` and `parseFixture`: a fixture made from a fake provider's
 * parts replays the same run, survives a JSON round trip, responses play in
 * sequence with `remaining` counting down, a request past the end is a
 * value-free `replay_exhausted`, malformed fixtures name only the failing
 * place, and a contract-breaking fixture is caught by the run loop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { generate } from '../../src/run/run.js';
import type { AiProviderStreamPart } from '../../src/provider/contract.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';
import { parseFixture, replayProvider } from '../../src/testing/replay-provider.js';

const request = {
  model: 'm',
  instructions: [],
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  toolChoice: 'auto',
  parallelToolCalls: true,
  maxOutputTokens: 100,
  cache: 'off',
} as const;
const init = { signal: new AbortController().signal, headers: {} };

async function partsOf(text: string): Promise<AiProviderStreamPart[]> {
  const parts: AiProviderStreamPart[] = [];
  for await (const part of createFakeProvider([{ text, chunkSize: 2 }], { id: 'recorded' }).stream(
    request,
    init,
  )) {
    parts.push(part);
  }
  return parts;
}

describe('replayProvider', () => {
  it('replays recorded parts in sequence after a JSON round trip', async () => {
    const fixture = JSON.parse(
      JSON.stringify({
        v: 1,
        provider: 'recorded',
        responses: [{ parts: await partsOf('first') }, { parts: await partsOf('second') }],
      }),
    ) as unknown;
    const provider = replayProvider(fixture);
    assert.equal(provider.id, 'recorded');
    assert.equal(provider.remaining, 2);
    const one = await generate({ model: provider.model(), input: 'a' });
    assert.equal(one.text, 'first');
    assert.equal(provider.remaining, 1);
    const two = await provider.generate(request, init);
    assert.deepEqual(two.message.parts, [{ type: 'text', text: 'second' }]);
    assert.equal(provider.remaining, 0);
    assert.equal(provider.requests.length, 2);
  });

  it('fails a request past the end with replay_exhausted', async () => {
    const provider = replayProvider({ v: 1, responses: [] });
    assert.equal(provider.id, 'replay');
    const result = await generate({ model: provider.model(), input: 'a' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'provider_failed');
    assert.equal(result.error?.context.reason, 'replay_exhausted');
  });

  it('leaves contract checks to the run loop', async () => {
    const provider = replayProvider({
      v: 1,
      responses: [{ parts: [{ type: 'text-delta', delta: 'no start' }] }],
    });
    const result = await generate({ model: provider.model(), input: 'a' });
    assert.equal(result.error?.code, 'provider_failed');
  });

  it('honours abort between parts', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = replayProvider({ v: 1, responses: [{ parts: await partsOf('x') }] });
    await assert.rejects(
      provider.generate(request, { signal: controller.signal, headers: {} }),
      (error) => error instanceof AiError && error.code === 'aborted',
    );
  });
});

describe('parseFixture', () => {
  it('names only the failing place', () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [null, { reason: 'root' }],
      [{ v: 2, responses: [] }, { reason: 'v' }],
      [{ v: 1, provider: '', responses: [] }, { reason: 'provider' }],
      [{ v: 1 }, { reason: 'responses' }],
      [
        { v: 1, responses: [{}] },
        { reason: 'response', response: 0 },
      ],
      [
        { v: 1, responses: [{ parts: [] }, { parts: [{ type: 'CANARY' }] }] },
        { reason: 'part', response: 1, part: 0 },
      ],
      [
        { v: 1, responses: [{ parts: [{ type: 'text-delta', delta: 1n }] }] },
        { reason: 'part', response: 0, part: 0 },
      ],
    ];
    for (const [value, context] of cases) {
      assert.throws(
        () => parseFixture(value),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          JSON.stringify(error.context) === JSON.stringify(context) &&
          !error.message.includes('CANARY'),
      );
    }
  });

  it('returns a deep-frozen fixture', () => {
    const fixture = parseFixture({
      v: 1,
      responses: [{ parts: [{ type: 'text-delta', delta: 'x' }] }],
    });
    assert.ok(Object.isFrozen(fixture.responses[0]?.parts[0]));
  });
});
