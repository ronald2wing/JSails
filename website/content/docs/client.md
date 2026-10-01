---
title: Client & Islands
order: 10
section: Building
---

# Client & Islands

`jsails/client` is the **browser-safe** runtime. It owns hydration, Turbo soft
navigation, and the server-component bindings, so your browser entry stays tiny:
register your islands (Preact components hydrated inside server-rendered HTML),
call `startClient()`, and let the framework drive the rest. There is **no automatic module discovery** — every island must be
registered explicitly.

## Starting the client

`startClient(options?)` dynamically imports `@hotwired/turbo`, starts the shared
Turbo session, registers any declarative `islands` map, hydrates the initial
island markup, and auto-enables the server-component bindings. It is idempotent,
and a failed start tears down listeners/islands and remains retryable.

```tsx
// client/main.tsx  (app-owned browser entry)
import { registerIsland, startClient } from 'jsails/client';
import { Counter } from './counter';

registerIsland('counter', Counter);
startClient();
```

The starter's whole browser entry is exactly this shape: register the `counter`
island once, then `startClient()`. There is no manual `hydrate`, `fetch`, or
`history` call.

## Registering islands

`registerIsland(name, component)` registers a typed Preact island. The same name
with the same component is a no-op; a different component under an existing name
throws. You can also pass a declarative map to `startClient`:

```tsx
import { startClient, type IslandComponent } from 'jsails/client';

const Counter: IslandComponent = ({ start }) => <button type="button">{String(start)}</button>;

void startClient({ islands: { counter: Counter } });
```

or a list of defined islands (`defineIsland` from `jsails/view`, which every
compiled `.jsails` island is), each registered under its own id, the id its
server markup names; a component in the list without one throws
`IslandRegistryError` (`invalid_island_component`):

```tsx
import { startClient } from 'jsails/client';
import { defineIsland } from 'jsails/view';

const Counter = defineIsland('counter', ({ start }: { start: number }) => (
  <button type="button">{start}</button>
));

void startClient({ islands: [Counter] });
```

Islands are server-rendered elements that carry two data attributes:
`data-jsails-island="name"` identifies the registered island name, and
`data-jsails-props` holds the bounded JSON props. `<Island>` from
`jsails/view` (what a `.jsails` island tag compiles to) renders them on a
`<jsails-island>` element and opens an island scope in which a nested
`<Island>` renders inline; the runtime hydrates each island inside the same
scope, so the server and browser trees match.

The element `id` is required only for `data-turbo-permanent`.

## Hydration

`data-hydrated="true"` is set on hydrate and removed on restore, but hydration is
tracked per element **identity** (a `WeakMap`), never by the attribute alone. A
cache restore or Turbo clone can carry the attribute without a live Preact root,
so the runtime never trusts the marker by itself.

A hydration or render error is reported (default `console.warn`, or `onError`)
and that island is skipped; the rest of the document keeps hydrating.

When a server component re-renders, the islands nested inside its root go
through Turbo's morph. An island whose `data-jsails-island` name and `data-jsails-props`
are unchanged keeps its live Preact state, focus, and listeners: the runtime
cancels Turbo's `turbo:before-morph-element` for it, so Idiomorph skips that
subtree, including changes to the island's other attributes. Any other island
is unmounted right before Turbo morphs or removes it, which restores its server
markup, and it is re-hydrated afterwards if it is still in the document.
Before Turbo caches a page, every non-permanent island is unmounted first, so
cached snapshots still hold clean server markup.

## Island props

Island props are decoded with `JSON.parse` only, bounded by length (65 536
characters), depth (32) and key count (1 000). The decoder rejects
`__proto__`, `constructor`, and `prototype` keys at any depth, so a hostile
`data-jsails-props` payload cannot pollute the prototype chain. A value it
refuses is reported as `island.props_unparseable`, `island.props_too_large`
or `island.props_invalid` (`IslandErrors` from `jsails/view`) and that island
is skipped. `<Island>` uses the same decoder on the server and renders from
the decoded copy, so such props fail the server render instead of shipping an
island that never hydrates.

## The toolset: one authoring model for islands and server components

Server components and islands share the same `data-jsails-*` markers. A server
component resolves them to server actions; an island resolves the same markers
to local handlers through `useIslandDirectives`. Learn the markers once and the
markup moves between a static export and a server-rendered app unchanged.

