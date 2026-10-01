---
title: AI
order: 30
section: Reference
---

# AI

`@jsails/ai` is a provider-neutral AI runtime. Its root entry is browser-safe
(no `node:*`, no provider SDK, no server-only `jsails` module) and holds the
pieces every AI feature is built from:

- a **content model** that carries text, images, documents, reasoning, tool
  calls, tool results, and each provider's raw content for lossless replay;
- **transcript validation** and an **untrusted-input parser** for what a
  browser submits;
- **tools** that run under the caller's authority, with per-provider
  **schema lowering** for strict mode;
- **`run` and `generate`**, one streaming run loop for plain replies and
  tool use, with approvals, checkpoints, budgets, and timeouts;
- **`generateObject`** for schema-validated structured output;
- **usage and cost** accounting in integer micro-USD;
- a serializable, append-only **conversation** codec;
- the **ai.v1 event stream** that carries a run to a browser, with
  backpressure, heartbeats, and cancellation;
- the **provider contract** adapters implement, and the value-free `AiError`.

Two server-only subpaths adapt real providers: `@jsails/ai/anthropic` (the
Claude Messages API, on the optional peer `@anthropic-ai/sdk`) and
`@jsails/ai/openai-compatible` (any Chat Completions endpoint, on the
optional peer `openai`). Install only the SDK you use. Three more subpaths
round it out: `@jsails/ai/client` reads the event stream in the browser,
`@jsails/ai/testing` has test doubles, and `@jsails/ai/mcp` turns MCP
server tools into tools a run can call.

## Messages

A message has a `role` (`'user' | 'assistant' | 'system'`) and a list of
typed `parts`:

| Part | Roles | Carries |
| --- | --- | --- |
| `text` | all | `text`, optional `cache: true` breakpoint |
| `image` | user | a `base64` (`image/jpeg`, `png`, `gif`, `webp`) or `url` source |
| `file` | user | a PDF or plain-text document, optional `title` |
| `reasoning` | assistant | readable reasoning text (empty when the provider omits it) |
| `tool-call` | assistant | `id`, `name`, and the model's JSON `input` |
| `tool-result` | user | `id`, `name`, `output` (text, or text and image items), `isError` |

Tool results go in the user message right after the assistant message that
made the calls. An assistant message produced by a provider also keeps that
provider's raw content array in `native`, so the same provider gets its own
blocks back unchanged (thinking signatures, citations, fallback and
server-tool blocks), while any other provider sees only the neutral parts.

```ts
import { systemMessage, textOf, userMessage, validateMessages } from '@jsails/ai';

const history = validateMessages([
  userMessage('Summarize the attached report.'),
  systemMessage('Answer in three bullet points.'),
]);
```

`validateMessages(value, { mode })` returns a normalized, deep-frozen copy
(unknown fields dropped) or throws `AiError('invalid_messages')` with only the
message index and a rule name in `context`. It enforces:

- known roles, and the parts each role may carry;
- the first message is a user message;
- a mid-conversation system message follows a user message and is last or
  followed by an assistant message;
- every tool call is answered by exactly one tool result, by id and name, in
  the immediately following user message, with tool results first in it;
- tool-call and tool-result ids are unique across the whole conversation;
- in `'request'` mode (the default), the list is non-empty and does not end
  with an assistant message. Current Claude models reject assistant prefill,
  so a response that stopped at the token limit cannot be continued by
  prefilling it. `'transcript'` mode, for stored conversations, allows an
  empty list, a trailing assistant message, and tool calls in the last
  message that are still waiting for results.

## Untrusted input

History is held on the server and trusted. What a browser submits is not.
`parseUserInput(value, limits)` turns a submitted string or part list into
one user message. It accepts only text, image, and file parts, so a client
can never inject tool calls, tool results, or approvals.

```ts
import { parseUserInput } from '@jsails/ai';

const input = parseUserInput(body.content, {
  maxParts: 8,
  maxMediaBytes: 10 * 1024 * 1024,
  allowUrl: (url) => url.hostname === 'cdn.example.com',
});
```

It drops prompt-cache flags (a client could otherwise exceed the
per-request breakpoint limit), caps parts (default 16), text (100 000
characters), and decoded media bytes (20 MiB), and checks every base64
payload's magic bytes against its declared media type. It refuses URL sources
unless `allowUrl` admits them, and accepts only `https:` URLs. A refusal is
`AiError('invalid_input')` with a static `reason`.

Its result is an `AiUserInput`, and that is the only kind of message `run`
takes as `input`. A message built any other way, even one that type-checks
as `AiMessage`, is refused with `invalid_input` (`reason: 'unparsed'`), so
these checks cannot be skipped by passing a request body straight through.

## Tools

`defineTool` takes a Zod schema or a data contract as `input`. `execute`
receives the validated input and a context with the actor, the tool call id,
the step, and an `AbortSignal` that fires when the run is aborted or the
tool's deadline passes (`timeoutMs`, default 30 000).

