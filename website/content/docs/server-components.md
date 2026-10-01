---
title: Server Components
order: 9
section: Building
---

# Server Components

JSails' server-component system takes a Livewire-like approach to interactive UI. `jsails/server-components` provides this surface for JSails pages.
A server component is **stateless on the server**: its state travels to the
client inside a signed snapshot and back on every update, so the server keeps no
session-side UI store. The subpath is **server-only** — it imports `node:crypto`
and Preact — and it is mounted through an extension plugin.

## Defining a component

Define a component with `defineServerComponent` and its actions with
`defineAction`. The registry key is the component `name`.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod'; // third-party packages stay explicit imports
// `defineAction` and `defineServerComponent` are installed as globals.

const stateSchema = z
  .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
  .strict();

export const taskList = defineServerComponent<z.infer<typeof stateSchema>>({
  name: 'task-list',
  stateSchema,
  writableKeys: ['title'], // only the bound input is client-writable
  initialState: () => ({ title: '', tasks: [] }),
  authorize: (context) => context.session !== null, // default-deny; exact true
  actions: {
    add: defineAction({
      input: z.object({}), // explicit args, separate from bound state
      run(state) {
        const parsed = z
          .object({ title: z.string().trim().min(1) })
          .safeParse({ title: state.title });
        if (!parsed.success) throw parsed.error; // mapped to a 422 field error
        state.tasks.push(parsed.data.title);
        state.title = '';
      },
    }),
  },
  render(state, { bind, submit, errors }) {
    return (
      <form {...submit('add')}>
        <input {...bind('title')} />
        {errors.title ? <p role="alert">{errors.title}</p> : null}
        <button type="submit">Add</button>
      </form>
    );
  },
  // Static export renders only this: no state, no signing, no actions.
  staticFallback: () => <p>The live task list is unavailable in the static export.</p>,
});
```

Components are persisted and validated against `stateSchema`, a Zod object forced
to `.strict()`. It is the single source of truth for stored state.

## The authoring surface: `defineComponent`

`defineServerComponent` is the lower-level primitive; most components are better
authored with `defineComponent`, the friendly surface that lowers onto it. It
takes the same options plus three authoring additions: `actions` split by
capability, `derived` view values, and a `style` contract.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod';

const stateSchema = z
  .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
  .strict();

const style = defineStyle({
  form: 'flex items-start gap-2',
  input: 'input input-bordered w-full',
  submit: 'btn btn-primary',
});

export const taskList = defineComponent<z.infer<typeof stateSchema>>({
  name: 'task-list',
  stateSchema,
  style,
  writableKeys: ['title'],
  initialState: () => ({ title: '', tasks: [] }),
  authorize: (context) => context.session !== null,
  actions: {
    add: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') throw new z.ZodError([]);
        state.tasks.push(title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.tasks.length, // never persisted, never writable
  },
  render(state, { bind, submit, derived }) {
    const count = derived('count') as number;
    return (
      <form class={style.slot('form')} {...submit('add')}>
        <input class={style.slot('input')} {...bind('title')} />
        <button class={style.slot('submit')} type="submit">
          Add ({count})
        </button>
      </form>
    );
  },
  staticFallback: () => <p>The live task list is unavailable in the static export.</p>,
});
```

The three artifacts — **model** (`stateSchema` + `actions` + `derived`), **view**
(`render`), and **style** (`defineStyle`) — may live in one file or be split
across several; both are first-class. A **client-safe vs server-only** seam is
mandatory only when a component carries server-only code (see below).

### `localAction` vs `serverAction` — the capability split

An action is one of two kinds, and the choice is enforced by the type system:

- `serverAction({ input?, authorize?, run(state, args, context) })` — round-trips
  through the signed snapshot, with authorize, CSRF, and schema validation. Its
  `run` may perform I/O and change any schema-valid field.