```tsx
import { useIslandDirectives } from 'jsails/client';

const { ref, findRef } = useIslandDirectives({
  handlers: {
    save: (args) => persist(args),
    sort: ({ field }) => setSort(String(field)),
    $refresh: () => reload(),
  },
  state: { open: isOpen, count },
  onInput: (name, value) => setDraft(name, value),
});
```

`useIslandDirectives` returns `ref` (attach it to the island root; every marker is
scoped to that subtree) and `findRef(name)` (resolve a `data-jsails-ref` element
by name). The effect re-runs on every render, so state-driven markers re-apply
and intersect sentinels re-arm.

| Marker                       | Builder                                                        | Island behavior                                                            |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `data-jsails-call`           | `callAttrs(action, args?)`                                     | Click dispatches `handlers[action](args)`.                                 |
| `data-jsails-submit`         | `submitAttrs(action, args?)`                                   | Submit is prevented and dispatched; `method="dialog"` keeps it inert.      |
| `data-jsails-sort`           | `sortAttrs(field)`                                             | Click dispatches the reserved `sort` handler with `{ field }`.             |
| `data-jsails-intersect`      | `intersectAttrs(action)`                                       | Fires once on viewport entry, then re-arms on the next render.             |
| `data-jsails-model`          | `bindAttrs(name, { debounceMs })`                              | Input/change calls `onInput(name, value)`; debounced per field.            |
| `data-jsails-show`           | `showAttrs(field)`                                             | `hidden` follows `state[field]`.                                           |
| `data-jsails-text`           | `textAttrs(field)`                                             | `textContent` follows `state[field]`.                                      |
| `data-jsails-poll`           | `pollAttrs({ intervalMs, whenHidden, whenOffline })`           | Repeats the `$refresh` handler; pauses while hidden or offline by default. |
| `data-jsails-confirm`        | `confirmAttrs(message)`                                        | Gates a call/submit behind a confirm prompt.                               |
| `data-jsails-once`           | —                                                              | The trigger dispatches at most once.                                       |
| `data-jsails-loading-target` | `loadingTargetAttrs(selector)`                                 | Toggles `data-jsails-loading` on the matched element while a handler runs. |
| `data-jsails-ref`            | `refAttrs(name)`                                               | Named handle for `findRef`.                                                |
| `data-jsails-ignore`         | `ignoreAttrs()`                                                | Opts a subtree out of morphing (no effect in islands).                     |