```ts
import { AiToolFailure, defineTool } from '@jsails/ai';
import { z } from 'zod';

const cancelOrder = defineTool({
  name: 'cancel_order',
  description: 'Cancel one of the current user’s open orders.',
  input: z.object({ orderId: z.string() }),
  authorize: async ({ orderId }, ctx) => orders.ownedBy(ctx.actor, orderId),
  needsApproval: true,
  execute: async ({ orderId }, ctx) => {
    const order = await orders.cancel(orderId, { signal: ctx.signal });
    if (order === undefined) throw new AiToolFailure('that order is already shipped');
    return { orderId, status: order.status };
  },
});
```

A data contract supplies the tool's name and description:

```ts
import { defineTool } from '@jsails/ai';
import { defineData } from 'jsails/data';
import { z } from 'zod';

const Preferences = defineData({
  name: 'set_preferences',
  description: 'Save the user’s display preferences.',
  properties: { theme: z.enum(['light', 'dark']), compact: z.boolean().optional() },
});

const setPreferences = defineTool({
  input: Preferences,
  execute: (input, ctx) => preferences.save(ctx.actor, input),
});
```

The contract is matched by shape (`name`, `description`, `schema`), so the AI
root never imports the data layer.

How a call runs:

- The model's input is validated through the full schema before anything
  else. An invalid input reaches the model as a fixed error result that names
  the failing paths and issue codes (never the values), and never reaches
  `execute`.
- `authorize(input, ctx)` runs next. A `false` or a throw becomes the fixed
  result `error: not permitted`.
- `needsApproval` (a boolean or a predicate) marks calls that need a human
  decision. A predicate runs under the tool's deadline and the run signal: one
  that throws or misses the deadline counts as "needs approval", and a run
  that stops while it waits settles at once. Before anyone is
  asked, `authorize` runs, so nobody approves a call the caller may not make;
  it runs again right before `execute`, so a decision made later is checked
  against the policy as it is then.
- Any error thrown by `execute` reaches the model as `error: the tool failed`,
  because an exception message can carry secrets or user data. Throw an
  `AiToolFailure` to show the model a message you deliberately make public.
- An `output` schema validates the result. The result is then sent verbatim
  when it is a string. Anything else is sent as JSON: bigints become decimal
  strings, and a value JSON would mangle (a cycle, a `Map`, a function, a
  non-finite number) becomes a fixed `tool_output_invalid` result.
  `toModelOutput` maps a result to text and image items instead.
- Results are cut to `maxResultChars` on a code-point boundary, with a
  marker. Images in a result are bounded too, by decoded bytes
  (`maxResultMediaBytes`, run default 20 MiB) and by count (run default 16):
  the image that crosses either bound is replaced by the marker and the rest
  of the result is dropped.
- The input property `INVALID_JSON` is reserved, and `defineTool` refuses a
  schema that declares it. An adapter wraps a tool input that was not a JSON
  object as `{ INVALID_JSON: text }`, and such a call always becomes an error
  result, whatever the schema would accept.

Tools are generic over an app context: `defineTool<typeof input, R, AppContext>`
types `ctx` as your context (which must include `actor`) plus the call fields.
The context must be a plain object: each call receives a copy of its own
properties, so `run` refuses a class instance (`invalid_options`) rather than
hand tools a context without its getters and methods.
Mark a tool `idempotent: true` when re-running an interrupted call is safe, and
`exposeToBrowser: true` to let its input and output reach the browser.

## Running a model

`run(options)` is the one path every model call with a transcript takes,
with or without tools. It returns an `AiRun`: iterate it for events, read
`result` for the outcome. `generate(options)` is `run(options).result`.

```ts
import { generate, parseUserInput } from '@jsails/ai';

const result = await generate({
  model,
  instructions: 'You are the support assistant for Example Shop.',
  history: conversation.messages,
  input: parseUserInput(body.content),
  tools: [lookupOrder, cancelOrder],
  context: { actor },
  limits: { maxSteps: 6, maxOutputTokensTotal: 20_000 },
  timeoutMs: 120_000,
});
```

`history` is the transcript your server loaded, and it is trusted. `input`
is what the browser just sent, and it is not: a string, or the message
`parseUserInput` made. Any other message is refused. A run that
offers tools needs a `context` with the `actor` they run for; every tool
receives that context plus the call id, the step, and a signal.

Each step streams one provider response and then:

- a refusal or content-filter stop fails the run with `refused`, and that
  response is not appended;
- tool calls cut off at the token limit fail the run with
  `output_truncated`, and nothing runs. A text reply cut off at the limit
  completes with `finishReason: 'length'` (it cannot be continued by
  prefill);
- a paused turn (`finishReason: 'pause'`) is sent back as is and continued;
- otherwise the assistant message is appended, `step-finish` is emitted,
  and `onStepFinish` is awaited **before any tool runs**. The calls then run
  at most `limits.toolConcurrency` (default 4) at a time, each under its own
  deadline, and all their results go into one user message, followed by
  `onToolResults`.

`result` always settles, never rejects. `status` is `completed`,
`awaiting-approval`, `aborted`, or `failed` (with `error`), and `appended`
holds every message the run added, the input first. Tools that already ran
before an abort or a failure keep their results, so persisting `appended` and
retrying never repeats a side effect it recorded.

