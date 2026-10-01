---
title: MCP
order: 32
section: Reference
---

# MCP

JSails speaks the [Model Context Protocol](https://modelcontextprotocol.io) in
two places:

- **`@jsails/mcp`** — your app's own MCP surface: tools, resources, resource
  templates, and prompts defined and checked at define time, served over
  stdio, tested in process with `connectInMemory`, and a client for remote MCP
  servers over Streamable HTTP or stdio.
- **`jsails/mcp`** — the developer server, `jsails mcp`: read-only
  introspection of the app in the working directory, for the coding agent in
  your editor.

```sh
npm install @jsails/mcp zod
```

`@jsails/mcp` is built on the official SDK (`@modelcontextprotocol/server` and
`@modelcontextprotocol/client`, pinned exactly), but no SDK type appears in its
API.

## Protocol revisions

| Revision | Served (stdio, in process) | Client | `jsails mcp` |
| --- | --- | --- | --- |
| 2026-07-28 (`server/discover`, multi-round-trip input) | yes | yes | yes |
| 2025-11-25, 2025-06-18, 2025-03-26 (`initialize` handshake) | yes | yes | yes |
| 2024-11-05 HTTP+SSE transport | no (deprecated upstream) | no | no |

The opening message picks the revision for a connection: a `server/discover`
probe or any 2026-07-28 request gets the modern revision, an `initialize`
handshake the newest 2025 revision both sides support. The client's `protocol`
option chooses how it opens (see [The client](#the-client)).

## Defining a tool

```ts
import { z } from 'zod';
import { defineMcpTool, publicAccess } from '@jsails/mcp';

export const add = defineMcpTool({
  name: 'add',
  title: 'Add',
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnly: true, idempotent: true, openWorld: false },
  access: publicAccess('arithmetic on caller-supplied numbers'),
  handler: ({ a, b }) => ({ sum: a + b }),
});
```

- **Name.** `[A-Za-z0-9_.-]{1,128}`, not starting or ending with `.` or `-`.
  An `Object.prototype` property name (`constructor`, `toString`,
  `__proto__`, ...) and an all-digit name are refused, for tools, prompts, and
  resource templates alike: the SDK keeps these in plain objects, where the
  first reads as already registered and the second would list out of order.
- **Schemas.** `input` is an object schema; `output` is any schema. Both accept
  a zod 4 schema or any other [Standard Schema](https://standardschema.dev)
  that also implements its JSON Schema converter. Each schema is projected to
  JSON Schema 2020-12 once, compiled, and frozen when the tool is defined; a
  tool without `input` takes no arguments at all
  (`{ type: 'object', properties: {}, additionalProperties: false }`).
  Arguments are validated with your schema before the handler runs, and an
  invalid call is refused with `invalid_arguments` without echoing the input.
- **Results.** Return a string (one text block), any JSON value (a JSON text
  block mirrored in `structuredContent`), or `toolResult.content([...])` /
  `toolResult.structured(value, content?)` for explicit content blocks (text,
  image, audio, resource links, embedded resources). Every block may carry
  `annotations` (`audience` of `user` and/or `assistant`, `priority` from 0 to
  1, `lastModified` as an ISO 8601 date-time), and a resource link a `size`
  and `icons`; they are checked and sent, and the client keeps them. With
  `output`, the value is checked against the schema before it is sent, and
  unknown keys are stripped.
- **Annotations** map to the MCP hints (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`); `readOnly` with `destructive` is refused.
- **`confirm`** asks the user before every call: it receives the parsed
  arguments and returns the question to show. A declined confirmation fails
  the call with `not_confirmed`; a client that cannot ask gets
  `confirmation_unavailable`. An answer counts only on the retry of the round
  that asked the question (the sealed state records that it was asked), so a
  client cannot skip the step by sending a ready-made answer. The handler
  never runs unconfirmed.
- **`timeoutMs`** is the handler deadline (the serving default is 30 s).

Everything is checked when `defineMcpTool` runs, so a malformed definition is
an `McpDefinitionError` at startup, never a broken listing. The returned handle
is frozen and opaque.

### The handler context

The second handler argument is the call context:

| Member | |
| --- | --- |
| `actor` | Who is calling: `{ kind: 'user' \| 'service' \| 'anonymous' \| 'developer', id?, scopes }`. |
| `signal` | Aborts on the client's cancellation (`notifications/cancelled` on stdio, the request's stream closing over HTTP), the connection closing, or the deadline. |
| `client` | `{ name, version, protocolVersion, era, elicitation: { form, url } }`. |
| `progress(done, total?, message?)` | Sent only when the client asked for progress, and only for increasing values. |
| `answer(key, schema?)` | The user's answer to an input request from the previous round. |
| `state()` | The state the handler passed to `inputRequired` in the previous round. |

### Asking the user

A handler that needs the user's input returns `inputRequired(...)`; the call is
re-entered with the answer:

```ts
import { z } from 'zod';
import { defineMcpTool, inputRequired, publicAccess } from '@jsails/mcp';

const Plan = z.object({ plan: z.enum(['basic', 'pro']) });

export const upgrade = defineMcpTool({
  name: 'upgrade',
  description: 'Upgrade the account plan.',
  access: publicAccess('acts on the caller account only'),
  handler: async (_input, ctx) => {
    const answer = await ctx.answer('plan', Plan);
    if (answer === undefined) {
      return inputRequired({
        requests: { plan: { mode: 'form', message: 'Which plan?', schema: Plan } },
        state: { startedAt: Date.now() },
      });
    }
    return answer.action === 'accept' ? `Upgraded to ${answer.content.plan}.` : 'Cancelled.';
  },
});
```

- A `form` request's schema is limited to what elicitation allows: flat string,
  number, integer, boolean, and enum fields (defaults and titled enums
  included). A `url` request sends the user to an `https:` page.
- `state` is any JSON value up to 16 KiB. It is encrypted (AES-256-GCM) and
  signed (HMAC-SHA256), under keys derived from the serving key, and bound to
  the caller, the credential, the method, the target, and a digest of the
  exact arguments, so the client cannot read it and a handler reads back only
  what it wrote, and only on the same call. Tampered, expired, or re-targeted
  state (another caller, credential, target, or argument set) is refused with
  `-32602 Invalid or expired requestState`.
- State is not single-use. Nothing records that a state was presented, so the
  same caller can present it again for the same call and arguments until it
  expires (`requestStateTtlSeconds`, default 600). That keeps retries
  servable by any process without shared storage; do not rely on state to
  make a call happen once.
- A 2026-07-28 client answers and retries the call itself. On a 2025
  connection that can carry server-to-client requests (stdio, in process), the
  server asks the client directly when the client declared the elicitation
  modes the requests use, and fails the call with `input_unavailable`
  otherwise (a protocol error with `data.reason: 'input_unavailable'` for
  resources and prompts). At most `maxInputRounds` (default 8) rounds run per
  call on either era; past that the call fails with `too_many_input_rounds`.

## Resources, templates, and prompts

```ts
import { z } from 'zod';
import {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  publicAccess,
} from '@jsails/mcp';

const open = publicAccess('published documentation');

export const readme = defineMcpResource({
  uri: 'docs://readme',
  name: 'readme',
  mimeType: 'text/markdown',
  access: open,
  cache: { ttlMs: 60_000 },
  read: () => [{ text: '# Hello' }],
});

export const page = defineMcpResourceTemplate({
  uriTemplate: 'docs://pages/{slug}',
  name: 'page',
  mimeType: 'text/markdown',
  params: z.object({ slug: z.string() }),
  complete: { slug: (prefix) => ['intro', 'install'].filter((s) => s.startsWith(prefix)) },
  access: open,
  read: ({ slug }) => (slug === 'intro' ? [{ text: '# Intro' }] : null),
});

export const review = defineMcpPrompt({
  name: 'review',
  description: 'Review a change.',
  args: z.object({ diff: z.string() }),
  access: open,
  render: ({ diff }) => [{ role: 'user', content: { type: 'text', text: `Review:\n${diff}` } }],
});
```

- A resource body without `uri` takes the read URI; one without `mimeType`
  takes the type the resource or template declares.
- URI templates are strict RFC 6570, limited to what the SDK's matcher handles
  correctly (no prefix modifiers, no `;` or reserved operators); matched values
  are percent-decoded before `params` validates them. `read` returning `null`
  is "resource not found" (`-32602`).
- An `args` or `params` schema that throws while validating is a generic
  internal error (`-32603`) on the wire and a `handler_failed` report, never
  the schema's own message.
- An unknown or hidden prompt is refused with one fixed `-32602 Unknown
  prompt`, which never echoes the requested name.
- `complete` suggests values for template variables and prompt arguments; at
  most 100 are sent.
- `cache` sets `ttlMs` (and a scope) on read results; a `public` scope is
  allowed only on public access.

## The server

```ts
import { defineMcpServer } from '@jsails/mcp';

export const server = defineMcpServer({
  name: 'notes',
  version: '1.4.0',
  instructions: 'Tools for reading and writing notes.',
  tools: [add, upgrade],
  resources: [readme, page],
  prompts: [review],
  listCacheTtlMs: 10_000,
});
```

Duplicate names or URIs are refused. Lists are sorted the same way every time
(tools and prompts by name, resources by URI, templates by name), before and
after access filtering. A list's cache scope is `public` only when every item
in it is public, otherwise `private`. The server does not declare
`listChanged` (the item set is fixed per deploy) and does not advertise
logging.

## Access

Every definition states its `access`, with no default. `publicAccess(reason)`
admits everyone and must say why. Any other value is an object your app
chooses (a policy reference, a scope list) that `@jsails/mcp` does not
interpret: the serving options take an `authorize` gate that decides, per
caller, once per connection:

```ts
import { serveMcpStdio } from '@jsails/mcp';

const writers = { scope: 'notes:write' };

await serveMcpStdio(server, {
  actor: { kind: 'user', id: 'u_1', scopes: ['notes:read'] },
  authorize: (item, actor) => {
    if (item.access !== writers) return 'hidden';
    const granted = actor.scopes === '*' || actor.scopes.includes('notes:write');
    return granted ? 'allow' : { challenge: ['notes:write'] };
  },
});
```

- `'allow'` lists the item and lets the caller use it.
- `'hidden'` leaves it out. Calling a hidden item fails exactly like calling a
  name that does not exist, byte for byte, so it is not an existence oracle.
- `{ challenge: scopes }` lists the item but refuses to run it until the
  credential carries the scopes (over HTTP, a `403 insufficient_scope` step-up
  challenge). Use it when the caller could be granted the scopes; use
  `'hidden'` when the caller is denied outright.
- A gate that throws or answers anything else hides the item and reports
  `gate_failed` or `invalid_gate_decision`. A server with non-public items and
  no gate is refused (`missing_gate`).

## Serving over stdio

`serveMcpStdio(server, options?)` serves the process's stdin and stdout and
resolves when the connection closes (end of input, the `signal` aborting, or a
transport fault). The caller defaults to the local developer
(`{ kind: 'developer', scopes: '*' }`); `legacy: 'reject'` refuses 2025
clients.

Serving options, for stdio and `connectInMemory` alike:

| Option | Default | |
| --- | --- | --- |
| `authorize` | none | The access gate. |
| `onError` | `console.error` | Receives every operator-audience failure as an `McpServingError`. |
| `timeoutMs` | 30 000 | Handler deadline when a tool sets none. |
| `maxResultBytes` | 1 MiB | Largest result sent (tools, resources, prompts). |
| `maxToolInputElements` | 10 000 | Array elements plus object members one call may carry. |
| `requestStateKey` | random | At least 32 bytes; every process that may receive a retry needs the same key. |
| `requestStateTtlSeconds` | 600 | How long sealed state stays valid. |
| `maxInputRounds` | 8 | Input rounds per call, on either era, before `too_many_input_rounds`. |

The Streamable HTTP endpoint (stateless 2026-07-28 serving with the 2025
fallback, OAuth protected-resource metadata, and `401`/`403` challenges) is
built and tested, but its mount arrives with the `mcp` plugin, which will own
its options and route; it is not exported yet. A call over it is cancelled by
closing its response stream, on either protocol era: a stateless 2025 request
has no session for a `notifications/cancelled` to name it in, so the endpoint
acknowledges the notification and the disconnect is what aborts the handler.

## Errors

Only client-audience errors leave the server:

- **`McpToolFailure(code, message)`** — throw it from a tool handler to report
  a failure the model should see: the call answers `isError: true` with
  `{ code, message }`.
- **Anything else** a handler throws, output that breaks the output schema, or
  malformed content becomes a generic `tool_failed` tool error (an internal
  error for resources and prompts). The SDK would otherwise send the raw
  message; the original goes to `onError` as the `cause` of an
  `McpServingError` (`handler_failed`, `invalid_result`, `result_too_large`,
  `timed_out`, and the rest of `MCP_ERROR_CODES.serving`).
- Fixed codes for fixed cases, listed in `MCP_ERROR_CODES.tool` (type
  `McpToolErrorCode`): `tool_failed`, `invalid_arguments`, `timed_out`,
  `result_too_large`, `aborted`, `insufficient_scope`, `not_confirmed`,
  `confirmation_unavailable`, `input_unavailable`, `too_many_input_rounds`.
- An unknown or hidden tool is refused with one fixed `-32602 Unknown tool`,
  which never echoes the requested name.
- A throwing `onError` hook does not break serving; it becomes a process
  warning with code `JSAILS_MCP_REPORTER_FAILED`.

`McpDefinitionError` (define time and serving options) and `McpClientError`
(the client) complete the set; every code is listed in `MCP_ERROR_CODES`.

## Testing with `connectInMemory`

`connectInMemory(server, options?)` serves a definition in process and connects
the real client to it, over the same dual-era entry stdio uses, so a test sees
exactly what a client would:

```ts
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { connectInMemory } from '@jsails/mcp';

it('adds', async () => {
  const remote = await connectInMemory(server, {
    actor: { kind: 'user', id: 'u_1', scopes: ['notes:read'] },
    protocol: 'legacy',
    serving: { authorize, onError: (error) => assert.fail(error.code) },
  });
  try {
    const outcome = await remote.callTool('add', { a: 2, b: 3 });
    assert.deepEqual(outcome.status === 'ok' ? outcome.structured : undefined, { sum: 5 });
  } finally {
    await remote.close();
  }
});
```

The actor defaults to anonymous with no scopes. `protocol` (`'auto'`,
`'modern'`, `'legacy'`) picks the era, and every client option below applies.

## The client

`connectMcp(options)` connects to a remote server and returns an
`McpRemoteServer` whose every answer has been checked:

```ts
import { connectMcp, McpClientError } from '@jsails/mcp';

const remote = await connectMcp({
  transport: {
    kind: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: async () => ({ authorization: `Bearer ${await tokens.current()}` }),
  },
  elicit: async (request) => ({ action: 'decline' }),
});

try {
  const tools = await remote.listTools();
  const outcome = await remote.callTool('search', { query: 'jsails' }, { timeoutMs: 10_000 });
  if (outcome.status === 'ok') console.log(outcome.structured ?? outcome.content);
} catch (error) {
  if (error instanceof McpClientError) console.error(error.code);
} finally {
  await remote.close();
}
```

- **Transports.** `{ kind: 'http', url, headers?, fetch? }`: `https:`, or
  `http:` on a loopback host; `headers` is fixed or a function asked before
  every request, so a token can rotate; headers the transport owns are
  refused. `{ kind: 'stdio', command, args?, env?, cwd?, stderr? }`: spawned
  without a shell, with a minimal inherited environment plus `env`. Transports
  come from code, never from data.
- **Era.** `protocol: 'auto'` (the default) probes with `server/discover` and
  falls back to the `initialize` handshake; `'modern'` requires 2026-07-28;
  `'legacy'` uses only the handshake. `remote.info` reports the server's name,
  version, negotiated revision, era, instructions, and capabilities.
- **Lists** walk every page (a repeated cursor or more than 64 pages is
  `invalid_result`). A tool is left out, and reported through
  `onToolExcluded`, when its name breaks the MCP rule or repeats, when an
  `x-mcp-header` declaration in its input schema is invalid, or when its
  output schema does not compile. Only listed tools can be called.
- **Outcomes.** `callTool` resolves to `{ status: 'ok', content, structured }`
  (structured output checked against the tool's output schema),
  `{ status: 'tool_error', content, structured }` (the tool ran and failed),
  or `{ status: 'input_required' }` (the server needs input and no `elicit`
  handler can give it, or the server answered `input_unavailable` because the
  connection cannot carry the request). Anything else throws
  `McpClientError`.
- **Input.** With an `elicit(request, { signal })` handler, the client answers
  a 2026-07-28 server's input requests and retries, and a 2025 server's
  elicitation requests as they come. Fields the user leaves empty are
  answered with the form's defaults; the answer is validated against the
  requested schema. Without a handler the client declares no elicitation
  support.
- **Limits.** `timeoutMs` (default 60 s, per call too), an `AbortSignal`,
  `onProgress`, `maxResultBytes` (default 1 MiB, enforced on the wire and per
  message; an SSE event is measured whole, however many `data:` lines it is
  split across), and `maxInputRounds` (default 8). A call the signal or the
  deadline ends is cancelled on the server as well: over stdio with
  `notifications/cancelled`, over HTTP by closing the request's stream (and,
  to a 2025 server, sending the notification too), so a stateless server
  stops the work at once. A response stream the server
  closes mid-call is resumed with `Last-Event-ID` after its `retry` delay,
  clamped to 250 ms – 30 s. Content blocks and resource bodies are
  re-validated and returned frozen.
- **Errors.** `McpClientError` codes: `invalid_option`, `connect_failed`,
  `unsupported_protocol`, `unauthorized`, `forbidden` (with the required
  `scopes`), `credentials_failed`, `protocol_error` (with `rpcCode`),
  `unknown_tool`, `input_required`, `input_rounds_exceeded`, `elicit_failed`,
  `timeout`, `aborted`, `closed`, `result_too_large`, `invalid_result`. The
  message is fixed text, never copied from the server. A server that fails
  the handshake (an internal error) is `connect_failed`;
  `unsupported_protocol` means it speaks no revision the client can use.

## The developer server: `jsails mcp`

The `jsails mcp` CLI command starts the developer server over stdio:

```sh
jsails mcp
jsails mcp --config jsails.app.js --db-config jsails.database.js
```

Point your agent or editor at `jsails mcp` as a stdio MCP server. It reads
`jsails.app.js` (and, for `jsails_describe` and `jsails_schema`,
`jsails.database.js`) from the current directory; `--config` (`-c`) and
`--db-config` override those paths. The paths are fixed when the server starts:
no tool call can name a different module to load, because loading a config
module executes it.

- **Protocol.** Both eras, as in the table above.
- **Stdout is protocol only.** Before any app module loads, every `console`
  method is redirected to stderr and `process.stdout.write` is diverted there
  too, so a `console.log` in `jsails.app.js` or a model module lands in the
  client's server log instead of corrupting the JSON-RPC stream. Only a write
  through a raw file descriptor (`fs.writeSync(1, ...)`) gets past the guard.
- **Lifecycle.** The server closes when stdin reaches end of file, or on SIGINT
  or SIGTERM, and the process exits. If an app module holds the event loop
  open (a timer, a pool), the process exits anyway one second after the close.
- **Version.** `serverInfo` is `{ name: 'jsails', version }`, with the version
  of the installed `jsails` package.

Programmatic use:

```ts
import { runJsailsDevMcp } from 'jsails/mcp';

await runJsailsDevMcp({ configPath: 'jsails.app.js', dbConfigPath: 'jsails.database.js' });
```

It does the same on the current process's stdio and resolves when the
connection closes.

### Developer tools

Each tool wraps an existing read-only `jsails describe`/`inspect`/`explain`
function, never reimplementing discovery or schema extraction:

| Tool | Description |
| --- | --- |
| `jsails_describe` | Full app definition: routes, plugins, commands, server components, entity schema. Takes no arguments. |
| `jsails_inspect_routes` | Every filesystem route (page / API) with its parameters. Returns `{ source, data }`. Takes no arguments. |
| `jsails_explain_route` | Which route handles a request path: the matched route, its parameter values, and the pipeline stages. Takes `{ path }`. A path no route handles is a successful answer with `matched: false`. |
| `jsails_schema` | The declared entity schema (tables, columns, indexes, foreign keys) from model metadata, without connecting to a database. Reads only the database config and caches the result until that file's mtime changes. Returns an empty `tables` array when no database config exists. Takes no arguments. |

- Every tool is annotated `readOnlyHint: true`, `idempotentHint: true`, and
  `openWorldHint: false` (exported as `JSAILS_MCP_TOOL_ANNOTATIONS`), so a
  client can run it without asking first.
- Every input schema is a closed JSON Schema 2020-12 object
  (`additionalProperties: false`): an undeclared argument is a rejected call,
  not an ignored one.
- A result is one JSON text block, mirrored in `structuredContent`.

`jsails_inspect_routes` and `jsails_describe` read `.jsails/index.json` when it
exists and matches the source tree, and report `source: "index"`. When the index
is absent they fall back to a live scan and report `source: "scan"`. A stale
index throws `stale_index` rather than answering from outdated facts — run
`jsails build:meta` to regenerate it.

A `configPath` or `dbConfigPath` tool argument is rejected as
`invalid_arguments` before anything loads, so a model steered by prompt
injection cannot make the server import a module of its choosing. The tools
still execute the bound config modules' top-level code, as every `jsails`
command that reads them does.

A developer tool that fails returns a tool error (`isError: true`) whose body
is `{ code, message, context?, suggestion? }`, with a `JsailsMcpToolError`
code:

- `invalid_arguments` — the arguments do not match the input schema. Only the
  number of issues is reported, never the arguments themselves.
- `config_unavailable` — the app config module does not load. `context.reason`
  carries the loader's own code; the full error goes to stderr.
- `routes_unavailable` — `jsails_explain_route` could not discover the routes.
- `stale_index` — the code index is older than the source (see above).
- `tool_failed` — anything else; the detail goes to stderr.

## Conformance

`@jsails/mcp` is checked against the official
[conformance suite](https://github.com/modelcontextprotocol/conformance)
(`@modelcontextprotocol/conformance@0.1.16`) in both directions: the server
scenarios against a fixture server built only from `defineMcp*` definitions,
and the client scenarios against `connectMcp`. Every expected failure is in a
ledger beside the test, with its reason, and the ledger may only shrink. That
suite covers the 2025 revisions; the 2026-07-28 behaviour (discovery, the
standard headers, `-32020`/`-32022`, multi-round-trip input, cache fields,
protected-resource metadata, and the challenges) is covered by the package's
own spec vector tests over a real HTTP listener and by the official client in
the modern, legacy, and auto modes.

## Honest limits

- **No HTTP mount yet.** The Streamable HTTP endpoint ships with the `mcp`
  plugin; until then an app serves over stdio, and tests use
  `connectInMemory`.
- **Elicitation needs a connection on 2025 clients.** A stateless 2025 HTTP
  request cannot carry a server-to-client request, so input requests there
  fail with `input_unavailable`; 2026-07-28 clients and 2025 stdio clients are
  served.
- **Cancellation over stateless 2025 HTTP is the disconnect.** A 2025 client
  that sends `notifications/cancelled` but keeps the request's stream open
  (the official SDK client does) leaves the handler running until it
  disconnects or the deadline passes; `connectMcp` closes the stream.
- **Not offered:** logging, sampling, and roots (deprecated in 2026-07-28),
  resource subscriptions and `listChanged` (the item set is fixed per deploy),
  sessions and batching (removed upstream), the Tasks extension, and an
  escape hatch to the SDK's `McpServer`.
- **No interactive OAuth client.** The client does not run discovery,
  registration, or PKCE for a user; pass tokens through the `headers`
  provider. The server side is an OAuth resource server only.
- **Developer tools:** no output schemas yet, and a cancelled call stops being
  answered while the introspection function it started runs to completion.

## Next steps

- [AI](/docs/ai) — the provider-neutral AI runtime.
- [Introspection](/docs/introspection) — the read-only `jsails describe` /
  `inspect` / `explain` commands the developer tools wrap.