- `localAction({ input?, run(state, args) })` — **pure and client-runnable**: it
  receives no `context`, returns synchronously, and cannot itself perform a
  persisted write. Use it for immediate, client-only reactions.

Because `localAction` has no `context` and no async body, a persisted write is
unreachable from one — the boundary is expressed in the signature, not in a
convention. `defineComponent` lowers both kinds onto the runtime's action shape,
tagged with `kind: 'local' | 'server'`.

### `derived` view values

`derived` maps names to `(state, context)` functions that recompute a read-only
view value at render time. Expose them through `tools.derived(name)`; they are
never persisted and never client-writable. `derived` is the authoring alias for
the runtime's `computed` (the name avoids a collision with `@preact/signals`'
own `computed`).

### `defineStyle` — a named-slot style contract

Class strings belong in a style contract, not inline in the view. `defineStyle`
takes a flat map of slot name to class string and returns a frozen contract;
`render` dereferences `style.slot(name)` instead of threading raw class lists.
A name that is not a declared slot is rejected — the guard checks the
view↔style boundary, not the class strings themselves.

### Client-safe vs server-only

A component with no server actions is client-safe and may live in a single file.
When a component carries server-only code, you have two seams:

- **Split the file.** Put the server-only half in `task-list.server.ts` and
  import it behind the seam. The framework's `cleanBundlePlugin` asserts at
  build time that no such module reaches the client bundle, naming the import
  chain when it does. This is the strongest guarantee: the module is refused
  outright.
- **Mark the whole file.** A file-level `'use server'` prologue makes the
  module server code in its entirety. Its client form is rebuilt from scratch:
  every top-level function (exported or not, block- or expression-bodied,
  including `export default` arrows and functions exported through
  `export { f as g }`) becomes a throwing stub under its original export name,
  and everything else — imports, constants, helpers' bodies, side effects — is
  dropped. A file-level module may export **only functions** (and types): an
  exported constant, object, class, or enum, or a re-export of another module,
  fails the build, because no stub can stand in for a value.