```ts
import { appendToConversation, run } from '@jsails/ai';

const handle = run({ model, history, input, tools, context: { actor } });
for await (const event of handle) {
  if (event.type === 'text-delta') send(event.delta);
}
const { status, appended, usage } = await handle.result;
conversation = appendToConversation(conversation, { appended, usage });
```

The run advances only as fast as you pull events, so a slow consumer slows
the provider stream instead of buffering it. Leaving the loop early aborts
the run. Reading `result` without iterating drives the run by itself, keeping
its events; if something starts iterating later, it receives those events
and then drives the run itself, so backpressure applies again. Run options
are checked synchronously: a bad option, transcript, input, or approval
throws before anything is sent, so an endpoint can answer with a 400 instead
of starting a stream.

### Approvals

When a step has a call whose tool needs approval, none of that step's calls
runs. The run ends `awaiting-approval` with `pendingApprovals`: each with
`id`, `name`, `input`, `exposeToBrowser`, and an `inputDigest`, a SHA-256
over the actor, the call id, the tool name, and the input. Persist `appended`, show the calls,
and resume with the person's decisions and no new input:

```ts
const resumed = await generate({
  model,
  history: conversation.messages,
  approvals: body.approvals, // [{ id, name, inputDigest, decision: 'approve' | 'deny' }]
  tools,
  context: { actor },
});
```

A decision is honoured only if it names a call pending in the trusted
history, with the same tool name and the digest of that call for the same
actor. Anything else makes `run` (and `generate`) throw `invalid_input`
before anything is sent or run, so a client cannot approve a call it forged
or a call made for someone else. `toolCallDigest(actor, call)` computes the
digest. An
approved call runs (after `authorize` again), a denied one returns the fixed
result `error: denied by the user`, and the step's other calls run with it.
A call with no decision keeps the run waiting.

For a tool hidden from the browser, the browser never sees the input or the
digest. It sends back only `{ id, decision }`, and the server fills in the
rest from the `pendingApprovals` it saved. The digest still binds the
decision to the actor the call was made for:

```ts
import { generate, type AiApproval } from '@jsails/ai';

const approvals: AiApproval[] = saved.pendingApprovals.flatMap((call) => {
  const decision = body.decisions.find((entry) => entry.id === call.id)?.decision;
  return decision === 'approve' || decision === 'deny'
    ? [{ id: call.id, name: call.name, inputDigest: call.inputDigest, decision }]
    : [];
});
const resumed = await generate({ model, history, approvals, tools, context: { actor } });
```

### Resuming after a crash

If history ends with tool calls that have no results and no decisions are
given, the calls were interrupted: the process stopped after `onStepFinish`
and before their results were saved. A tool marked `idempotent: true` runs
again; any other call gets the fixed result `error: the tool call was
interrupted before it finished`, because it may already have had its side
effect. The model then decides what to do.

### Limits and timeouts

| Option | Default | Effect |
| --- | --- | --- |
| `limits.maxSteps` | 8 | provider calls per run; `step_limit` after |
| `limits.maxToolCallsPerStep` | 16 | more calls in one response fail with `tool_call_limit` |
| `limits.toolConcurrency` | 4 | calls running at once (1 when `parallelToolCalls: false`) |
| `limits.maxToolResultChars` | 100 000 | cap on the text of one tool result |
| `limits.maxToolResultMediaBytes` | 20 MiB | cap on the decoded image bytes of one tool result |
| `limits.maxToolResultImages` | 16 | cap on the images in one tool result |
| `limits.maxInputTokens` | none | stops before a step whose input would certainly exceed it |
| `limits.maxOutputTokensTotal` | none | each call's `maxOutputTokens` is clamped to what remains |
| `limits.maxCostMicroUsd` | none | needs `pricing`; checked before each step |
| `maxOutputTokens` | 16 000 | output cap of one call |
| `timeoutMs` | none | deadline for the whole run |
| `idleTimeoutMs` | 60 000 | longest silence between streamed parts |

A budget stop fails the run with `budget_exceeded`; its `context.budget`
says which. The cost cap can be overshot by at most one step, because a
step's price is known only after it. Aborting (`run.abort()` or `signal`)
fires the signal of the provider call and of every running tool and settles
`aborted`. A deadline or an idle stream settles `failed` with `timed_out`.
`headers` (`traceparent`, `tracestate`, `baggage`) are sent with every
provider call. `countTokens(options)` counts the input tokens of the request
a run with the same options would send first.

### Checkpointing and background jobs

A run that calls tools has side effects before it finishes, so persist as
it goes rather than only at the end. Two hooks are awaited inside the loop:

- `onStepFinish` runs after a step's assistant message is final and before
  any of its tools runs. Persist `appended` here. If the process dies while
  the tools run, the stored transcript ends with tool calls that have no
  results, and the next run resumes them (see above).
- `onToolResults` runs after a step's tool results are appended and before
  the next provider call. Persist again, so a completed side effect is on
  record as soon as it happened.

If either hook throws, the run fails with `checkpoint_failed` (the original
error is the `cause`) and nothing more runs. Each checkpoint carries the
whole `appended` list so far, so a store can write it with optimistic
concurrency against the revision it loaded:

