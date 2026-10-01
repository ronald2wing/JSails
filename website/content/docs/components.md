---
title: Components
order: 9
section: Building
---

# Components

A `.jsails` file is a single-file component in the style of Vue. It compiles
to the same Preact module a TSX component is, so it adds no runtime and no
reactivity system of its own. Markup goes in `<template>`, with `{{ }}`,
`:prop`, `@event`, `#slot` and the `js-*` directives. TypeScript goes in
`<script lang="ts">`, and CSS goes in `<style>`, optionally scoped. Where the
file lives decides what it is: a page, a layout, a live component, an island,
or a plain view.

The compiler, its type checking, and the island and style runtime
([View Runtime](/docs/view)) are in place. The app build does not compile
`.jsails` files yet, so a generated app is written in TSX for now. Every
sample on this page is compiled and type-checked by the docs build, with
TypeScript errors mapped back to the sample's own lines.

## A first component

```jsails path=ui/tag-badge.jsails
<script setup lang="ts">
defineProps<{ tag: string; count?: number }>();
</script>

<template>
  <a class="badge" :href="`/tags/${tag}`">
    {{ tag }}
    <span js-if="count !== undefined" class="count">{{ count }}</span>
  </a>
</template>
```

The file compiles to a function component named after the file,
`TagBadge`, whose props are typed by `defineProps`. The template reads `tag`
and `count` with no destructuring and no `props.` prefix: a name the file
does not declare is a prop (see [Names](#names)). A typo such as
`{{ tga }}` is a TypeScript error at that line and column of the `.jsails`
file.

## Kinds

The path from the app root decides the kind:

| Path | Kind | Compiles to |
| --- | --- | --- |
| `pages/**/layout.jsails` | layout | the layout of its directory |
| `pages/**/error.jsails` | error | the error page of its directory |
| `pages/**/not-found.jsails` | not-found | the not-found page of its directory |
| `pages/**/*.jsails` | page | a page; its route comes from its path |
| `components/**/*.jsails` | live | a live server component (`defineLiveComponent`) |
| `islands/**/*.jsails` | island | a hydrated island (`defineIsland`) |
| `mail/**/*.jsails` | mail | not compiled yet (`sfc.not_lowered`) |
| any other path (`ui/**`, `app/**`) | view | a plain component |

Each file is one component. A view or an island is named after its file's
base name in PascalCase (`ui/tag-badge.jsails` is `TagBadge`), a page-tree
function by its kind. A live component's id is its path under
`components/`, and an island's id its path under `islands/`.

What a file may do follows from its kind:

| | page, not-found | error | layout | view | island | live |
| --- | --- | --- | --- | --- | --- | --- |
| Free names are | props from `load` | `error` | props | props | props | state fields |
| `defineProps`, `defineSlots` | | | yes | yes | yes | |
| `defineEmits` | | | | | yes | |
| `context` (the request) | yes | yes | yes | | | yes |
| `await` in `<script setup>` | yes | yes | yes | | | yes |
| `<slot>` | | | yes | yes | yes | |
| Hooks (`useSignal`, `useState`) | | | | | yes | |
| `@event` | | | | | yes | actions |
| Mounts a live component | yes | | yes | | | |
| An island's tag | mounts it | mounts it | mounts it | mounts it | renders it | refused |

A view and an island render synchronously inside another tree, so `await`
there is `sfc.await_in_sync_kind`. Hooks outside an island are
`sfc.hooks_outside_island`, because nothing else runs in the browser.

## Blocks

| Block | How many | What it holds |
| --- | --- | --- |
| `<script lang="ts">` | 0 or 1 | Module scope, run once: imports, types, helpers and named exports (a page's `load`, `getStaticPaths`, `generateMetadata`; a live component's `defineLive`) |
| `<script setup lang="ts">` | 0 or 1 | Render scope, run on every render: locals and macros |
| `<template>` | exactly 1 | The markup |
| `<template static>` | 0 or 1, live only | What a static export renders instead of the live component |
| `<style>`, `<style scoped>` | any | CSS (see [Styles](/docs/view#styles)) |
| `<!-- … -->` | any, between blocks | A leading comment is the module's header when it has no `<script>` |

The scanner follows HTML: a `<script>` or `<style>` ends at the first
`</script>` or `</style>`, a `<template>` counts the `<template>` elements
nested in it, and a block may sit on one line. Every `<script>` names
`lang="ts"`; without it, the block is `sfc.script_lang_required`, with a fix
that adds it, and another language is `sfc.unsupported_lang`. `<style>`
takes `lang="css"` or nothing, and `src` is `sfc.style_src_unsupported`.

The other block errors:

- `sfc.unknown_block`: any other top-level tag;
- `sfc.duplicate_block`: a second block of a kind that allows one;
- `sfc.missing_template`: no `<template>`;
- `sfc.block_kind`: `<template static>` outside a live component.

`<script>` exports by name only, because the compiler owns the default
export (`sfc.script_default_export`). `<script setup>` exports nothing
(`sfc.setup_export`), since its code runs per render. Its macros are
top-level calls written once each: `sfc.macro_position` and
`sfc.duplicate_macro`.

## Templates

### Text

Text is literal. `{`, `}` and `>` are text, so prose and code samples need no
escaping, and `&name;` character references are decoded. An unknown name is
`sfc.unknown_entity`, and a reference without its `;` is
`sfc.entity_missing_semicolon`. Comments are dropped. Void elements may omit
`/>`, and any element may close itself.

Whitespace follows Prettier's rule for HTML, so formatting a file never
changes what it renders. A run of whitespace next to a block-level element
(`<div>`, `<p>`, `<li>`), or at the start or end of one, is dropped. Between
inline content it is one space. `<pre>`, `<textarea>` and `js-pre` keep
their whitespace exactly.

```jsails path=ui/shortcut.jsails
<script setup lang="ts">
defineProps<{ keys: string }>();
</script>

<template>
  <p>
    Press <kbd>{{ keys }}</kbd> to search. Objects print as {"a": 1} &mdash; braces are text.
  </p>
</template>
```

### Interpolation

`{{ expr }}` renders a TypeScript expression as text, escaped. The end of an
interpolation is found by parsing the expression, so `}}` inside a string or
a template literal does not end it. A `//` comment cannot end an
interpolation, because it would swallow what follows. An unclosed
interpolation is `sfc.unterminated_interpolation`, and an empty one
`sfc.empty_expression`. HTML that should render as markup goes through
`js-html` (below), never through `{{ }}`.

### Attributes

| Attribute | Meaning |
| --- | --- |
| `name="text"` | A static value; entities are decoded |
| `name` | `true` |
| `:name="expr"` | A bound value, any TypeScript expression |
| `:class`, `:style` | A string, a record or an array, merged with the static `class` and `style` ([details](/docs/view#classes-and-styles)) |
| `js-bind="obj"` | Spreads an object of attributes, its `class` and `style` merged after the element's own |
| `@event="handler"` | An event, in an island or a live component only |
| `#name`, `#name="{ … }"` | On `<template>` inside a component tag: a named or scoped slot |

```jsails path=ui/nav-link.jsails
<script setup lang="ts">
const { href, current = false } = defineProps<{
  href: string;
  current?: boolean;
  extra?: Record<string, string>;
}>();
</script>

<template>
  <a
    class="link"
    :class="{ 'link-current': current }"
    :href="href"
    :aria-current="current ? 'page' : undefined"
    js-bind="extra"
    ><slot
  /></a>
</template>
```

Destructured props keep their defaults (`current = false`), and a name the
template reads that is neither destructured nor declared elsewhere (`extra`)
is still a prop.

An inline handler (`onclick="…"`) is `sfc.event_handler_attribute`: it is
inline script, which a strict Content-Security-Policy refuses. `data-s`
belongs to the compiler's style scoping (`sfc.reserved_attribute`), and
`dangerouslySetInnerHTML` and `innerHTML` are `sfc.raw_html_attribute`:
`js-html` is the one door for trusted HTML. A Vue spelling (`v-if`,
`v-bind:x`, `.prop`, `slot-scope`) is `sfc.vue_syntax`, with a fix to the
JSails one.

### Conditionals

`js-if`, `js-else-if` and `js-else` chain over adjacent siblings. A
`js-else` with no `js-if` before it is `sfc.stray_else`. To make several
elements conditional, put the directive on a `<template>`, which renders only
its children:

```jsails path=ui/order-status.jsails
<script setup lang="ts">
defineProps<{ status: 'open' | 'shipped' | 'cancelled'; trackingUrl?: string }>();
</script>

<template>
  <p js-if="status === 'open'">Preparing your order.</p>
  <template js-else-if="status === 'shipped'">
    <p>On its way.</p>
    <a js-if="trackingUrl" :href="trackingUrl">Track the parcel</a>
  </template>
  <p js-else>Cancelled.</p>
</template>
```

Narrowing works as in TypeScript: inside `js-if="trackingUrl"`, `trackingUrl`
is a `string`, also inside a `js-for` callback below it.

### Loops

`js-for` takes the forms Vue does, with `in` or `of`:

| Form | Iterates |
| --- | --- |
| `item in items` | an array or any iterable |
| `(item, index) in items` | with the index |
| `({ id, name }) in items` | destructured |
| `(value, key, index) in record` | a plain object, in `Object.keys` order |
| `n in 10` | the numbers 1 to 10 |

`null` and `undefined` render nothing. Give each item a `:key`; inside
`js-for`, a missing key is the warning `sfc.for_without_key`. `js-if` and
`js-for` on one element is `sfc.if_with_for`, because which one applies first
would be a guess: put the loop on a `<template>` and the condition inside, or
the reverse.

```jsails path=ui/price-table.jsails
<script lang="ts">
export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly features: Readonly<Record<string, boolean>>;
}
</script>

<script setup lang="ts">
defineProps<{ plans: readonly Plan[]; stars: number }>();
</script>

<template>
  <table>
    <tr js-for="(plan, index) in plans" :key="plan.id">
      <th>{{ index + 1 }}. {{ plan.name }}</th>
      <td>{{ plan.price }}</td>
      <td>
        <template js-for="(included, feature) in plan.features" :key="feature">
          <span js-if="included" class="feature">{{ feature }}</span>
        </template>
      </td>
    </tr>
  </table>
  <p><span js-for="n in stars" :key="n">★</span></p>
</template>
```

### Showing text and HTML

| Directive | Meaning |
| --- | --- |
| `js-show="expr"` | Adds `display: none` while the condition is false; the element stays in the page |
| `js-text="expr"` | The element's only child, as text |
| `js-html="expr"` | The element's content, as HTML, unescaped; only for HTML you trust |
| `js-pre` | A raw subtree: no interpolation, no directives, whitespace kept |

`js-text` and `js-html` replace the content, so an element with either one
and children of its own is `sfc.directive_with_children`. A `js-pre` element
is written after `<!-- prettier-ignore -->` (`sfc.js_pre_needs_prettier_ignore`
otherwise, with a fix), because Prettier would reformat what the element
shows as written.

```jsails path=ui/article-body.jsails
<script setup lang="ts">
defineProps<{ html: string; summary: string; expanded: boolean }>();
</script>

<template>
  <article>
    <p class="summary" js-text="summary"></p>
    <div js-show="expanded" js-html="html"></div>
    <!-- prettier-ignore -->
    <pre js-pre>Write {{ name }} to interpolate.</pre>
  </article>
</template>
```

### Components and slots

A capitalized tag is a component: a binding of the file (an import in
either script, or a local), or `sfc.unresolved_component`. A `.jsails` file
is imported by its path, `import Card from './card.jsails'`; a TSX component
the same way, by its compiled `.js` path.

A view, a layout or an island renders the content it is given with
`<slot>`. The default slot is the `children` prop, and a named slot is a prop
of its name. A scoped slot is a function prop, called with the attributes
of its `<slot>`. `defineSlots<S>()` types them. Without it, a slot is any
`ComponentChild`, and a scoped slot's props are untyped.

```jsails path=ui/data-list.jsails
<script lang="ts">
import type { ComponentChild } from 'jsails/view';

export interface Item {
  readonly id: number;
  readonly label: string;
}
</script>

<script setup lang="ts">
defineProps<{ items: readonly Item[] }>();
defineSlots<{
  header?: ComponentChild;
  children?: ComponentChild;
  row?: (props: { item: Item; index: number }) => ComponentChild;
}>();
</script>

<template>
  <section>
    <header><slot name="header">Items</slot></header>
    <ul>
      <template js-for="(item, index) in items" :key="item.id">
        <slot name="row" :item="item" :index="index"
          ><li>{{ item.label }}</li></slot
        >
      </template>
    </ul>
    <slot />
  </section>
</template>
```

A slot's content is the fallback that renders when nothing is passed. The
parent passes slots with `<template #name>`, takes a scoped slot's props with
`#name="{ … }"`, and anything outside a `<template #…>` is the default slot.
Mixing loose children with a `<template #default>` is
`sfc.mixed_default_slot`:

```jsails path=ui/users-panel.jsails
<script setup lang="ts">
import DataList from './data-list.jsails';

const users = [
  { id: 1, label: 'Ada' },
  { id: 2, label: 'Grace' },
];
</script>

<template>
  <DataList :items="users">
    <template #header>Users</template>
    <template #row="{ item, index }">
      <li :data-index="index">{{ item.label }}</li>
    </template>
    <p>{{ users.length }} users</p>
  </DataList>
</template>
```

A page has no children, so `<slot>` there is `sfc.slot_kind`. A `#name`
goes on a `<template>` directly inside a component tag
(`sfc.slot_outside_component` elsewhere).

`<component :is="expr">` renders a tag or a component chosen at render
time. The value's type must name one: a union of tag names
(`ordered ? 'ol' : 'ul'`) or a component, not any `string`, as for a
dynamic tag in TSX. Without `:is` it is `sfc.component_without_is`:

```jsails path=ui/steps.jsails
<script setup lang="ts">
defineProps<{ ordered: boolean; steps: readonly string[] }>();
</script>

<template>
  <component :is="ordered ? 'ol' : 'ul'" class="steps">
    <li js-for="step in steps" :key="step">{{ step }}</li>
  </component>
</template>
```

### Events

`@event` exists where code runs in the browser. In an island it is a DOM or
component event handler (see [Events](/docs/view#events)). In a live
component it triggers an action (see [Live components](#live-components)).
In a page, a layout or a view it is `sfc.event_without_client`: use an island
or a live action.

## Names

Every name in `<script setup>` and the template resolves in this order:

1. template locals: `js-for` aliases, slot props, and `$event` in a handler;
2. `<script setup>` bindings;
3. `<script>` bindings and imports;
4. the kind's names: `context` (the `RequestContext`) in a page, a layout,
   an error or not-found page; in a live component, `errors`, `values`,
   `context` and its `derived` names;
5. a fixed list of JavaScript built-ins: `Array`, `BigInt`, `Boolean`, `Date`,
   `Error`, `Infinity`, `Intl`, `JSON`, `Map`, `Math`, `NaN`, `Number`,
   `Object`, `Promise`, `RangeError`, `RegExp`, `Set`, `String`, `Symbol`,
   `TypeError`, `URL`, `URLSearchParams`, `decodeURIComponent`,
   `encodeURIComponent`, `globalThis`, `isFinite`, `isNaN`, `parseFloat`,
   `parseInt` and `undefined`.

Any other name is a prop (a page's `load` result, a layout's, view's or
island's `defineProps` type) or, in a live component, a state field. The list
of built-ins holds no browser global, so a prop called `name` or `status`
never binds to `window.name`; write `globalThis.x` to reach a global.

The compiler declares each such name once at the top of the generated
function (`const page = __props.page;`). So a typo is a TypeScript error
(TS2339) at the name's first use in the `.jsails` file, and narrowing
reaches closures: after `js-if="page"`, `page.title` checks inside a
`js-for` below it.

## Macros

Macros are compile-time calls. They are never imported
(`sfc.macro_import`), and each may be called once.

| Macro | Kinds | Meaning |
| --- | --- | --- |
| `defineProps<T>()`, `const { a, b = 1 } = defineProps<T>()` | layout, view, island | The props type; destructured names become locals, with their defaults |
| `defineSlots<S>()` | layout, view, island | The slot props: `children`, named slots, scoped slots as functions |
| `defineEmits<E>()` | island | The component events; `const emit = defineEmits<E>()` binds `emit` ([details](/docs/view#events)) |
| `defineLive({ … })` | live, in `<script>` | The component's definition ([below](#live-components)) |

A page has no props macro: its props are `PageProps<typeof load>`, the
awaited result of its `load` export.

## Pages

A page's `<script>` holds the page module's exports as a TSX page writes
them: `load`, `getStaticPaths`, `metadata` or `generateMetadata`, `route`,
`revalidate`, `cache`, `middleware` and the others of
[Page modules](/docs/routing#page-modules). `export const serverOnly =
true` marks a page that a static export must not render. The template reads
the `load` result's properties by name, and `context` is the request:

```jsails path=pages/blog/[slug].jsails
<script lang="ts">
import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import TagBadge from '../../ui/tag-badge.jsails';

interface Post {
  readonly slug: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly html: string;
}

const posts: readonly Post[] = [
  { slug: 'hello', title: 'Hello', tags: ['news'], html: '<p>First post.</p>' },
];

export function getStaticPaths(): { slug: string }[] {
  return posts.map((post) => ({ slug: post.slug }));
}

export function generateMetadata(context: RequestContext): PageMetadata {
  const post = posts.find((entry) => entry.slug === context.params['slug']);
  return { title: post?.title ?? 'Not found' };
}

export async function load(context: RequestContext): Promise<{ post: Post | null }> {
  return { post: posts.find((entry) => entry.slug === context.params['slug']) ?? null };
}
</script>

<script setup lang="ts">
const tagCount = post?.tags.length ?? 0;
</script>

<template>
  <article js-if="post">
    <h1>{{ post.title }}</h1>
    <p js-if="tagCount > 0">
      <TagBadge js-for="tag of post.tags" :key="tag" :tag="tag" />
    </p>
    <div js-html="post.html"></div>
  </article>
  <p js-else>No post at {{ context.url.pathname }}.</p>
</template>
```

`<script setup>` may `await` in a page, a layout, an error and a not-found
page, because the renderer awaits those functions. Prefer `load` for a
page's data: it is what `revalidate` caches and what a static export runs
for each path.

A layout wraps the pages of its directory. It renders the page with
`<slot />` and may declare props of its own:

```jsails path=pages/layout.jsails
<script lang="ts">
async function navigation(): Promise<readonly { href: string; label: string }[]> {
  return [
    { href: '/', label: 'Home' },
    { href: '/blog', label: 'Blog' },
  ];
}
</script>

<script setup lang="ts">
const links = await navigation();
</script>

<template>
  <div class="layout">
    <nav>
      <a js-for="link in links" :key="link.href" :href="link.href">{{ link.label }}</a>
    </nav>
    <main><slot /></main>
  </div>
</template>
```

The error page receives `error`, with its `status` and its public
`message`. The not-found page is a page, with `load` if it needs one:

```jsails path=pages/error.jsails
<template>
  <h1>{{ error.status }}</h1>
  <p>{{ error.message }}</p>
</template>
```

```jsails path=pages/not-found.jsails
<template>
  <h1>Not found</h1>
  <p>Nothing lives at {{ context.url.pathname }}.</p>
</template>
```

## Live components

A file under `components/` is a live component: server state, actions, and a
template that re-renders on the server when an action runs (see
[Server Components](/docs/server-components)). `defineLive({ … })` in
`<script>` is its definition, with the keys `defineLiveComponent` takes:
`stateSchema`, `initialState`, `writableKeys`, `authorize`, `actions`,
`derived` and the others. The compiler gives it the component's id (its path)
and its `render` (the template) and `staticFallback` (`<template static>`),
so those three keys are its own. The template's free names are state fields,
typed by `stateSchema`.

```jsails path=components/task-list.jsails
<script lang="ts">
/** A task list: server state, two actions, and a static-export fallback. */
import { serverAction } from 'jsails/server-components';
import { z } from 'zod';

defineLive({
  stateSchema: z
    .object({
      title: z.string().max(120),
      tasks: z.array(z.string().min(1).max(120)).max(50),
    })
    .strict(),
  initialState: () => ({ title: '', tasks: [] }),
  writableKeys: ['title'],
  authorize: () => true,
  actions: {
    add: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') return;
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
  <section class="tasks">
    <form @submit="add">
      <input js-model.trim="title" placeholder="New task" />
      <button js-loading>Add</button>
    </form>
    <p js-if="errors.title" class="error">{{ errors.title }}</p>
    <ul js-if="tasks.length > 0">
      <li js-for="(task, index) in tasks" :key="task">
        {{ task }}
        <button @click="remove({ index })" js-confirm="'Remove it?'">Remove</button>
      </li>
    </ul>
    <p js-else>No tasks yet.</p>
    <p>{{ count }} {{ count === 1 ? 'task' : 'tasks' }}</p>
  </section>
</template>

<template static>
  <p>The task list works when the site is served.</p>
</template>
```

In this template:

- `tasks` and `title` are state fields;
- `count` is a `derived` value;
- `errors` holds the field errors of the last action;
- `add` and `remove` name actions.

A name that is not one is a type error at that attribute: `js-model="titel"`
or `@submit="ad"`.

| Construct | Meaning |
| --- | --- |
| `@submit="add"` | On a `<form>`: submitting it runs the action `add` |
| `@click="add"`, `@click="remove({ index })"` | Clicking runs the action, with the argument when one is given |
| `@intersect="more"` | Runs the action when the element enters the viewport, once per render |
| `js-model="title"` | Binds a control to the writable state field `title`; `.lazy`, `.trim`, `.number` |
| `js-confirm="'Sure?'"` | Asks before the trigger runs |
| `js-loading` | Marks the element while an action runs |
| `js-poll="{ intervalMs: 5000 }"` | Refreshes the component on an interval |
| `js-sort="field"`, `js-ref="name"`, `js-ignore` | The `sort`, `ref` and `ignore` render tools |

A live trigger takes `.prevent`, `.once` and `.capture`, and `@intersect`
only `.prevent` (`sfc.live_event_modifier`). Any other event is
`sfc.live_event`: a live component reacts to clicks, submits and
intersections, and other events belong to an island. A handler that is not
an action name, or one action call, is `sfc.live_handler_not_action`.
Directive values that name a field, an action or a ref are names. Every other
value is an expression, so a literal string is written in quotes, as in
`js-confirm="'Sure?'"`.

`<template static>` is what a static export renders: the component cannot
sign state or run actions there. It renders without state, so it may name
`context`, imports and nothing else (`sfc.static_unbound`). Without it,
`staticRender: 'initial'` in `defineLive` renders the template inertly from
the initial state, and with neither, the export fails, as for a TSX
component (see [Static export](/docs/server-components#static-export)).

A page, a layout or the not-found page mounts a live component by its tag.
The mount is awaited before the page renders, once per branch it stands in:

```jsails path=pages/tasks.jsails
<script setup lang="ts">
import TaskList from '../components/task-list.jsails';
</script>

<template>
  <h1>Tasks</h1>
  <TaskList />
</template>
```

A live tag takes no attributes but a `js-if` chain, and no children
(`sfc.live_props_unsupported`): the component owns its state. A mount cannot
depend on a value computed per item or per slot call, so a live tag inside a
`js-for`, a scoped slot or a `<slot>` fallback is `sfc.live_tag_position`.
A view, an island, an error page and another live component refuse it
(`sfc.live_outside_page`). A component that needs data from the request reads
it in its own `initialState(context)`.

## Islands, styles and folders

These parts of the format are documented with the runtime they compile to:

- An [island](/docs/view#islands) is a file under `islands/`. It may call
  hooks, bind controls with `js-model` and declare events with
  `defineEmits`. A page, a layout or a view [mounts it by its
  tag](/docs/view#mounting-an-island), and its props cross to the browser as
  JSON, checked at the tag.
- [Styles](/docs/view#styles): a `<style>` block is global CSS. A
  `<style scoped>` block is wrapped in a native `@scope` rule that ends at
  any other component's root.
- [One file or a folder](/docs/view#one-file-or-a-folder): a component may be
  a folder named after it, with one file per block. `jsails convert` turns
  one form into the other.

## Diagnostics and tooling

Every problem the compiler finds has a code (`sfc.*`) and points at the
exact range of the `.jsails` file, and every message names the construct,
never your text. Many come with a fix: the old component format's syntax is
refused with one each.

| Old spelling | Write |
| --- | --- |
| `{expr}` in text, `attr={expr}` | `{{ expr }}`, `:attr="expr"` |
| `js-bind:x`, `js-on:x` | `:x`, `@x` |
| `js-submit`, `js-call`, `js-intersect` | `@submit`, `@click`, `@intersect` |
| `js-visible`, `js-content` | `js-show`, `js-text` |
| `<component js-is>` | `<component :is>` |
| config exports (`export const stateSchema`) | `defineLive({ … })` |
| `<server>` | the file `x.server.ts` |

TypeScript checks what the compiler emits. Each `.jsails` file gets a
generated TypeScript twin under `.jsails/sfc/`, and TypeScript's errors are
mapped back to the `.jsails` line and column. An error in code the compiler
generated for a template node is reported at that node's tag. These docs are
checked that way. `jsails typecheck` and the editor support follow with the
build.

Prettier formats `.jsails` files with its `vue` parser, with no plugin. Map
the extension in your Prettier config:

```json
{ "overrides": [{ "files": "*.jsails", "options": { "parser": "vue" } }] }
```

The template's whitespace rule is Prettier's, so a formatted file renders
the same HTML. Markdown rendered by [`@jsails/content`](/docs/content#code-fences)
highlights ` ```jsails ` fences.

## When to use TSX

`.jsails` is for markup. Keep a component in TSX when a template would only
wrap code:

- **Views built from runtime data shapes.** The admin's resource
  renderers dispatch on field descriptors and assemble attribute objects and
  child lists in code, so a template would be a call to a helper per element.
- **Components that own the DOM.** The rich-text editor mounts ProseMirror on
  an element, and the docs search island imports its index on demand and
  wires debounced effects and keyboard handling. Their markup is one
  element; the rest is imperative code.
- **Anything that is not a view.** Routes, API modules, models, jobs,
  services and the client entry are TypeScript.
- **Code that must not depend on the view layer.** The framework's
  last-resort error page renders when anything else may have failed.

Both forms interoperate. A TSX module imports a `.jsails` component by its
path (`import Card from './card.jsails'`), and a `.jsails` file imports a
TSX component like any module and uses it as a tag.