Both plugins ship from `jsails/build` and are wired into the starter's
`vite.config.js`; add them to your own Vite/Rolldown config if you use a
different build. The transform is **fail-closed**: a `'use server'` directive
anywhere but the first statement of a module and an export it cannot stub both
fail the build rather than silently shipping server code. That includes a
**function-level** directive (`'use server'` as the first statement of one
function in an ordinary module): stubbing that one body would leave the
module's imports, constants, and helpers in the client bundle, so the build
stops and asks you to move the function into a `'use server'` module. The
default include list covers `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, and `.cjs`, and the starter's `cleanBundlePlugin` predicate,
`isServerOnlyModuleId` from `jsails/build`, matches `*.server.*` in every one
of those extensions. It skips `node_modules` and never parses a module that
does not contain the text `use server`.

**Source maps.** A bundler embeds each module's *original* text in a source
map's `sourcesContent`, so a published client map would carry the very bodies
the transform removed. A client build that emits source maps with embedded
sources after stripping any module therefore fails; set `build.sourcemap: false`
(the default) or `build.rolldownOptions.output.sourcemapExcludeSources: true`.

**What the directive does and does not do.** It lets server-only code live in a
single file and strips it from the client chunk — nothing more. It adds **no**
new way to submit an action and **no** new network surface: a client still
mutates state only through the signed-snapshot update endpoint
(`submit(action)`), and the throwing stub exists so a module is safe to _import_,
never so the function is _callable_. The browser never calls an action's `run`.

## `writableKeys` — what the client may edit

`writableKeys` names **only** the top-level fields a client update may set
(default: none; every entry must be a real top-level field). This restricts
_client_ edits only: actions run server-side and may change **any** schema-valid
field regardless of `writableKeys`. In `task-list`, the bound `title` input is
editable, while `tasks` is mutated only by the `add` action.

## `authorize` and action `input`

`authorize(context)` is **required** and default-deny — an exact `true` allows;
a truthy non-boolean, a throw, and a rejection all deny. An action may add its
own `authorize(context, state, input)`.

An action's `input` is a Zod schema for a **separate args object**, parsed and
passed to `run(state, args, context)` — it is never derived from an assumed
`FormData` shape. `task-list` declares `input: z.object({})`, while the trimmed
title is validated from bound state inside `run`.

## Rendering with `bind`, `call`, `submit`

`render(state, tools)` receives three helpers that return attribute maps to
spread onto elements:

- `bind(name)` — two-way bind a state field to a control.
- `call(action, args?)` — a client action round-trip.
- `submit(action, args?)` — pins `data-turbo="false"` so the form is a plain
  `POST` rather than a Turbo submission.

The runtime owns serialization and transport; `render` returns Preact VNodes.

The same markers work in a pure island: `useIslandDirectives` from `jsails/client`
resolves them to local handlers instead of server actions, so one markup serves
both a static export and a server-rendered app. See
[Client & Islands](/docs/client#the-toolset-one-authoring-model-for-islands-and-server-components)
for the full marker table.

## Lifecycle hooks

Optional hooks are awaited in order:

- `hydrate(state, context)` — after a snapshot is verified and before any client
  edit, for server-side rehydration.
- `updating(state, context)` — before client edits; may throw a value-free error
  to reject the update.
- `updated(state, context)` — after a successful update or action, before the
  re-render.
- `mount(context)` — once, on the first live server render.

Hooks receive the mutable server-side state and may mutate it in place. `mount`
is the exception: it receives only the context.

## Computed properties

`computed` maps names to `(state, context)` functions that derive a read-only
view value at render time (a Promise result is awaited). Expose them to `render`
through `tools.computed(name)` — memoized per render. Computed values are never
persisted and never client-writable, and a name that collides with a top-level
state field is rejected at definition time. `defineComponent` authors the same
thing under the `derived` key with `tools.derived(name)` (see above).

## Signed, stateless snapshots

An update verifies the snapshot **before** the component is looked up: an
HMAC-SHA256 signature, an expiry, a hashed subject binding, and a trusted origin.
It then enforces same-origin plus a required CSRF header (the session CSRF
token, or for an anonymous public component the verified snapshot id — a
possession token, not an authentication identity), re-runs the component
`authorize` for the **current** request, applies client edits under
`writableKeys`, validates the strict state, runs at most one allowlisted action,
re-validates the whole state, and returns a re-signed snapshot plus synchronized
HTML. A `ZodError` thrown from `run` becomes a `422` with field errors and
repopulated values. A snapshot token (like an upload or download reference) has
exactly one accepted spelling: a re-encoded segment that decodes to the same
bytes is rejected, so the raw token string can serve as a cache, dedupe, or
audit key.

Component state is public. The token is integrity-protected but not encrypted, so anyone who holds it can read it. Never place credentials or secrets in component state. There is **no exactly-once processing, no replay prevention,
and no atomic DB rollback**: a valid token can be replayed until it expires and
every request reconstructs state from it, so a handler must make its own
persistence idempotent. This is a deliberately reduced feature set compared to a full Livewire-style library.

### Lifetime and key rotation

A snapshot has two lifetimes. `snapshotTtlMs` (default 1 hour) is sliding: each
update re-signs the token with a later expiry. `snapshotMaxAgeMs` (default 24
hours) is absolute: the token records when the component was mounted
(`issuedAt`), and no update can extend it past mount + max age, so a stolen
token cannot be kept alive by replaying refreshes. Each update also increments
the token's `revision`, and a refresh that runs no action is signed only once.

Once the server rejects an expired snapshot, the browser client reloads the page
to mount a fresh one. A rejected snapshot that has not reached its expiry still
blocks the component, so a bad key cannot cause a reload loop.

To rotate the signing key, set the new key as `signingKey` (or
`JSAILS_COMPONENT_SECRET`) and move the old one to `previousSigningKeys`, or to
the comma-separated `JSAILS_COMPONENT_PREVIOUS_SECRETS`. A token signed with a
previous key still verifies, and its next update re-signs it with the current
key. Once `snapshotMaxAgeMs` has passed, no live token uses the old key and you
can remove it. Signing and subject binding use separate keys derived from the
secret for each purpose.

A download link is served only while the component it was minted for still
exists and its `authorize` still admits the request, so revoking access also
stops links handed out before. A factory upload store that resolves no storage
path for the request answers `503` instead of reading from a default store.

Previous keys also verify upload references (valid for 1 hour) and download
links (valid for 5 minutes) minted before the rotation. Such an upload keeps the
subject tag it was minted with, so `resolveUpload` still finds it for the same
session. One case does not carry over: a `download()` that names a file staged
before the rotation looks for it under the session's new subject tag and gets
`404`. Staged files are deleted after `retentionMs` anyway, so this lasts at
most one retention window.

A custom `ComponentSigner` may leave `issuedAt` out of the payload its `verify`
returns (the field is optional on `SnapshotPayload`). The runtime then passes no
`issuedAt` to that signer's `sign` on the next update, so enforcing an absolute
lifetime is up to the signer. A signer that supports rotation can implement
`subjectsFor(id)`, which returns the subject tag under each accepted key,
current first. Without it, only `subjectFor` is checked.

### Client resilience

The browser controller limits each update request to `requestTimeoutMs`
(default 30 s). If an action fails with an unknown outcome (a network error, a
timeout, or a 502/503/504 from a proxy), it is never re-sent. The controller
rejects that action and the work queued behind it with a `retryable` error and
keeps the unsent edits, but the component stays usable. Only an idempotent
`refresh` is retried automatically, with capped backoff. Any other unexpected
response still blocks the component, which then shows a fixed message.

## The update endpoint

The HTTP layer mounts `POST /_jsails/components/update`, but **only when an
extension registered a runtime**. The runtime owns every origin, CSRF,
signature, and policy check, so the endpoint is inert until the plugin is added.

## Static export with `staticFallback`

`staticFallback(context)` is the **only** thing rendered during static export:
read-only, with no signing key, no state, and no actions. A component without one
throws a value-free error in static mode. The static wrapper still carries the
component-name attributes but has **no** snapshot, CSRF token, or live id, and no
interactive form.

## Registering with `serverComponentsPlugin`

Register components through the `serverComponentsPlugin` extension. `components`
is a plain object map keyed by name — arrays are rejected.

```js
// jsails.app.js  (app-owned; compiled ESM)
import { serverComponentsPlugin } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  extensions: [
    // The key is not hardcoded: explicit signingKey / JSAILS_COMPONENT_SECRET,
    // or an ephemeral key only in development/test, else a live render fails.
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

Signing-key precedence is resolved **lazily**, only when a live render or update
signs or verifies: explicit `signingKey` → `JSAILS_COMPONENT_SECRET` → a fresh
random key **only** when `NODE_ENV` is exactly `development` or `test` →
otherwise a `ServerComponentError`. A standalone `jsails serve` outside those
modes must configure the key; the framework ships **no fake identity or auth
kit**. The starter's `task-list` is an explicitly public, **transient** demo
whose policy is `authorize: () => true`; replacing that with a real session check
is the app's job.

## File uploads

Uploads are off until the plugin passes an `uploads` options object, and then
only a component that declares an `uploads` policy accepts a file. A component
without one is answered with `403 forbidden` before any file byte is read.

```js
serverComponentsPlugin({
  uploads: { maxBytes: 5 * 1024 * 1024, maxBytesPerSubject: 50 * 1024 * 1024 },
});

defineServerComponent({
  name: 'avatar',
  uploads: { maxBytes: 512 * 1024, contentTypes: ['image/png', 'image/jpeg'] },
  // ...
});
```

The multipart body must send the `snapshot` field **before** the `file` field.
The runtime reads the body as a stream. It reads only the snapshot first,
verifies it, checks origin and CSRF, and re-runs `authorize`. Only after that
does it open the file part, and it streams the file to disk without buffering
it. An unauthorized request is refused without reading the file.

The checks, in order:

- A `content-length` over the cap is refused before anything is read.
- The snapshot field must arrive within 10 seconds, or the request gets
  `400 invalid_request`. This deadline is the runtime option
  `uploads.snapshotTimeoutMs`.
- No more than `maxConcurrent` authorized uploads (default 16) run at once.
  Past that, the request gets `503`. A slot is taken only after the snapshot,
  origin, CSRF, `authorize`, and the component's `uploads` policy have passed,
  so unauthenticated clients that send slowly cannot use up the slots.
- One session subject may have `maxConcurrentPerSubject` uploads (default 2)
  in progress at once; another gets `503`, so a single session cannot hold
  every slot.
- A file whose bytes stop arriving for `idleTimeoutMs` (default 30 s), or that
  is still streaming after `timeoutMs` (default 5 min), is aborted with
  `400 invalid_request` and its slot is released.
- The component's `maxBytes` and `contentTypes` narrow the plugin's `maxBytes`
  (default 10 MiB) and its content-type allowlist. The byte cap is enforced
  while the file streams.
- Each session subject has a quota of `maxBytesPerSubject` (default 100 MiB)
  and `maxFilesPerSubject` (default 100). The quota still holds when uploads
  run concurrently. An upload over the quota gets `413`.
- **Anonymous uploads are refused unless the component opts in.** A visitor
  without a session gets `403 forbidden` from a component whose `uploads`
  policy has no `anonymous` quota. With
  `anonymous: { maxBytes, maxFiles, maxConcurrent? }` (concurrency defaults to
  2), all anonymous visitors share that quota for the component over the
  1-hour reference lifetime, on top of the store's shared anonymous quota, and
  an upload past it gets `413`. One visitor can still use the whole quota, so
  keep it small and add rate limiting. The quota is counted per process.
- A staged upload is deleted after `retentionMs` (default 1 h 15 min, just past
  the reference lifetime). This happens through a periodic sweep and when the
  same subject uploads again. `retentionMs` cannot be set below the 1-hour
  reference lifetime (a `TypeError`), because the sweep would then delete files
  that valid references still name. An action that keeps a file must copy it
  to permanent storage before then.

## Rendering from a page

Render a component from a page's `load` with `renderServerComponent(name,
context)` (a Preact VNode) or `renderServerComponentHtml(name, context)` (a raw
string).

```tsx
// pages/tasks.tsx  (app-owned page)
import type { RequestContext } from 'jsails';