```ts
import { appendToConversation, generate, type AiCheckpoint, type Conversation } from '@jsails/ai';

export async function generateReply(job: { conversationId: string; actorId: string }) {
  const loaded: Conversation = await conversations.load(job.conversationId);
  // Re-resolve the actor the job was queued for; never run tools as a system user.
  const actor = await users.actorFor(job.actorId);
  let stored = loaded;
  const save = async ({ appended, usage }: Pick<AiCheckpoint, 'appended' | 'usage'>) => {
    const next = appendToConversation(loaded, { appended, usage });
    await conversations.replace(next, { expectedRevision: stored.revision });
    stored = next;
  };
  const result = await generate({
    model,
    history: loaded.messages,
    tools,
    context: { actor },
    onStepFinish: save,
    onToolResults: save,
    timeoutMs: 10 * 60_000,
  });
  await save(result);
  return result.status; // 'awaiting-approval' stops here until a person decides
}
```

Every save is the loaded conversation plus everything the run appended so
far, written against the revision the previous save left, so a concurrent
writer is detected and a crash loses at most the step in progress. A job
retried after a crash loads the last checkpoint and resumes from it. Key
the job by conversation id and loaded revision so the same reply is not
queued twice. A run that ends `awaiting-approval` is saved and stops; the
approval request resumes it later.

## Schema lowering

Strict tool use and structured outputs accept only a subset of JSON Schema.
`lowerZodSchema(schema, profile)` (and `lowerJsonSchema` for a raw schema,
such as one from an MCP server) maps a schema into that subset. The lowered
schema accepts every value the original accepts:

| Profile | Used for | Rules |
| --- | --- | --- |
| `anthropic-strict` | Claude strict tools, structured outputs | `additionalProperties: false` everywhere; optional stays optional; `minItems: 1` kept; recursion rejected |
| `openai-strict` | Chat Completions strict mode | `additionalProperties: false` everywhere; every property required: an optional property becomes `T \| null`, and `restore` drops those nulls again; numeric bounds, `multipleOf`, `minItems`, `maxItems`, and `pattern` kept; recursion kept through `$defs` |
| `loose` | non-strict tools | the schema minus `$schema` |

Constraints a profile keeps stay on the wire, where constrained decoding
enforces them as the model writes. The rest (string lengths everywhere;
numeric bounds, patterns, and most array bounds under `anthropic-strict`; a
pattern with a lookaround or a backreference; an unsupported format, which
includes `uri` under `openai-strict`) are moved into the description as a
hint. The full Zod schema always validates the model's
output afterwards, so lowering never weakens the guarantee. Records,
tuples, `z.unknown()`, and conflicting intersections cannot be lowered to a
strict profile. A tool is strict by default, so `defineTool` lowers its
schema under both strict profiles when it is defined and fails with
`AiError('invalid_tool')` instead of losing strictness later. Set
`strict: false` for such a tool. Lowering is deterministic and memoized, so
the same tool always serializes to the same bytes, which prompt caching needs.

## Structured output

`generateObject` asks the model for one value of a schema. It uses the
provider's native response format, or a single tool when the provider has no
native format. Current Claude models reject forced tool choice, so the
fallback asks the model to call the tool through the instructions instead.

```ts
import { generateObject, userMessage } from '@jsails/ai';
import { z } from 'zod';

const { object, usage } = await generateObject({
  model,
  instructions: 'Extract the invoice fields exactly as written.',
  messages: [userMessage(invoiceText)],
  schema: z.object({ number: z.string(), total: z.number(), dueDate: z.iso.date().optional() }),
  timeoutMs: 60_000,
});
```

A refusal is `refused`, a cut-off answer is `output_truncated`, and output
that does not parse or pass the schema is `output_invalid`. A schema whose
root is not an object is wrapped as `{ value }` on the wire and unwrapped
before it is returned; the root property `INVALID_JSON` is reserved, as for
tools. `timeoutMs` and `signal` settle the call even when a custom provider
ignores its abort signal.

## Usage and cost

`AiUsage` counts every input token in `inputTokens`, cache reads and writes
included, and breaks out `cacheReadTokens`, `cacheWriteTokens`, and optional
`reasoningTokens`. `normalizeUsage` converts a provider's numbers, whichever
convention it uses (`inputIncludesCache`). `addUsage` sums usages.

The package ships no price table, because prices change. Cost is computed
per usage iteration, in integer micro-USD, from a pricing function.
`createPricingTable` builds one with prompt-size tiers and speed overrides:

```ts
import { costMicroUsd, createPricingTable } from '@jsails/ai';

const pricing = createPricingTable({
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    speeds: { fast: { inputPerMTok: 8, outputPerMTok: 40 } },
  },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    tiers: [{ aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 }],
  },
});

const micros = costMicroUsd(response.iterations, pricing);
```

A response served by a server-side fallback carries one iteration per model,
each priced at its own rate. A model or speed missing from the table throws
instead of costing nothing, so an unpriced model can never slip past a budget.

## Conversations

A `Conversation` (wire version 1) is plain JSON: `id`, `ownerId`, an
append-only `messages` transcript, summed `usage`, and a `revision`.

```ts
import { appendToConversation, createConversation, parseConversation } from '@jsails/ai';

let conversation = createConversation({ owner: actor });
conversation = appendToConversation(conversation, result); // a run result: appended + usage
await store.save(JSON.stringify(conversation), { expectedRevision: conversation.revision - 1 });

const restored = parseConversation(JSON.parse(await store.load(id)));
```

