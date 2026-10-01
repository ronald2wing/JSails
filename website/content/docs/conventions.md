---
title: Conventions
order: 2
section: Orientation
---

# Conventions

JSails delivers Rails-style ergonomics through **convention, generators, a
declarative model DSL, and a generated autoload layer** — so project code needs
no imports. This page explains the mental model so a new project reads like a
framework, not a pile of imports.

## How conventions are chosen

Every convention here is a deliberate choice, reached the same way. We adopt an
idea only when it is a good idea, and we build it properly rather than taking the
easy path. Ergonomics are a means, never an excuse to ship a wrong or
half-thought-through design. When a feature is hard to build well, the answer is
to build it well — not to skip it because the easy path is shorter, and not to add
it because implementation is cheap. Each surface below is a decided answer,
documented with its rationale and its limits so the trade-off is visible rather
than implicit.

## No import: the data layer is already available

The whole data layer is **installed as globals**, so a server module uses the
Active Record base, query expressions, validation, jobs, and encryption with no
import line at all:

```ts
// models/post.ts — no import; the symbols below are globals.
export class Post extends ApplicationRecord {
  declare title: string;
}

const hot = await query(Post).where(qGt('likes', 10)).getMany();
```

`ApplicationRecord`, `query`, `qGt`, `defineEntityValidation`, `validateFields`,
`defineJob`, and the rest are projected onto `globalThis` by the preload
(`jsails/symbols`), and the generated ambient `.d.ts` declares them so `tsc`
type-checks a bare reference (see
[Autoloading: no imports for project code](#autoloading-no-imports-for-project-code)
below).

When you _want_ an explicit import — a browser module, a plain Node script, or a
symbol you prefer to see in the file — every subpath (`jsails/database`,
`jsails/jobs`, `jsails/api`, `jsails/validation`, …) re-exports the same surface
from a browser/server-appropriate barrel, so you never hunt for which subpath a
symbol lives in. Imports are **optional**, not wrong; bare globals are the
default.

## Models are declarative

A model is a class that declares only its shape. It extends `ApplicationRecord`
and uses the `@jsails.*` decorators with no import; the compiler derives the
table, columns, relations, and migration state. The authoritative authoring
surface — decorators, relation functions, `defineModel`, and the compiler
pipeline — is [Models](/docs/models); the data source and raw escape hatches are
[Database](/docs/database).

## Autoloading: no imports for project code

Rails auto-loads constants with Zeitwerk, which relies on Ruby's `const_missing`
hook and a deterministic file↔constant convention. **Node ESM has neither**: an
unqualified identifier is a `ReferenceError` (there is nothing to intercept), and
`import` requires an explicit specifier. JSails closes that gap with a
**generated autoload layer** rather than asking you to hand-write the glue.

The project-local **N1 tree** is genuinely auto-imported. A module placed under
one of these directories is available by name, with no import:

| Directory                                          | Context | Notes                                             |
| -------------------------------------------------- | ------- | ------------------------------------------------- |
| `app/composables/`, `app/utils/`                   | app     | client-safe helpers                               |
| `shared/`                                          | app     | client-safe values shared by server and client    |
| `server/`                                          | server  | server-only modules                               |
| `models/`                                          | server  | Active Record models                              |
| `ui/`                                              | app     | PascalCase Preact components, globally autoloaded  |
| `jobs/`, `commands/`, `services/`, `extensions/`, `components/` | server  | jobs, CLI commands, domain services, extensions, server components |

`pages/` and `api/` are **consumers**, not providers: they read autoloaded
symbols but are never themselves published as globals. `ui/` is a whole-tree
provider for **PascalCase component exports**: every PascalCase named value
export from every `.ts`/`.tsx` file under `ui/`, including nested directories,
is autoloaded. Helpers and constants (`loadLayout`, `INITIAL_COUNT`,
`summarizeNote`) stay explicit imports. Starter components use a standout `Ui*`
prefix (`UiField`, `UiDialog`, `UiLayout`, `UiCounter`) so they can be app-wide
globals without colliding with ordinary names. The prefix is a convention, not
the filter; PascalCase is the filter. Default exports are not projected.

`jsails build:meta` scans the tree, extracts each module's named value exports,
and emits two artifacts into `.jsails/`:

- **`.jsails/project-symbols.js`** — a preload that installs the framework symbols, then
  dynamically imports each provider's shim in dependency order. `jsails serve`,
  `jsails build`, and `jsails dev` preload it automatically; a plain Node script
  (like the default starter's feed generator) opts in with
  `node --import ./.jsails/project-symbols.js`.
- **`.jsails/project-symbols/*.js`** — one shim per provider module that imports the
  compiled module and publishes its exports onto `globalThis`, after first
  importing the shims of any providers it references.

The generated `.jsails/project-symbols.app.d.ts` and `.jsails/project-symbols.server.d.ts`
declare every autoloaded symbol as a global, so `tsc` type-checks a bare
reference with no import. A symbol referenced from a client-safe context may only
resolve to another client-safe symbol; a server-only symbol is reachable from
server code only.

```ts
// server/content.ts — a provider; consumers reach its exports by bare name.
import { defineContentCollection } from '@jsails/content';

export const posts = await defineContentCollection({ dir: 'content/posts' });

// pages/index.tsx — a consumer; `posts` and `Layout` are bare.
export function load() {
  return { posts };
}
export default function Home() {
  return <Layout>{/* ... */}</Layout>;
}
```

Everything outside the N1 tree is reached by _convention_ plus **generators**:
the framework's own globals, a single base class, declarative model factories,
and `jsails make:*` commands that emit import-complete, compilable files.
Framework authoring entry points (`defineModel`, `defineJob`, `defineService`, …)
are themselves installed as globals, so a model, job, or service file needs no
import either. Symbols from a separate package — `@jsails/content`,
`@jsails/blog`, … — are not framework globals and stay explicit imports.
Zod is projected as a server-side global through `jsails/zod`, so server code
gets `z.object(...)` and `z.infer<...>` without an import. Browser code imports
Zod explicitly; other third-party packages (`preact`, …) stay explicit imports.
A local `z` import still shadows the global, so explicit imports remain safe.

### Scoped UI auto-imports

Preact hooks and signals are not globals. They are injected as real imports in
`ui/**` and `client/**` only:

- Vite's `autoloadPlugin` injects them into source modules.
- `jsails inject:auto-imports` injects them into compiled server output after `tsc`, so
  SSR sees the same imports.
- `.jsails/auto-imports.d.ts` declares them for typechecking. TypeScript has no
  per-directory globals, so this declaration is global, but the runtime import
  is per-file.
- A hook used outside `ui/**` or `client/**` is rejected instead of becoming a
  runtime `ReferenceError`.

UI components are app-context N1 globals with the standout `Ui*` prefix. Only
the generic hooks/signals are directory-scoped auto-imports.

**Two projections: server and browser.** The framework's own exports are
projected onto `globalThis` at two entry points, split by whether a subpath is
safe to load in a browser:

- **Server** — `jsails serve`/`build`/`dev` preload `.jsails/project-symbols.js`,
  whose first act is `installFrameworkSymbols()` (from `jsails/symbols`). It projects
  the curated server autoload surface (`models`, `database`, `jobs`, `services`,
  `support`, …), so `ApplicationRecord`/`BaseEntity`/`query`/`Service` are bare in
  server modules.
- **Browser** — a client entry calls `installBrowserSymbols()` (from
  `jsails/symbols/client`) once before hydration. It projects only the
  **browser-safe** subpaths (`jsails/api`, `jsails/client`, `@jsails/theme`,
  `jsails/i18n`, …) — never a server-only one (`jsails/database`, `jsails/jobs`,
  `jsails/server-components`), so a projected name can never drag TypeORM,
  BullMQ, or Better Auth into the client bundle.

Both share one collision/override engine (one namespace object per colliding
subpath; a changed value warns once and wins; an identical re-install is silent),
so a name resolves the same way in either target. A server-only name is still
usable in the browser — just by explicit `import`, never bare.

## Generators write the imports for you

`jsails make:*` emits an **import-complete, compilable** file in the conventional
directory, so a generated file compiles against a fresh scaffold with no further
editing:

```sh
jsails make:model post           # models/post.ts — extends ApplicationRecord
jsails make:page about-us        # pages/about-us.tsx — wired to the Layout
jsails make:api health           # api/health.ts — a read-only GET route
jsails make:job send-reminder    # jobs/send-reminder.job.ts — a Zod-validated job
jsails make:command report       # commands/report.ts — a CLI command
jsails make:server-component todo # components/todo.tsx — a live server component
jsails make:serializer post      # serializers/post.ts — a field serializer
jsails make:middleware cache     # middleware/cache.ts — a route middleware
```

Each generated file follows the starter's own conventions. Because the N1 tree is
autoloaded, a generated file that references a sibling provider needs no import
for it — only third-party packages stay explicit.

Code generators also emit a companion `test/<kind>/<name>.test.ts` (page, API,
job, model, command, server component, serializer, and middleware). The tests
are executable documentation: a page renders through `load`, an API handler is
called with `createTestRequestContext`, and a server component is driven through
`createComponentTestHarness`. Pass `--no-test` when you want only the artifact.
Content, post, and doc generators write Markdown only.

## Declarative plugins and resources

The same "one object is the whole thing" idea extends to plugins and API
resources, so the imperative wiring is collapsed into a single declarative spec:

```ts
// A plugin as data: services, HTTP hooks, and commands without manual setup.
import { clockToken } from './tokens.js';

export const clock = defineDeclarativePlugin({
  name: 'clock',
  requires: [/* ... */],
  provide: [[clockToken, { now: () => new Date().toISOString() }]],
  http: (app) => app.get('/time', (c) => c.json({ now: Date.now() })),
});

// An API resource as data: serializer + store + authorize in one object.
export const posts = defineDeclarativeResource({
  name: 'post',
  serializer: { id: number(), title: string(), body: optional(string()) },
  store,
  authorize: resourcePolicy({ list: require(isStaff) }),
});
// posts.serializer / posts.handlers / posts.routes / posts.authorize
```

`defineDeclarativePlugin` and `defineDeclarativeResource` are thin wrappers over
the existing `definePlugin` and `defineSerializer`/`createResourceHandlers`/
`createResourceRouter` primitives — they reshape a declarative object into the
imperative wiring, never reimplement the engine.

Three further shorthands collapse the remaining boilerplate:

- **`defineStoreResource({ slug, store, serializer })`** (`@jsails/admin`) builds an
  admin resource whose `list`/`get`/`save` are derived from a `ResourceStore`, so a
  database-backed CRUD shares one store/serializer with the API side.
- **`defineSimpleComponent(name, { fields, run, render })`** (`jsails/server-components`)
  derives the Zod `stateSchema` and `writableKeys` from a `fields` map and collapses
  actions to a single `run` — the fast path for a form, toggle, or counter.
- **`defineComponent({ stateSchema, actions, derived, style, render })`**
  (`jsails/server-components`) is the friendly authoring surface for a full
  component: `actions` split by capability into `serverAction` (round-trips through
  the snapshot) and `localAction` (pure, client-runnable), `derived` view values,
  and a `defineStyle` named-slot style contract. It lowers onto
  `defineServerComponent`, which stays the primitive. The three artifacts — model,
  view, style — can live in one file or several; a component with server-only code
  must split client-safe from `*.server` so the build's clean-bundle assertion
  holds. See [Server components](/docs/server-components) for the shapes and the
  client-safe vs server-only seam.
- **`defineAppConfig(appConfigSchema, config)`** (`jsails`) validates the top-level
  app-config shape against a Zod schema, returning typed config with value-free errors
  for a typo or wrong-typed field.

## Next steps

- [Architecture](/docs/architecture) — how the framework is assembled.
- [Models](/docs/models) — the declarative Active Record model surface.
