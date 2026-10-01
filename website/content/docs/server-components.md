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
`defineAction`. A component's **id** is its path under `components/` without
the extension, each segment kebab-cased: `components/task-list.tsx` is
`task-list`, `components/admin/UserCard.tsx` is `admin/user-card`, and
`components/card/card.tsx` is `card/card`. A `.jsails` component kept as a
folder (`components/card/card.jsails`, see
[One file or a folder](/docs/view#one-file-or-a-folder)) is named by its
component path, `components/card.jsails`, so its id is `card`. The id is what the
runtime signs into every snapshot and download link and looks the component up
by, and the definition's `name` must equal it.

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

### `defineLiveComponent` — the schema-first form

`defineComponent<State>({ … })` needs its state type spelled out: inside one
options object, TypeScript checks `serverAction({ run(state) { … } })` before
it has inferred the state from `stateSchema`. `defineLiveComponent(name,
stateSchema)(options)` takes the schema first, so the state type is fixed
before the options are checked, and nothing needs a type argument: `run(state,
args)`, every `derived` function and `render` are typed from the schema, and
`render`'s tools know the component's own actions and derived values.

```tsx
// components/counter.tsx  (app-owned; server-only module)
import { z } from 'zod';

export const counter = defineLiveComponent(
  'counter',
  z.object({ count: z.number().int() }).strict(),
)({
  initialState: () => ({ count: 0 }),
  authorize: () => true, // a public demo; default-deny requires exactly true
  actions: {
    add: serverAction({
      input: z.object({ by: z.number().int() }),
      run(state, { by }) {
        state.count += by;
      },
    }),
  },
  derived: { double: (state) => state.count * 2 },
  render(state, { call, derived }) {
    const double = derived('double'); // number
    return (
      <p>
        {state.count} ({double}) <button {...call('add', { by: 1 })}>+1</button>
      </p>
    );
  },
  staticFallback: () => <p>The counter works when the site is served.</p>,
});
```

`call('ad')`, `call('add', { step: 1 })` and `derived('triple')` are type
errors. `ServerComponentRenderTools<State, Actions, Computed>` carries the
same typing for any definition that states its actions; its defaults accept
any action name and any JSON args, as an untyped definition always has. A
`.jsails` live component ([Components](/docs/components#live-components))
compiles to this form.

### `localAction` vs `serverAction` — the capability split

An action is one of two kinds, and the choice is enforced by the type system:

- `serverAction({ input?, authorize?, run(state, args, context) })` — round-trips
  through the signed snapshot, with the cross-site check, authorize, and schema validation. Its
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

`authorize(context)` is **required** and default-deny — only an exact `true`
allows, and a truthy non-boolean denies (`403 forbidden`). A throw or a
rejection is a **fault**, not a denial: the request is answered
`503 unavailable` and the error is reported to the app's `onError` (as a
`component_authorize.component_failed` error whose `cause` is what the callback
threw), so a policy store outage is visible instead of reading as an access
refusal. An action may add its own `authorize(context, state, input)`; a throw
there is reported the same way, as `component_authorize.action_failed`.

An action's `input` is a Zod schema for a **separate args object**, parsed and
passed to `run(state, args, context)` — it is never derived from an assumed
`FormData` shape. `task-list` declares `input: z.object({})`, while the trimmed
title is validated from bound state inside `run`.

## Rendering with `bind`, `call`, `submit`

`render(state, tools)` receives three helpers that return attribute maps to
spread onto elements:

- `bind(name)` — two-way bind a state field to a control.
- `call(action, args?)` — a client action round-trip.
- `submit(action, args?)` — spread onto a `<form>`; submitting it dispatches
  the action. It pins `method="dialog"`, so the form cannot navigate before (or
  without) the client script: a dialog-method form outside a `<dialog>` submits
  nowhere. It also pins `data-turbo="false"`, so Turbo never claims it. The
  render checks the result: a bound form whose `method` is overridden after the
  spread, or that sets an `action`, fails the render (`invalid_definition`).
  So does a submitter with `formaction` or a non-dialog `formmethod` anywhere
  but inside an unbound form of the same render: such a submitter overrides
  whichever form owns it, and outside one (in a nested child, which may sit
  inside its parent's bound form) or with a `form` attribute (which names an
  id anywhere in the page) its owner could be a bound form. A root is checked
  with its nested children's HTML in place.
- `poll({ intervalMs, whenHidden?, whenOffline? })` — spread onto the root to
  re-render from the server on a timer (see [Polling](#polling)).
- `loadingTarget(selector?)` — while an update is in flight the client sets
  `data-jsails-loading` on the element the selector names inside the
  component, or, without a selector, on the element the attributes are spread
  on (a button that shows its own spinner).

`bind(name, options?)` takes how the client reads the control's value:
`debounceMs` delays the edit's sync, `trim` trims a text value, `number` reads
a text that is a finite number as that number (any other text stays text), and
`lazy` takes the value when the control commits it (`change`) instead of on
every `input`. Until then the typed text lives only in the control, and a
render the user did not trigger (a poll, a debounce flush, a refresh) keeps
it. They apply in the browser only; the server validates whatever arrives
against `stateSchema`.

The runtime owns serialization and transport; `render` returns Preact VNodes.

### Before the client loads

A server-rendered page is interactive before its script has run. The client
entry installs one capturing document listener for `click` and `submit` before
it awaits anything, so every component trigger (a bound form's submit, a
`call` or `sort` click) has its default prevented at once and waits, in a
bounded queue of 16, until the component bindings mount; then the held
triggers run in the order they happened. A trigger whose element left the page
meanwhile is dropped. The default of a component trigger is always prevented,
in the capture phase and also when its confirm is cancelled or its `.once` is
spent, so a JSails trigger never falls through to a navigation. The trigger
itself is dispatched when its event bubbles back to the document, after the
listeners on its element and form: one of those that stops propagation vetoes
it, which is how a form-level submit guard (such as the rich-text editor's,
which saves before it lets the submit through) holds a submit and resubmits
it. A trigger marked `.capture` is dispatched in the capture phase instead,
before any listener below can stop it.

### Widgets and `formdata`

A submit builds the form's `FormData` (`new FormData(form)`), which fires the
form's `formdata` event. A bound element that is not a native control (an
`input`, `select`, or `textarea`) is a widget host: on submit, the single string
entry its widget wrote under the host's `data-jsails-model` name joins the
update like a native control's value. The host may itself be an island, as an
editor is: its ownership is decided from its parent, so its own island marker
does not hide it, while a bound element inside another island or an ignored
subtree is never read. Native controls keep their typed reads, and a form entry
with no widget host behind it never becomes a state edit.

```tsx
// components/post-editor.tsx
import { z } from 'zod';

const stateSchema = z.object({ title: z.string().max(120), body: z.string() }).strict();

export const postEditor = defineServerComponent<z.infer<typeof stateSchema>>({
  name: 'post-editor',
  stateSchema,
  writableKeys: ['title', 'body'],
  initialState: () => ({ title: '', body: '' }),
  authorize: (context) => context.session !== null,
  actions: { save: defineAction({ input: z.object({}), run() {} }) },
  render(_state, { bind, submit }) {
    return (
      <form {...submit('save')}>
        <input {...bind('title')} />
        {/* The editor island writes the document on the form's `formdata` event. */}
        <div data-jsails-model="body" data-jsails-island="rich-text" />
        <button type="submit">Save</button>
      </form>
    );
  },
  staticFallback: () => <p>Editing is unavailable in the static export.</p>,
});
```

### Polling

```tsx
// components/build-status.tsx
import { z } from 'zod';

const stateSchema = z.object({ build: z.string().max(40) }).strict();

export const buildStatus = defineServerComponent<z.infer<typeof stateSchema>>({
  name: 'build-status',
  stateSchema,
  initialState: () => ({ build: 'main' }),
  authorize: () => true,
  actions: {},
  render(state, { poll }) {
    // Re-rendered from the server every 30 s while the tab is visible and online.
    return <section {...poll({ intervalMs: 30_000 })}>Watching {state.build}</section>;
  },
  staticFallback: () => <p>Build status is unavailable in the static export.</p>,
});
```

Each tick is a `$refresh` on the `refresh` lane, answered `unchanged` in a few
dozen bytes when nothing would change. The client:

- spreads every delay by up to 10% either way, so pages opened together never
  tick in step;
- pauses while the tab is hidden and while the browser is offline (the
  defaults; `whenHidden: 'continue'` and `whenOffline: 'continue'` keep it
  ticking), and on return refreshes at once when a tick came due meanwhile;
- after consecutive failures backs off exponentially (doubling from the
  interval, capped at 5 minutes), and waits at least the `Retry-After` a 429 or
  503 named; a success restores the interval.

`intervalMs` is a whole number of milliseconds from 250 to 86 400 000 (one
day): a browser timer longer than about 24.8 days fires at once, so a longer
interval would refresh back to back. The same marker drives a client island's
`$refresh` handler through `pollAttrs` (see [Client & Islands](/docs/client)).

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
The update endpoint accepts the session cookie, so the access chain has
already refused a request whose `Origin` is not the app's own (or that sends
no `Origin` and no `Sec-Fetch-Site: same-origin`), signed in or anonymous;
there is no CSRF token. The runtime then re-runs the component
`authorize` for the **current** request, applies client edits under
`writableKeys`, validates the strict state, runs at most one allowlisted action,
re-validates the whole state, and answers with the update protocol described
below. A `ZodError` thrown from `run` becomes a `422` with field errors and
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
token cannot be kept alive by replaying refreshes. The token carries no update
counter. An update re-signs it only when the state changed, when more than half
of its sliding lifetime is spent (`ComponentSigner.renewalDue`), or when its
subject was tagged under a retired key; otherwise the reply hands back the
presented token byte for byte, so a component that polls for hours renews its
token about once per half TTL rather than on every poll.

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

Instances whose clocks disagree still accept each other's credentials:
`clockToleranceMs` (default 60 seconds) is allowed on every check, so a snapshot
whose `issuedAt` is up to that far in the future verifies, and a snapshot,
upload reference, or download link is still accepted up to that long past its
expiry.

A custom `ComponentSigner` implements `renewalDue(snapshot)` beside `sign`,
`verify`, and `subjectFor`: it returns `true` when a re-sign would extend the
verified token's expiry and is worth doing now. A custom `ComponentSigner` may
leave `issuedAt` out of the payload its `verify` returns (the field is optional on `SnapshotPayload`). The runtime then passes no
`issuedAt` to that signer's `sign` on the next update, so enforcing an absolute
lifetime is up to the signer. A signer that supports rotation can implement
`subjectsFor(id)`, which returns the subject tag under each accepted key,
current first. Without it, only `subjectFor` is checked.

### The update protocol

`POST /_jsails/components/update` speaks protocol version 2 (the types are
exported from `jsails/server-components`: `ComponentUpdateRequest` and the
`ComponentUpdateResponse` union). A request states what the client holds:

```json
{
  "v": 2,
  "sequence": 7,
  "snapshot": "<token>",
  "updates": { "title": "Groceries" },
  "action": { "name": "add", "args": {} },
  "have": {
    "render": "<render tag>",
    "slots": [{ "slot": "k:main", "component": "card" }]
  }
}
```

`have.render` is the render tag of the DOM the client shows, carried on the
root as `data-jsails-component-render`. It is an opaque hash over the
component id, the instance id, the canonical state, the root's markup with
every nested child left out, and the list of nested `(slot, component)` pairs.
`have.slots` lists the nested children directly inside the root (see below).

Every reply carries `kind` and echoes `sequence`:

| `kind` | Status | Meaning |
| --- | --- | --- |
| `unchanged` | 200 | The render would carry the client's tag, every nested child was kept, no client edit was applied, and the action raised no effect. Nothing is morphed. `snapshot` is present only when the token was re-signed. |
| `render` | 200 | `snapshot`, `html`, `render` (the new tag), and optional `effects`: `redirect`, `download`, and `refresh` (kept children to refresh). The client morphs the HTML, then applies the effects. |
| `invalid` | 422 | `errors`, and `html` and `render` for the re-render that keeps the submitted values. The token is unchanged. |
| `error` | 4xx/5xx | `error: { code, message }`, value-free. |
| `protocol_mismatch` | 400 | The request did not say `v: 2`; `v` is the version the server speaks. The browser client reloads the page once (guarded per minute in `sessionStorage`), then blocks. |

An idle poll is answered `unchanged` in a few dozen bytes, with no re-sign.
A refusal answered before the body is read cannot know the request's sequence
and carries `sequence: 0`, which no request uses.

### Client resilience

The browser controller limits each update request to `requestTimeoutMs`
(default 30 s). If an action fails with an unknown outcome (a network error, a
timeout, or a 502/503/504 from a proxy), it is never re-sent. The controller
rejects that action and the work queued behind it with a `retryable` error and
keeps the unsent edits, but the component stays usable. A 429 is a retryable
`rate_limited` refusal (the request was not applied), and a 429 or 503 carries
the wait its `Retry-After` named as `retryAfterMs`. Only an idempotent
`refresh` is retried automatically: twice, after 500 ms and then 1 s, or after
the `Retry-After` when that is longer (the runtime's own busy answers name
1 s). A named wait over 5 s would hold every interaction queued behind the
refresh, so that refresh fails with its `retryAfterMs` instead. A poll's
refresh is never retried this way: the poll loop owns its backoff and honours
the `Retry-After` itself. Any other unexpected response still blocks the
component, which then shows a fixed message.

## The transport endpoints and their lanes

The HTTP layer mounts three endpoints, but **only when an extension registered
a runtime**: `POST /_jsails/components/update`, `POST /_jsails/components/upload`,
and `GET /_jsails/components/download`. Each is a route the runtime builds with
`componentRoute`, and only such a route can be mounted, so every request passes
the same boundary before any component code runs:

1. the access chain's cross-site check: an update or upload `POST` must send
   the app's exact `Origin` (or `Sec-Fetch-Site: same-origin` without one),
   or it is refused `403 access.cross_site` before the runtime sees it;
2. the runtime is open, and the per-address limiter admits the client
   (`429 rate_limited` otherwise);
3. the request is read under the lane's deadline;
4. the credential (a snapshot, or a download link) verifies, and the origin
   signed into it is the trusted origin;
5. the component it names is registered (`404 unknown_component`);
6. it was minted for the current session;
7. a download navigation's `Sec-Fetch-Site` is `same-origin` or `none`;
8. a concurrency slot is free (`503 unavailable` otherwise);
9. the component's `authorize` allows, against the page and route params the
   credential was minted on;
10. the handler runs.

Every request belongs to one **lane**: `update` (an action or client edit),
`refresh` (a `$refresh` poll, kept apart so polling components cannot starve
user actions), `upload`, and `download`. Each lane has its own limits, set
through the plugin's `limits` option:

| Lane | `maxConcurrent` | `maxConcurrentPerPrincipal` | `totalMs` | `idleMs` |
| --- | --- | --- | --- | --- |
| `update` | 64 | 4 | 30 s | 10 s |
| `refresh` | 64 | 4 | 15 s | 10 s |
| `upload` | 16 | 2 | 5 min | 30 s |
| `download` | 32 | 4 | 10 min | 30 s |

```js
serverComponentsPlugin({ limits: { upload: { maxConcurrent: 4, totalMs: 60_000 } } });
```

A principal is the session's subject, or for an anonymous request the client's
address bucket. A lowered `maxConcurrent` narrows the default per-principal cap
with it; an explicit per-principal cap above the lane total, an unknown lane or
field, and a value that is not a positive integer are refused when the plugin is
built, with a `component_limits.*` error (`ComponentLimitsErrors`) that names
the lane and field but never the value.

A request still running at `totalMs` is answered `503 timeout` and its
`context.signal` aborts. The lane's `totalMs` governs, not the app's
`server.handlerTimeoutMs`: each transport route's HTTP deadline is its lane's
`totalMs` (the longer of `update` and `refresh` for the update route) plus the
app's deadline, which bounds the session and scopes resolved before the lane
runs (none when the app's is `0`). An upload's body transfer counts against
the lane's `totalMs` only. Its slot stays taken until the handler actually
finishes, so a handler that ignores the signal still counts against the lane.
A streamed download keeps its slot until the stream ends, is cancelled, goes
`idleMs` without progress, or reaches `totalMs`. A `429` or `503` answer
carries `retry-after: 1`. Every refusal is value-free: it never echoes the
token, the key, the state, or the error behind a fault.

## Static export

A static export cannot sign or update a component, so it renders the
component's **static form** instead, inside a wrapper that carries the
component-name attributes but **no** snapshot or live id:

- `staticFallback(context)` (in a `.jsails` component, `<template static>`)
  renders without state, without the signing key, and without actions.
- `staticRender: 'initial'` renders the component's own `render` over
  `initialState(context)` — the export shows what a first visit shows — with
  inert tools: `bind` gives the field's value without the model marker,
  `submit` gives a form that cannot navigate (`method="dialog"`), and every
  other tool returns no marker. Action names and args are still validated,
  and a bound form must stay inert exactly as in a served render (no
  `method` override, no `action`, no `formaction`/`formmethod` submitter
  that could land on it). It renders only when `authorize(context)` returns
  exactly `true` for the static context, which has no session; otherwise the
  export fails with `component_static.initial_denied`. Neither the `mount`
  hook nor URL seeding runs. The two forms are exclusive.

A `renderNested` child of a static form renders its own static form, inline,
and the chain stops at the same depth as a served one.

A component with neither form fails closed: `component_static.missing_fallback`.
Any other failure of a static form — a throwing `authorize`, `initialState`,
`render` or `staticFallback`, a bound form that could navigate, a nested
chain past its depth — is `component_static.render_failed`, with the failure
as its cause. The page that renders the component fails the build as
`PageRenderError('invalid_route')` naming the route, with the refusal as its
cause — the page's error boundary does not render in its place, and nothing
is written.

## Registering with `serverComponentsPlugin`

Register components through the `serverComponentsPlugin` extension. Without a
`components` option, the plugin reads the entry list the build generates
(`.jsails/components.registry.ts`, one `{ id, definition }` per file under
`components/`) from the app root when it is set up, so an app never lists its
components by hand. The app root is the app config's directory, not the working
directory, so `--config` pointing at a project from elsewhere finds its
components, and `jsails describe` lists them without setting the app up.
Each application builds its own registry; nothing is registered into shared
module state.

```js
// jsails.app.js  (app-owned; compiled ESM)
import { serverComponentsPlugin } from 'jsails/server-components';

export default {
  rootDir: '.',
  extensions: [
    // The key is not hardcoded: explicit signingKey / JSAILS_COMPONENT_SECRET,
    // or an ephemeral key only in development/test, else a live render fails.
    serverComponentsPlugin(),
  ],
};
```

An explicit `components` map (a plain object keyed by component id; arrays are
rejected) replaces the generated list, for out-of-tree or test wiring. The
registry is checked when it is built: a malformed id, a value that is not a
component, a definition whose `name` differs from its id, and two components
under one id (for example `task-list.tsx` beside `taskList.tsx`) each fail with
a `component_registry.*` error instead of letting one component take over the
other's snapshots. For a runtime assembled by hand with
`createServerComponentsRuntime`, `createComponentRegistry(await loadComponentEntries({ rootDir }))`
builds the same registry from the generated entries (or from your own
`{ id, definition }` list); the runtime's `routes` hold the three transport
handlers.

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
verifies it and its signed origin, and re-runs `authorize` (the cross-site
check already ran in the access chain). Only after that
does it open the file part, and it streams the file to disk without buffering
it. An unauthorized request is refused without reading the file.

The checks, in order:

- A `content-length` over the cap is refused before anything is read.
- The snapshot field must arrive within 10 seconds, or the request gets
  `400 invalid_request`.
- The `upload` lane's limits bound concurrency: no more than `maxConcurrent`
  uploads (default 16) at once, and `maxConcurrentPerPrincipal` (default 2) for
  one session or address bucket; past either, the request gets `503`. A slot is
  taken only after the origin, snapshot, and session checks have passed,
  so unauthenticated clients that send slowly cannot use up the slots.
- The body carries the snapshot field, then one file, and nothing else: a
  third part fails the file with `413`. It is read by the same streaming
  reader as a route's `multipart` body (see
  [Streaming a multipart body](/docs/forms#streaming-a-multipart-body)).
- A body whose bytes stop arriving for the lane's `idleMs` (default 30 s) is
  aborted with `400 invalid_request`; an upload still running at `totalMs`
  (default 5 min) gets `503 timeout`. Either way its slot is released.
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

## File downloads

Downloads are off until the plugin passes a `downloads` options object
(`{ ttlMs? }`, the link lifetime, default 5 minutes). An action then returns
`download(id, { filename, contentType })` for a file in the upload store, and
the update response carries a signed link to `GET /_jsails/components/download`.
The link carries the same claims as the snapshot it was minted from (component,
subject, origin, page), so the download lane re-runs the component's
`authorize` against that page's route params: a link for one record cannot be
used once the policy no longer admits it. Because the link travels in a URL, its
signed claims are capped at 8 KiB; an action whose page path and route params
would exceed that fails (500, reported) instead of returning a link that could
never be served.

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

`mountLive(definition, context)` renders a definition you hold, under its
registered name: `await mountLive(counter, context)` is
`await renderServerComponent('counter', context)` with the name taken from the
definition, and it is what a compiled `.jsails` page calls for a live tag.

## Live components in `.jsails`

A `.jsails` file under `components/` is a live component. `defineLive({ … })`
in `<script>` is its definition (every option but `name`, which comes from the
path, and `render`/`staticFallback`, which come from the template blocks);
`<script setup>` and `<template>` are its `render`, and `<template static>`
its static fallback. As a folder (`components/task-list/task-list.jsails`
with `task-list.ts`), the `defineLive` call is in `task-list.ts`; see
[One file or a folder](/docs/view#one-file-or-a-folder).

```html
<script lang="ts">
/** Demo task list: server state, two actions, and a static-export fallback. */
import { z } from 'zod';

defineLive({
  stateSchema: z
    .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
    .strict(),
  initialState: () => ({ title: '', tasks: [] }),
  writableKeys: ['title'],
  authorize: () => true,
  actions: {
    add: serverAction({
      input: z.object({}),
      run(state) {
        const { title } = z.object({ title: z.string().min(1) }).parse({ title: state.title });
        state.tasks.push(title);
        state.title = '';
      },
    }),
    remove: serverAction({
      input: z.object({ index: z.number().int().min(0) }),
      run(state, { index }) {
        state.tasks.splice(index, 1);
      },
    }),
  },
  derived: { count: (state) => state.tasks.length },
});
</script>

<template>
  <form @submit="add">
    <input js-model.trim="title" placeholder="New task" />
    <button js-loading>Add</button>
  </form>
  <p js-if="errors.title">{{ errors.title }}</p>
  <ul js-if="tasks.length > 0">
    <li js-for="(task, index) in tasks" :key="task">
      {{ task }}
      <button @click="remove({ index })" js-confirm="'Remove it?'">Remove</button>
    </li>
  </ul>
  <p js-else>No tasks yet.</p>
  <p>{{ count }} {{ count === 1 ? 'task' : 'tasks' }}</p>
</template>

<template static>
  <p>The task list works when the site is served.</p>
</template>
```

- **Names.** A free name in the template or `<script setup>` is a state field
  (`tasks`, `title`); `errors`, `values` and `context` are the render tools',
  and each key of `derived` is its value. `defineLive`'s argument is an object
  literal with static keys, and `derived` an object literal, because the
  compiler reads them. The static form names only `context`, imports and
  catalog names (`sfc.static_unbound`).
- **Actions.** `@click`, `@submit` (on a `<form>`) and `@intersect` name an
  action, alone or with one argument (`remove({ index })`); `.prevent`,
  `.once` and `.capture` are the modifiers. An action name the component does
  not declare is a TypeScript error at the attribute; so are wrong args.
- **Directives.** `js-model` (with `.trim`, `.number`, `.lazy`, on an
  `<input>`, `<select>` or `<textarea>`), `js-confirm`, `js-loading` (the
  element itself is the indicator), `js-poll`, `js-sort`, `js-ref` and
  `js-ignore` lower onto the render tools. `js-show` and `js-text` on a bare
  state field also carry the client marker, so a local edit updates them
  before the server answers (`js-show` toggles `hidden`).

A page, a layout or the not-found page renders a live component by its tag,
resolved from the catalog or imported in `<script>`: `<TaskList />`. Mounting
is async (authorize, initial state, a signed snapshot) and a page renders its
tree in one pass, so the compiler hoists each mount into the page function,
under the same `js-if`/`js-else-if` conditions the template puts around the
tag, and renders the result in the tag's place. Each condition runs once
before the template and once in it, so a condition around a live tag must not
have side effects; a component the template does not render is not mounted.
A live tag takes no attributes or children (`sfc.live_props_unsupported`),
cannot sit inside a `js-for`, a scoped slot or a `<slot>` fallback
(`sfc.live_tag_position`), and renders only in those three kinds
(`sfc.live_outside_page`).

## Nested components

`defineNestedComponent` / `renderNested` let a parent render independently
authorized, stateful children, each with its own signed snapshot and component
id. Child state is fully independent: every render and update
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

### Child identity across a parent update

A parent never re-derives its children, and no child token travels with the
parent's request. Each child's wrapper carries its slot,
`data-jsails-nested-slot` (`k:<key>` for a child with a `key`, or
`p:<component>:<n>` for the n-th unkeyed child of that component in the
parent's render), its component id, `data-jsails-nested-component`, and an id
derived from the parent instance and the slot, so a morph pairs the old and
new wrapper of a slot exactly. The `(slot, component)` pair is the child's
identity.

On a parent update the client reports the children it holds in `have.slots`.
For each `renderNested` call:

- A child the client holds in that slot with the same component is **kept by
  reference** when its `authorize` returns exactly `true` for the current
  request. Nothing else of it runs: no `initialState`, `mount`, hooks, or
  render. Its wrapper carries a keep marker (`<template
  data-jsails-nested-keep>`) instead of HTML, and the client leaves the
  wrapper as it is, so the child keeps its DOM, its controller and token, its
  typed values, and its validation errors.
- Any other child (not held, held with another component, or under a key that
  changed) is mounted fresh.
- A child whose `authorize` returns anything but exactly `true` renders
  nothing (`renderNested` returns `null`), so a child the viewer may no longer
  see disappears from the parent. A throwing `authorize` is a fault.
- A held slot the render does not produce is ignored, and rendering one key
  twice in a render fails with a `duplicate_slot` `NestedComponentError`. A
  slot or a component id longer than `MAX_SLOT_LENGTH` (256 characters; a long
  `key`, for example) fails with `invalid_config`, because the client could
  not report it back.

A reply that mounted any child fresh is a `render`, never `unchanged`: the
fresh child is markup the client does not have. The client leaves a child out
of `have.slots` when its controller is blocked, so the parent's next update
replaces it. A child inside a client island or a `data-jsails-ignore` subtree
is never reported, so it is mounted again, and its parent re-rendered, on
every update of that parent; keep nested server components out of those
subtrees.

`have.slots` is held hints, never authority: the server trusts nothing about
a child from it beyond the pair, and a kept child is authorized like any
other. The JSON encoding of `have.slots` is capped at `MAX_HAVE_SLOTS_BYTES`
(32 KiB, room for about 700 typical entries); each slot and component id is at
most `MAX_SLOT_LENGTH` (256) characters. The client refuses to send an update
over the cap and blocks with `too_many_children`, and the server answers such
a request `400 too_many_children`. A 422 re-render keeps held children the
same way.

Give a child a `key` when its position can change between renders (a list
that reorders or filters), so it keeps its identity rather than its
neighbour's.

#### Refreshing children from a parent action

A kept child is not re-rendered, so a parent action that changed data a child
shows asks the client to refresh it. An action's `run` receives a
`ServerComponentActionContext`, the request context plus two calls:

```tsx
// One of a parent component's `actions`.
declare function archiveAll(listId: string): Promise<void>;

export const archive = defineAction<{ listId: string }>({
  async run(state, _input, context) {
    await archiveAll(state.listId);
    context.refreshChild('main'); // the child rendered with key 'main'
    context.refreshChildren(); // or every child this render keeps
  },
});
```

The reply's `effects.refresh` lists the named slots this render kept, in
render order (a child mounted by the same render is already fresh, and a name
that matches no kept child is dropped). The client refreshes each one through
the child's own controller and token.

After the parent's HTML is morphed in, the client reconciles the nested roots:
a kept child keeps its binding and client state, a new child is bound from its
markers, a removed one is disposed, and a child swapped for another instance
is rebound. A keep marker that still lands in the DOM (the child went away
while the request was in flight) makes the parent re-render once in full.
Nested islands whose name and props did not change keep their state across the
morph; only a changed island is torn down and re-hydrated.

## Form objects

`defineForm` wraps a Zod object schema and provides typed field access,
`fill` / `validate` / `reset` helpers, and `toState` / `fromState` JSON
round-trip methods compatible with the server-component snapshot protocol. A
`FormObject` is a plain object created inside a component action or lifecycle
hook; `FormDefinitionError` is raised for an invalid schema or for any option
other than `schema` and `initial`. `fromState(state)` replaces every value, so a
key the state omits is cleared rather than kept from before.

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