`appendToConversation` never rewrites earlier messages, because providers
that bind reasoning to an unedited history reject an edited prefix. The
combined transcript must still be valid, and the revision grows by one.
`parseConversation` is the only way persisted data comes back in. It throws
`AiError('invalid_conversation')` naming only the failing field. Storage,
ownership checks, and optimistic concurrency belong to your data layer.

## Streaming to the browser

`toEventStreamResponse(run)` turns a run into a `text/event-stream`
response in the ai.v1 wire protocol. `@jsails/ai/client` reads it in the
browser.

```ts
import { run, toEventStreamResponse } from '@jsails/ai';

export async function POST(request: Request): Promise<Response> {
  const handle = run({ model, history, input, tools, context: { actor } });
  void handle.result.then((result) => saveConversation(result)); // settles even on disconnect
  return toEventStreamResponse(handle, { signal: request.signal });
}
```

The stream is pull-based with a high-water mark of zero. The run advances
only when the HTTP layer reads the next chunk, so a slow browser slows the
provider stream instead of filling memory. While the reader waits on a
quiet run, a comment line goes out every `heartbeatMs` (default 15 000;
`0` turns heartbeats off) to keep proxies from closing the connection.
Heartbeats never pile up behind unread bytes. When the browser goes away,
the stream is cancelled, or `signal` fires, the run is aborted. It still
settles `result` as `aborted` with everything it appended, so save the
result, not what the browser saw. The response sends `cache-control:
no-store, no-transform` and `x-accel-buffering: no`. A run can be consumed
only once, so `toEventStream` claims it at once and throws
`invalid_options` for a run that is already being iterated.

The wire shows less than the run:

| Event | Data |
| --- | --- |
| `start` | `{ v: 1 }`, always first |
| `step` | `{ index }` at each provider call |
| `text` | `{ delta }` |
| `reasoning` | `{ delta }`, only with `reasoning: true` (reasoning can paraphrase your instructions) |
| `tool` | `{ id, name, state }`: `started`, `called`, `done`, or `failed` (with its tool error `code`) |
| `approval` | `{ calls: [{ id, name }] }` |
| `error` | `{ code }` only, before a failed or aborted `finish` |
| `finish` | `{ status, finishReason?, usage }`, always last; never cost |

A tool's `input` and `output` cross only for a tool marked
`exposeToBrowser: true`. The same goes for an approval call's `input` and
`inputDigest`, so a person can approve exactly what they saw. For a hidden
tool, the browser sends back `{ id, decision }` and the server builds the
approval from the `pendingApprovals` it saved. Each event is one `event:`
line and one `data:` line of JSON. JSON never holds a raw CR or LF, so no
payload can forge a field or end an event early.

In the browser, `readAiEvents(response, { signal })` yields typed events
and `reduceAiEvents` folds them into one renderable message. The message
is immutable, so it works as React state.

```ts
import { readAiEvents, reduceAiEvents, type AiClientMessage } from '@jsails/ai/client';

const response = await fetch('/chat', { method: 'POST', body, signal });
let message: AiClientMessage | undefined;
for await (const event of readAiEvents(response, { signal })) {
  message = reduceAiEvents(message, event);
  render(message); // message.parts in model order, message.text, message.status
}
```

`readAiEvents` needs a 2xx `text/event-stream` response. It parses by the
WHATWG event-stream rules (`createSseParser` is exported too), decodes UTF-8
across chunk boundaries, and checks every event against the ai.v1 shapes.
An event name it does not know is skipped, so a newer server can add
events. A malformed event, a stream that does not start with `start`, or a
connection that drops before `finish` throws `AiError('stream_failed')`
(reason `truncated`, or `network` when the read itself fails), so a cut-off
reply is never taken for a complete one. Leaving the loop early or firing
`signal` cancels the body, which aborts the run on the server; the
iteration then throws `AiError('aborted')`.

## Testing

`@jsails/ai/testing` holds test doubles that go through the real run loop
and stream contract.

```ts
import { generate } from '@jsails/ai';
import { createFakeProvider, createMemoryConversation } from '@jsails/ai/testing';

const provider = createFakeProvider([
  { toolCalls: [{ name: 'lookup_order', input: { orderId: 'o_1' } }] },
  { text: 'Your order shipped yesterday.', chunkSize: 4 },
]);
const memory = createMemoryConversation({ owner: actor });
memory.append(await generate({ model: provider.model(), input: 'Where is o_1?', tools, context: { actor } }));
assert.equal(provider.requests.length, 2);
```

A fake turn can script `text`, `reasoning`, `toolCalls`, a `finishReason`
(`length` included), a `refusal` with its category, `usage`, per-model
usage `iterations`, raw `native` blocks, `chunkSize`, `delayMs`, `hang`
(wait for the abort signal), and an `error` code (with `errorAfterParts`
for a failure part way through). The provider records every request and
call init, counts the parts pulled (for backpressure assertions), and
honours the abort signal. Default tool-call ids come from the transcript
length, so they stay unique across runs in one conversation. A script that
runs out fails the run with `invalid_options`. Pass a function instead of
an array to pick a turn per request.

