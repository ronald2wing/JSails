/**
 * The `@jsails/ai/testing` entry: test doubles for apps built on
 * `@jsails/ai`. A scripted fake provider (text, reasoning, tool calls,
 * refusals, `length`, usage iterations, native blocks, delays, hangs, and
 * scripted errors), a sequence-mode replay provider over neutral JSON
 * fixtures, and an in-memory conversation that persists through the real
 * codec.
 *
 * ```ts
 * import { generate } from '@jsails/ai';
 * import { createFakeProvider } from '@jsails/ai/testing';
 *
 * const provider = createFakeProvider([
 *   { toolCalls: [{ name: 'lookup_order', input: { orderId: 'o_1' } }] },
 *   { text: 'Your order shipped yesterday.' },
 * ]);
 * const result = await generate({ model: provider.model(), input: 'Where is o_1?', tools, context });
 * ```
 */

export {
  createFakeProvider,
  type FakeIteration,
  type FakeProvider,
  type FakeProviderOptions,
  type FakeScript,
  type FakeToolCall,
  type FakeTurn,
} from './fake-provider.js';
export { createMemoryConversation, type MemoryConversation } from './memory-conversation.js';
export {
  parseFixture,
  replayProvider,
  type AiFixture,
  type AiFixtureResponse,
  type ReplayProvider,
  type ReplayProviderOptions,
} from './replay-provider.js';
