# @jsails/ai

A provider-neutral AI runtime for [JSails](https://jsails.org): one streaming run loop (`run`, `generate`, `countTokens`) with tool use, approvals bound to trusted history, checkpoints, budgets, and timeouts; a content model that replays each provider's raw content losslessly, transcript validation and an untrusted-input parser, tools that run under the caller's authority with per-provider strict-schema lowering, `generateObject` for schema-validated structured output, integer micro-USD cost accounting, an append-only conversation codec, the ai.v1 server-sent event stream (`toEventStreamResponse`, with backpressure, heartbeats, and cancellation), and the provider contract adapters implement.

Two server-only adapters ship as subpaths: `@jsails/ai/anthropic` (Claude, on the optional peer `@anthropic-ai/sdk`) and `@jsails/ai/openai-compatible` (any Chat Completions endpoint, on the optional peer `openai`). Three more subpaths: `@jsails/ai/client` (browser-safe: a WHATWG SSE parser, `readAiEvents`, and `reduceAiEvents`), `@jsails/ai/testing` (a scripted fake provider, a sequence replay provider, and an in-memory conversation), and `@jsails/ai/mcp` (MCP server tools as tools, from the official `@modelcontextprotocol/client` or any structural source; untrusted servers always need approval).

```sh
npm install @jsails/ai
npm install @anthropic-ai/sdk   # for @jsails/ai/anthropic
npm install openai              # for @jsails/ai/openai-compatible
```

```ts
import { parseUserInput, run, toEventStreamResponse } from '@jsails/ai';
import { createAnthropic } from '@jsails/ai/anthropic';

const anthropic = createAnthropic({ apiKey: secrets.anthropicKey });

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const handle = run({
    model: anthropic.model('claude-opus-5-5'),
    history: conversation.messages, // loaded on the server: trusted
    input: parseUserInput(body.input), // from the browser: text, images, files only
    tools: [lookupOrder, cancelOrder],
    context: { actor },
  });
  void handle.result.then(save); // settles even when the browser disconnects
  return toEventStreamResponse(handle, { signal: request.signal });
}
```

The root entry and `@jsails/ai/client` are browser-safe: they load no `node:*` module, no provider SDK, and no server-only `jsails` module, which the package's tests check against the real module graph.

Documentation: <https://jsails.org/docs/ai>