export async function load(context: RequestContext) {
  return { taskList: await renderServerComponent('task-list', context) };
}
export default function Tasks({ taskList }: { taskList: unknown }) {
  return <main>{taskList}</main>;
}
```

## Nested components

`defineNestedComponent` / `renderNested` let a parent render independently
authorized, stateful children, each with its own signed snapshot, CSRF marker,
and component id. Child state is fully independent: every render and update
goes through the child's own `mount` → `sign` → `verify` lifecycle, with its
own `authorize` and `writableKeys`, and a parent snapshot never contains child
state. `MAX_NESTING_DEPTH` (8) bounds the depth of a chain of `renderNested`
calls. The depth follows the async render, so a component that renders itself,
directly or through other components, fails with a `too_deep`
`NestedComponentError` instead of recursing without end.
`NestedComponentError` is also raised when a component is not found, or when a
child's own signature or security check fails.

```tsx
async render(state, { context }) {
  const card = defineNestedComponent({ name: 'section', component: 'card', key: 'main' });
  return (
    <div>
      {await renderNested(card, context)}
      {await renderNested('task-list', context)}
    </div>
  );
}
```

### Child state across a parent update

A nested child keeps its state when its parent updates; it is not re-mounted.
Each child's wrapper carries a slot, `data-jsails-nested-slot`: `k:<key>` for a
child with a `key`, or `p:<component>:<n>` for the n-th unkeyed child of that
component in the parent's render. When the parent updates, the client sends
each child's current snapshot under its slot (`children` in the update body,
nested for grandchildren). The server re-renders the parent, and each
`renderNested` call takes the snapshot offered for its slot and restores the
child from it:

- The child's `authorize` still runs for the current request. `initialState`,
  `mount`, and the state hooks do not run. The child keeps its id and its token
  unchanged, so the browser's binding for it carries on.
- The snapshot is untrusted input. It must verify (signature, expiry, subject,
  origin) for the child's own component, belong to the page the parent renders
  for, and still pass the child's state schema unchanged. A child whose
  snapshot is missing, tampered with, expired, for another component or page,
  or no longer schema-valid is mounted fresh, as is a second child that claims
  a slot already taken. A child that mounts fresh also mounts its own nested
  children fresh: grandchild snapshots are used only under a child whose own
  snapshot verified.
- The offer is bounded: at most `MAX_NESTED_SNAPSHOTS` (64) child snapshots at
  every depth, each token at most `MAX_NESTED_SNAPSHOT_LENGTH` (128 KiB)
  characters, each slot at most `MAX_NESTED_SLOT_LENGTH` (256), and every slot
  and token together at most `MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH` (256 KiB)
  characters, which keeps the update well under the default 1 MiB body cap. A
  request over a bound is rejected with `invalid_request`. The bundled client
  skips a child (and its subtree) that would exceed a bound, and those children
  mount fresh. With the default 64 KiB snapshot cap every token fits; a child
  whose token is longer than `MAX_NESTED_SNAPSHOT_LENGTH`, reachable only when
  the signer's `maxBytes` is raised above about 96 KiB, is re-mounted on every
  parent update.
- An update that sends no `children` (an older client) re-mounts every nested
  child, as before.

Give a child a `key` when its position can change between renders (a list
that reorders or filters), so it keeps its own state rather than its
neighbour's. A 422 validation re-render restores the children in the same way.

After the parent's HTML is morphed in, the client reconciles the nested roots:
a restored child keeps its binding and client state, a new or re-mounted child
is bound from its new markers, a removed one is disposed, and a child that
updated while the parent's request was in flight refreshes itself so its markup
catches up. Nested islands whose name and props did not change keep their
state across the morph; only a changed island is torn down and re-hydrated.

## Form objects

`defineForm` wraps a Zod object schema and provides typed field access,
`fill` / `validate` / `reset` helpers, and `toState` / `fromState` JSON
round-trip methods compatible with the server-component snapshot protocol. A
`FormObject` is a plain object created inside a component action or lifecycle
hook; `FormDefinitionError` is raised for an invalid schema or options.

`fill(partial)` keeps only declared fields whose value passes that field's
schema, and stores the parsed value (so a `z.coerce` field stores the coerced
value). Undeclared keys, including `__proto__`, `constructor`, and
`prototype`, are dropped, as they are from `initial`. A declared value its
schema rejects is not stored: the field keeps its previous value, and
`validate()` reports a value-free error for it until a valid `fill`, `reset()`,
or `fromState()` replaces it. So `values()` and `toState()` never hold an
undeclared key or a rejected value, and a rejected fill never lets `validate()`
pass on the value it replaced.

```ts
const form = defineForm({ schema: z.object({ email: z.string().email() }) })();
form.fill({ email: 'not-an-email', extra: 1 });
form.toState(); // {} (the rejected email and the undeclared key are not kept)
form.validate(); // { ok: false, errors: { email: '...' } }
```

## Next steps

- [Client & Islands](/docs/client) — islands, Turbo navigation, and hydration in the browser.
- [Routing](/docs/routing) — pages, API routes, and layouts.