`replayProvider(fixture)` plays recorded stream parts back, one response
per request, in order. A fixture is plain JSON
(`{ v: 1, provider?, responses: [{ parts }] }`) with no headers or keys,
and `parseFixture` checks it. A request past the end fails with
`provider_failed` (reason `replay_exhausted`), and `remaining` lets a test
check that every response was used. `createMemoryConversation` appends
through the real codec and a JSON round trip on every write. A run that
produced anything that would not survive persistence fails in the test, not
in production. It is a test helper, not a store.

## MCP tools

`@jsails/ai/mcp` turns an MCP server's tools into tools a run can call.

```ts
import { fromMcpClient, mcpTools } from '@jsails/ai/mcp';

// `client` is a connected `Client` from `@modelcontextprotocol/client`.
const { tools, skipped } = await mcpTools(fromMcpClient(client), {
  trusted: false,
  prefix: 'docs_',
});
const result = await generate({ model, input, tools, context: { actor } });
```

`fromMcpClient` adapts a connected official `Client` (any object with its
`listTools` and `callTool` shape works). It asks for the first page without
a cursor and follows any `nextCursor` it gets back, with bounds (`maxPages`
64 and `maxTools` 1 000 by default), treating a repeated cursor as an error.
The official client answers that first call by walking every page itself,
up to its own `ClientOptions.listMaxPages` (default 64), and returns no
cursor; the call is kept that way because it fills the client's cache that
`callTool` reads for output-schema validation. So with the official client
`listMaxPages` is the page bound, while `maxTools` applies either way and
`maxPages` and the cursor checks apply to a structural source. It forwards the call's abort signal, which the client
sends on as `notifications/cancelled`. A failed listing is
`AiError('mcp_failed')`, with the server's error kept only as `cause`. Any
other source can implement the structural `McpToolSource`.

Every server is someone else's code unless you say otherwise, and
`trusted` is required:

- **Approval.** An untrusted server's tools always need approval;
  `approval: 'destructive'` or `'never'` on an untrusted server throws. On
  a trusted server the default `'destructive'` asks unless a tool declares
  `readOnlyHint: true` or `destructiveHint: false`. Annotations are hints,
  so they count only when you trust the server.
- **Re-runs.** Only a trusted tool declared read-only or idempotent is
  re-run after an interruption.
- **Input.** Tools are sent non-strict, and the server validates its own
  input. A trusted server's input schema is also checked locally first. An
  untrusted one is checked only for being a JSON object, because compiling
  a stranger's `pattern`s would run their regular expressions in your
  process. Input the model produced that was not a JSON object (wrapped as
  `{ INVALID_JSON: text }`) is never sent to any server.
- **Listing.** A malformed descriptor, a name the providers reject (after
  `prefix`), a duplicate, or an input schema that is not a bounded object
  schema with local `$ref`s only (or that declares the reserved
  `INVALID_JSON` property) is left out and reported in `skipped`, so
  one bad tool does not break the rest. Descriptions are capped at 4 096
  characters. They reach the model, so an untrusted server's descriptions
  are untrusted text.
- **Results.** Text and image content (media type and magic bytes checked)
  become tool output, with images bounded by bytes and count like any tool
  result, and an embedded text resource becomes text. Other
  blocks become a fixed `[omitted MCP content: <type>]` placeholder.
  `structuredContent` is sent as JSON text only when the content has
  nothing usable. An `isError` result becomes an error result with the
  server's text (`errors: 'hide'` sends the fixed text instead).