Every builder is browser-safe and exported from `jsails/client`, so the same
attribute maps render on the server and inside an island. Before a call or
submit dispatches, the hook flushes every bound control in scope through
`onInput`, so a handler always sees the latest field values. A submit also
builds the form's `FormData`, which fires its `formdata` event: a bound element
that is not a native control (a widget host such as an editor's container)
passes the single string entry its widget wrote under its `data-jsails-model`
name to `onInput`. Pass `confirm` to override the default `window.confirm`
prompt (useful in tests). Poll timing (jitter, pause, catch-up, backoff) is the
same as a server component's; see
[Polling](/docs/server-components#polling).

## Model projection (`jsails/client/model`)

A server component owns its state; the client never becomes a second authority
over it. `jsails/client/model` is the browser-safe primitive that projects
server-owned state into `@preact/signals` for reactive rendering — a **one-way**
projection, not a copy you can trust to be authoritative.

```ts
import { createModel } from 'jsails/client/model';

const model = createModel({
  fields: { title: {}, tasks: {}, draft: { ephemeral: true } },
});

model.project(snapshot); // snapshot → signals (synced fields only)
model.value('title'); // read the current projection
model.signal('tasks'); // subscribe for re-renders
model.set('title', 'local edit'); // explicit local edit
model.snapshot(); // synced fields back out; ephemeral excluded
model.dispose(); // idempotent; later use throws `disposed`
```

`createModel` declares fields; a field marked `ephemeral` is client-only scratch
state, excluded from `snapshot()` and never touched by `project()`. `project` is
strictly one-way: signals are written only by `project(state)` or an explicit
local `set`, and `snapshot()` never feeds a signal back into the authoritative
snapshot. `ModelError` is value-free (never echoes input, secrets, or raw values) and carries the codes `invalid_definition`,
`invalid_state`, `unknown_field`, and `disposed`.

`bindModel(source, definition)` couples a model to the object that owns the
authoritative state (a live component controller — any `{ state }` object). It
is deliberately **pull-only**: it projects once, then re-reads the source on each
`project()` call, and never subscribes to the source or pushes a `model.set`
back into it. The binding layer owns the push side: it calls `project()` whenever
the controller's state changes (for example from the controller's `onRender`
path). Keeping the source the single authority means a local edit can never
silently corrupt server-owned state.

```ts
import { bindModel } from 'jsails/client/model';

const bound = bindModel(controller, { fields: { title: {}, tasks: {} } });
bound.project(); // re-read the controller's latest state
bound.dispose();
```

## Turbo soft navigation

Turbo owns all link interception and history: the runtime installs no bespoke
click handler, `history` call, or router. Ordinary valid same-origin `<a href>`
links get Turbo soft navigation over server-rendered (SSR) **and** plain static
(SSG) pages, including back/forward.

Native opt-outs are left to the browser's default full navigation. These include
links to an external origin, links with a `download` attribute, links with a
`target`, a modified left-click, and any element marked `data-turbo="false"`.

There is **no HMR** — the client runtime does not patch modules. `dev` reloads
the page instead: a server change restarts the process, a client change (island
TSX, CSS, theme) bumps a build generation, and the injected reload script
reloads the browser when the generation it rendered with is stale. State is not
preserved across a reload. The reload route and script come from the `devPlugin`
in `jsails/dev`: list `'jsails/dev'` in `plugins.use` (the server-rendered
starters do). It registers nothing unless `NODE_ENV` is `development`.

## Morphing components

`morphComponent(target, html, options?)` renders a Turbo stream message and
resolves once it lands; `MorphComponentOptions.action` now accepts the full
`TurboStreamAction` set — `replace`, `update`, `append`, `prepend`, `remove`,
`before`, `after`, `refresh` — so a single call covers every Turbo Stream action.
Use `morphComponent` when a server response should update an existing DOM subtree.

## Turbo Streams builders

`jsails/client` exports pure `<turbo-stream>` string builders with no DOM or
Turbo dependency, safe to call server-side:

- `turboStreamMessage(action, target, html?)` — the generic builder.
- `replaceStream(target, html)`, `updateStream(target, html)`,
  `appendStream(target, html)`, `prependStream(target, html)`,
  `beforeStream(target, html)`, `afterStream(target, html)` — content actions
  taking a CSS selector and HTML.
- `removeStream(target)`, `refreshStream(target)` — structural actions taking
  only a CSS selector.

Every helper returns a serialized `<turbo-stream>` element and is trusted
producer output — the caller owns HTML escaping.

## Before-navigation hook

A cancelable `jsails:before-navigation` document event (plus an `onBeforeNavigation`
hook) fires before a navigation commits, so a runtime can drop stale in-flight
work.

```ts
document.addEventListener('jsails:before-navigation', (event) => {
  // Cancel the navigation, or abort in-flight requests.
  event.preventDefault();
});
```

## Hotwire Native groundwork

`src/client/native.ts` adds a pure-path configuration layer for Hotwire Native
mobile-web hybrids, with no native SDK dependency.

- `definePathConfiguration(rules)` builds a `PathConfiguration` from
  application- or pattern-matched `PathRule`s.
- `resolvePathConfiguration(config, path)` returns the best-matching rule for a
  given path.
- `resolvePathConfigurationMerged(config, url)` merges every matching rule
  (later wins); `defaultPathRules()` returns the standard recede/resume/refresh
  historical-location rules.
- `isNativeApp()` detects whether the client is running inside a native app's
  web view from its `User-Agent`.

```ts
import { definePathConfiguration, isNativeApp, resolvePathConfiguration } from 'jsails/client';

const config = definePathConfiguration([{ patterns: ['/new$'], properties: { context: 'modal' } }]);

if (isNativeApp()) {
  const rule = resolvePathConfiguration(config, '/posts/new');
}
```

`nativeBridge` is a stub object (type only) — JSails ships no bridge adapter, and
native bridge integration is the app's responsibility.

## Next steps

- [Server Components](/docs/server-components) — signed, stateful components with
  server actions.
- [Content](/docs/content) — the content surface for blogs and structured text.