`include`, `authorize` (called with the server's tool name and input),
`exposeToBrowser`, `timeoutMs`, `maxResultChars`, and `maxResultMediaBytes`
work as they do for `defineTool`.

## Providers

An `AiProvider` declares its capabilities (including the schema profile its
strict mode needs) and implements `stream` and `generate` over a neutral
`AiProviderRequest`. The run loop uses only `stream`, and checks its parts:
`response-start` first, then text, reasoning, and tool-input parts, then
exactly one `response-end`. Anything else is `provider_failed`. Tool and output schemas reach the provider already
lowered. The response carries the assistant message (with `native` raw
content), a finish reason, normalized usage, and per-iteration usage for
pricing. Each call receives an `AbortSignal` and propagation headers
(`traceparent`, `baggage`).

## Provider adapters

Both adapters stream every call, and `generate` drains the same stream, so
a long generation never hits a non-streaming timeout. The SDK's own
`maxRetries` (default 2) is the only retry layer. Credentials are explicit:
pass exactly one of `apiKey` (read from your secret store) or a configured
SDK `client`. Nothing is read from the environment, the SDK's logging is
off, and a provider built without either throws
`AiError('invalid_options')` at construction. A `baseURL` must be `https:`,
or `http:` to `localhost`, `127.0.0.1`, or `[::1]`. The SDK is loaded on
the first call, so an app that never calls a provider never loads it.

Every SDK error becomes a value-free `AiError`: an account out of credit
(OpenAI's `insufficient_quota`, sent as 429, or Anthropic's `billing_error`)
is `provider_rejected` with `reason: 'billing'` and no wait hint, so a retry
on `rate_limited` never loops on it; any other 429 is `rate_limited` (with
`retryAfterMs` from `retry-after-ms` or `retry-after`), 5xx, 408, 409, and an
overloaded stream are `provider_unavailable`, 401 and 403 are
`provider_auth`, a context-window rejection is `context_length_exceeded`,
any other rejection is `provider_rejected`, a network failure or timeout is
`provider_unavailable`, and a stopped call is `aborted`. `context` carries the
status and, for the SDKs' fixed error types, the type; never the provider's
message.

### Anthropic

```ts
import { generate } from '@jsails/ai';
import { createAnthropic } from '@jsails/ai/anthropic';

const anthropic = createAnthropic({ apiKey: secrets.anthropicKey, cacheTtl: '1h' });

const result = await generate({
  model: anthropic.model('claude-opus-5-5'),
  instructions: [{ text: policy, cache: true }],
  input: 'Summarize the policy.',
  effort: 'high',
  reasoning: 'summarized',
});
```

- **Replay is verbatim.** A Claude response keeps its raw content blocks in
  `native`, and every later request to Claude sends them back unchanged:
  thinking signatures, citations, server-tool blocks, and fallback blocks.
  A turn written by another provider is rebuilt from its neutral parts, with
  reasoning dropped and tool-call ids fitted to Claude's id rule.
- **Never sent:** `temperature`, `top_p`, `top_k`, or a forced
  `tool_choice`. `toolChoice: 'none'` and `parallelToolCalls: false` map to
  the matching `tool_choice`. `effort` maps to `output_config.effort`,
  `reasoning` to adaptive thinking with that display, and structured output
  to `output_config.format`.
- **Tools** are sent with their schema keywords in a fixed order (property
  order kept), so identical tools serialize identically and the prompt cache
  stays warm. Strict tools carry `strict: true`. `eagerInputStreaming`
  (`'auto'` by default, or `'off'` for a proxy that rejects the field) sets
  `eager_input_streaming` so large inputs stream as they are written; input
  that is not a JSON object is kept as `{ INVALID_JSON: text }` (so it
  replays as Anthropic documents) and always becomes an error result without
  the tool running, and a tool call cut at the token limit fails the run with
  `output_truncated` without running.
- **Caching:** with `cache: 'auto'` the request carries the automatic
  breakpoint, and parts marked `cache: true` add their own, earliest first,
  up to the API's limit of four in all. `cacheTtl` is `'5m'` (default) or
  `'1h'`. `cache: 'off'` sends none.
- **Stops:** a refusal is `finishReason: 'refusal'` with
  `refusal.category` from `stop_details`; `pause_turn` is resent with the
  paused content last; `model_context_window_exceeded` is `length`.
- **Usage** puts cache reads and writes inside `inputTokens`. Each entry of
  `usage.iterations` (fallbacks, server-side work) becomes its own priced
  iteration under the model that ran it.
- **Token counting** uses `messages.countTokens`; a client without it
  reports `capabilities.countTokens: false`.
- `providerOptions.anthropic` takes `inferenceGeo`, `speed: 'fast'`, and
  `userId`. `fallbacks` (`'default'` or `[{ model }]`) and `betas` are
  `@experimental`: they follow beta API surfaces that may change.
  Unknown keys are refused.

### OpenAI-compatible

```ts
import { createOpenAICompatible } from '@jsails/ai/openai-compatible';

const openai = createOpenAICompatible({ apiKey: secrets.openaiKey });

const local = createOpenAICompatible({
  name: 'ollama',
  apiKey: 'unused',
  baseURL: 'http://localhost:11434/v1',
  maxTokensField: 'max_tokens',
  supports: { strictTools: false, images: false },
});
```

Compatible servers differ, so `supports` states what the endpoint handles,
and the adapter refuses a request that needs a missing feature with
`unsupported_capability` rather than silently dropping content:

| Flag | Default | Effect |
| --- | --- | --- |
| `tools` | `true` | function tools |
| `parallelTools` | `true` | several calls in one response; `parallel_tool_calls: false` when asked |
| `structuredOutput` | `'native'` | `response_format: json_schema`; `'tool'` makes `generateObject` use a single tool instead |
| `strictTools` | `true` | `strict: true` and the `openai-strict` schema profile; `false` uses `loose` |
| `images`, `pdf` | `true`, `false` | image and PDF input parts |
| `reasoning` | `false` | send `reasoning_effort`, clamped to `maxReasoningEffort` (default `'high'`); streamed `reasoning_content` is read either way |
| `streamUsage` | `true` | ask for the usage chunk, and fail without it; `false` reports zero usage |

`instructionsRole` is `'system'` (default) or `'developer'`, and
`maxTokensField` is `'max_completion_tokens'` (default) or `'max_tokens'`.
Tool results become `role: 'tool'` messages (text only; images in a result
move to a following user message). A tool-call id the server omits, repeats,
or reuses from an earlier turn is replaced by a unique synthesized one, and
replayed ids are fitted to the 40-character limit. The SDK ends a stream
quietly when the connection closes, so a reply whose first choice never
carried a `finish_reason` is treated as cut off: the call fails with
`provider_failed` (`reason: 'incomplete_stream'`) and none of its tool calls
run. Usage treats
`cached_tokens` as part of `prompt_tokens`. Sampling settings exist only as
provider options: `providerOptions.openaiCompatible` takes `temperature`,
`topP`, `seed`, `promptCacheKey`, and `user`.

## Security model

The package assumes the model can be steered by anything it reads: user
messages, documents, web pages a tool fetched, and tool results. It
therefore never lets model output or browser input carry authority.

- **History is trusted, input is not.** `history` is what your server
  stored. `input` is what the browser just sent, and it can only be text,
  images, and files: `parseUserInput` refuses tool calls, tool results,
  system text, assistant turns, unapproved URLs, and oversized media, and
  drops cache flags, and the run takes no message it did not make. Never
  accept a transcript from the browser; load it on the server.
- **Approvals are bound.** A decision counts only for a call pending in the
  trusted history, with the same tool name and the digest of its input for
  the same actor. A forged, stale, or foreign approval is refused before
  anything runs.
- **Tools run as the caller.** A run with tools needs a `context` with the
  `actor`, and every tool gets that context. `authorize` runs before a call
  is offered for approval and again right before `execute`. There is no
  ambient or elevated fallback.
- **Model input is untrusted.** Every tool input is validated against the
  full schema before `authorize` or `execute` sees it. Strict mode on the
  provider is a convenience, not the guarantee.
- **Tool output is data.** It goes back to the model as a tool result, never
  into instructions. Thrown errors become fixed text; only an
  `AiToolFailure` message, which you write, reaches the model.
- **The browser sees less than the server.** Tool input and output cross the
  wire only for tools marked `exposeToBrowser`; reasoning only with
  `reasoning: true`; errors as codes; usage without cost. The persisted
  result holds everything.
- **Nothing is logged, and errors are value-free.** The package writes no
  logs. An `AiError` message is fixed text, and its `context` holds only
  static scalars, never prompts, inputs, outputs, provider replies, or keys.
- **Credentials are explicit.** Adapters take an `apiKey` or a client you
  built; nothing is read from the environment. The root and
  `@jsails/ai/client` load no `node:*` module and no SDK, so they are safe
  to bundle for the browser; the adapter subpaths are server-only.
- **MCP servers are strangers by default.** An untrusted server's tools
  always need approval, and its annotations are ignored.

## Errors

Every failure is an `AiError` with a stable `code` (`AiErrorCode`,
`AI_ERROR_CODES`). The message is fixed text and never echoes prompts, tool
inputs or outputs, provider replies, or credentials. `context` holds only
static scalars, and `retryAfterMs` is set when a provider said how long to
wait.

| Code | When |
| --- | --- |
| `invalid_options` | an option, schema, or pricing table is invalid |
| `invalid_messages` | a transcript breaks a rule above |
| `invalid_input` | untrusted input was refused |
| `invalid_tool` | a tool definition is invalid or its schema cannot be lowered |
| `invalid_conversation` | persisted conversation data is malformed |
| `output_invalid` | structured output did not parse or match the schema |
| `output_truncated` | the output stopped at the token limit |
| `refused` | the model declined |
| `unsupported_capability` | the provider lacks a needed capability |
| `aborted`, `timed_out` | the caller's signal fired, or the deadline or idle timeout passed |
| `step_limit`, `tool_call_limit`, `budget_exceeded` | a run limit stopped the run |
| `checkpoint_failed` | `onStepFinish` or `onToolResults` threw (the error is the `cause`) |
| `provider_failed` | the provider failed, broke the stream contract, or returned a malformed response |
| `stream_failed` | the browser read a response that is not a complete ai.v1 stream |
| `mcp_failed` | an MCP server's tool listing failed or broke the protocol |

The remaining codes (`rate_limited`, `provider_unavailable`, `provider_auth`,
`provider_rejected`, `context_length_exceeded`, `conversation_conflict`) are
what provider adapters report. A tool error never fails a run: it reaches
the model as a fixed result, and the `tool-result` event carries its code.

## Honest limits

- **The event stream cannot resume.** A dropped connection ends the
  browser's view. The run on the server is aborted and settles with what it
  appended; reload the conversation to continue.
- **No recorder for replay fixtures.** `replayProvider` plays fixtures back
  in sequence. Recording them, and matching by request, is up to you.
- **MCP tools carry text and images only.** Audio, binary resources, and
  resource links become placeholders. Prompts, resources, sampling, and
  elicitation are not bridged.
- **The adapter tests run the real SDKs against hand-written wire
  fixtures**, built from the documented streaming formats, not recordings of
  live traffic, and the default suite calls no live API.
- **OpenAI reasoning items do not round-trip.** Chat Completions has no
  field for them; the Responses API is not supported.
- **No telemetry hook yet.** The run's events carry step boundaries, models,
  finish reasons, and usage; pass `headers` to propagate a trace.
- **No embeddings or vector search**, no agents framework, no forced tool
  choice, and no neutral `temperature`/`top_p` (current Claude models reject
  them).
- **No bundled price table or model database**: they go stale.

## Next steps

- [Data Contracts](/docs/data-contracts) — the contracts `defineTool` accepts.
- [MCP](/docs/mcp) — the `jsails mcp` CLI and the built-in JSails MCP tools.
