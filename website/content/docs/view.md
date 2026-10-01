---
title: View Runtime
order: 37
section: Reference
---

# View Runtime

`jsails/view` is the small runtime that compiled `.jsails` templates call, and
the types their generated code names. It is browser-safe, so the same helpers
render a page on the server and an island in the browser. The template helpers
import nothing; the island seam (`defineIsland`, `<Island>`) renders with
Preact and reports `island.*` errors, both of which every island bundle loads
already. TSX that wants the template rules for `class`, `style`, loops or
islands can import them too.

| Export | Kind | What it does |
| --- | --- | --- |
| `normalizeClass` | function | A `:class` value (string, record, array) to a class list |
| `normalizeStyle` | function | A `:style` value (string, record, array) to a style object |
| `bindAttributes` | function | A `js-bind` spread without raw-HTML attributes, merged with an element's own `class` and `style` |
| `renderList` | function | The loop of `js-for`: numbers, iterables and records |
| `PageProps<typeof load>` | type | The props a page receives: what its `load` resolves to, with a `reply.props` unwrapped and a redirect or not-found reply left out |
| `ComponentChild` | type | Anything a component may render, and a slot's type |
| `ClassValue`, `StyleValue`, `StyleObject`, `SpreadAttributes`, `BoundAttributes` | types | The shapes the helpers accept and return |
| `defineIsland` | function | Names a component as the island the browser hydrates under an id |
| `Island` | component | Mounts a defined island: its marker element, JSON props and server render |
| `IslandProps<P>` | type | An island's props narrowed to what crosses to the browser as JSON |
| `DefinedIsland<P>`, `IslandMount<P>` | types | A defined island, and the props of `<Island>` |
| `bindControl` | function | What an island's `js-model` compiles to: a control's value and handler for a signal |
| `ControlTarget`, `ControlKind`, `ControlOptions`, `ControlEvent`, `ValueControlAttributes`, `CheckboxControlAttributes`, `RadioControlAttributes` | types | The shapes `bindControl` accepts and returns |
| `emitter` | function | What an island's `defineEmits` compiles to: `emit(name, …args)` over the handler props |
| `Emit<E>`, `EmitMap<E>`, `EmitProps<E>` | types | An island's events, its `emit` function, and the `on…` props a parent sets |
| `IslandErrors` | error registry | The `island.*` errors |

## Which `.jsails` files are views

A file's kind comes from its path: every `.jsails` file outside `pages/`,
`components/`, `islands/` and `mail/` is a view, a plain server-rendered
component named after its file (`ui/tag-badge.jsails` is `TagBadge`). Its
props are declared with `defineProps<T>()`, and a name the template uses that
nothing declares is a prop. [Components](/docs/components) is the reference
for the format: the kinds, blocks, template syntax, the scope rule and the
macros.

## One file or a folder

A component is one file, or a folder named after it whose files hold the
blocks one each:

```text
pages/about.jsails            pages/about/about.jsails       <template>, <template static>, <script setup>
                              pages/about/about.ts           the <script>
                              pages/about/about.css          the <style>
                              pages/about/about.scoped.css   the <style scoped>
pages/about.server.ts         pages/about/about.server.ts    the server module
```

Both layouts are the same component: the folder is named by its component
path (`pages/about.jsails`), which decides its kind, route and id exactly as
the file's path does, and importers write `./about.jsails` either way. Both
compile to the same module byte for byte, except that an import of the
server module names it where it stands (`./about/about.server.js` from the
folder); a diagnostic points at the file that holds the block. A `<script>` or
`<style>` written in a folder's `about.jsails` is `sfc.folder_block`, and a
file beside a folder of the same name (`pages/about.jsails` and
`pages/about/`) is `sfc.layout_conflict`: keep one.

In the folder, `about.ts` is a TypeScript module of the project. It uses names
it does not import (the catalog names the component uses and, in a live
component, `defineLive`), which its script companion declares: the sidecar
`.jsails/sfc/pages/about.jsails.script.ts`, written with the component's other
sidecars under `.jsails/sfc`, which types `defineLive` by the component's
state so that `serverAction({ run(state) {…} })` is typed as in the single
file. A project types folder scripts when it syncs those sidecars and its
tsconfig includes `.jsails/sfc/**/*.script.ts`. The app build does not compile
`.jsails` components or write their sidecars yet, and no starter includes the
companions, so in a generated app `about.ts` would be compiled as a module of
its own; that is why a folder is only made in a project that has
`.jsails/sfc` (below). An editor checking `about.ts` cannot see the template,
so under `noUnusedLocals` it marks a binding that only the template reads as
unused; the component's own check, whose diagnostics are mapped back to your
files, does not. Relative paths that are not import specifiers (a computed
`import()`, `import.meta.url`, a CSS `url()`) resolve from where the compiled
module stands, the component path, in both layouts.

`jsails convert pages/about.jsails` turns the file into the folder, and
`jsails convert pages/about` turns it back. Every block body moves byte for
byte (so Prettier-formatted code stays formatted), the relative imports of
the moved TypeScript are rewritten to name the same files, and the server
module `about.server.ts` moves with the component. A folder whose `about.ts`
holds `</script`, or whose style file holds `</style` (in a comment or a
string), is refused as `convert.end_tag`: in one file that text would end the
block. `jsails make:page about --mfc` and
`jsails make:server-component task-box --mfc` write a new component as a
folder. Making a folder, by either command, needs a project that syncs
`.jsails` sidecars; elsewhere it is refused (`convert.no_sidecars`,
`make.no_sidecars`). Turning a folder back into a file works in any project.

## Classes and styles

`normalizeClass` joins every truthy entry in order and returns `undefined`
when no class is named, so the element renders no `class` attribute:

```ts
import { normalizeClass } from 'jsails/view';

const active = true;
const className = normalizeClass(['card', { active, hidden: false }, ['wide']]);
// 'card active wide'
void className;
```

`normalizeStyle` parses declaration strings (a `;` inside parentheses, as in a
`url(data:…)`, or inside quotes stays in its declaration), lets later entries
win, and removes a property set to `null`, `undefined` or `false`:

```ts
import { normalizeStyle } from 'jsails/view';

const style = normalizeStyle(['color: red; margin: 0', { color: 'blue', margin: null }]);
// { color: 'blue' }
void style;
```

A template's static `class`/`style` merges with the bound one, and `js-show`
adds `display: none` last while its condition is false (while it holds, the
element keeps the `display` its own style sets). `js-bind` spreads an object
onto the element through `bindAttributes`, which drops `dangerouslySetInnerHTML`
and `innerHTML`, so an attribute object that comes from data cannot insert
markup: `js-html` is a template's one trusted-HTML door, and the compiler
rejects those two names as attributes. When the element has a `class` or
`style` of its own, the spread's `class` and `style` merge after the element's
instead of replacing them:

```ts
import { bindAttributes } from 'jsails/view';

const fromData: Record<string, unknown> = { id: 'card', class: 'wide', innerHTML: '<b>x</b>' };
const attributes = bindAttributes(fromData, { class: 'card' });
// { id: 'card', class: 'card wide' }
void attributes;
```

## Styles

A component's `<style>` blocks hold its CSS. A `<style>` block is global CSS,
copied as written. A `<style scoped>` block applies only to the elements the
component's template renders:

```jsails path=ui/note-card.jsails
<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <article class="card">
    <h2 class="title">{{ title }}</h2>
    <slot />
  </article>
</template>

<style scoped>
.card {
  padding: 1rem;
}

.card > .title {
  margin: 0;
}
</style>
```

The compiler collects every component's CSS into one stylesheet, which
starts with `ISLAND_STYLE`; then come the components in the order of
their paths, and within each its blocks in source order. That order does not
depend on the order the files were built in, so two builds give the same
bytes. The app build does not compile `.jsails` components yet, so nothing
serves that stylesheet yet.

A scoped block is wrapped in a native `@scope` rule, and no selector is
rewritten, so `.card > .title` means what it means in any stylesheet. Every
compiled template writes `data-s="<id>"` on its outermost elements, and also
on the outermost elements of the content it passes into another component's
slots. The id is eight characters derived from the component's path
(`ui/note-card.jsails`; a folder component uses the same path). The server,
the browser and a static export therefore write the same markers, on every
platform. With these markers a scoped rule reaches:

- the elements its own template renders, the root included;
- the content it passes into another component's slots, which stays its own;
- the elements a TSX component renders inside them, which carry no marker.

It stops at any element marked by another component: the root of a child
`.jsails` component, or content another component passed in. So a parent's
`.title` rule never reaches the `.title` inside a child component. Native
`@scope` needs Chrome 118, Safari 17.4 or Firefox 146.

`data-s` belongs to the compiler: writing it on a tag, static or bound, is
`sfc.reserved_attribute`. An outermost `<component :is>` carries the marker
when it renders a tag, but not when it renders a component, which marks its
own elements. A layout whose root is `<html>` scopes everything inside it,
but no scoped rule matches `<html>` itself: style `html` from a `<style>`
block.

All blocks share one stylesheet, so a block that would break the blocks
around it is refused when it compiles:

- `sfc.style_unbalanced`: an unclosed comment, string, `url(` or bracket, or
  a closing bracket that matches nothing. One `}` too many would end the
  scope early and leak the rest of the block into the whole page.
- `sfc.style_incomplete`: text that is not a complete rule where rules are
  expected: a selector with no `{ }` block, an at-rule with neither `;` nor
  a block (`@layer base`), or, in a `<style>` block, a declaration outside
  any rule or a `;` that ends nothing. Left at the end of a block, such text
  would become part of the selector of the next block's first rule, which
  would then match other elements or be dropped.
- `sfc.style_at_rule`: `@import`, `@charset` and `@namespace`, which a
  stylesheet ignores after its first rule. Import a stylesheet from
  `<script>` instead.
- `sfc.scoped_global_rule`, in a scoped block only: `@keyframes`,
  `@font-face`, `@property`, `@counter-style`, `@font-feature-values`,
  `@font-palette-values`, `@color-profile`, `@function`, `@page`,
  `@position-try` and `@view-transition`. Each defines a name for the whole
  document or applies to the whole document, which no scope can limit.
  Write them in a `<style>` block.
- `sfc.scope_selector`, in a scoped block only: `:scope`, and `&` outside a
  rule (`& { … }`, `:is(&)`, also inside `@media` or `@layer`). Under the
  wrapper both name the element the component is mounted in, not its root,
  so select the root by its class or tag. `&` inside a rule (`.card { &:hover
  { … } }`) means that rule's elements and is fine.
- `sfc.scope_declaration`, in a scoped block only: a declaration outside a
  rule (`color: blue;`, also inside `@media` or `@layer`). CSS nesting
  applies it to the same element as `:scope`, the one the component is
  mounted in, so it would style another component's element; put it in a
  rule that selects the root.

The collected CSS is not put in a cascade layer, because layer order is the
app's to decide. Unlayered rules beat layered ones whatever their
specificity, so a Tailwind utility class (in `@layer utilities`) cannot
override a property that a component's rule sets. Wrap the rules in
`@layer components { … }` inside the block when utilities should win.

## Loops

`renderList` is what `js-for` compiles to. `n in 10` counts from 1 to 10, an
array or any iterable passes each item and its index, and a plain object passes
each value, key and index in `Object.keys` order. `null` and `undefined` render
nothing:

```ts
import { renderList } from 'jsails/view';

const rows = renderList({ a: 1, b: 2 }, (value, key, index) => `${index}. ${key}=${value}`);
// ['0. a=1', '1. b=2']
void rows;
```

## Page props

`PageProps<typeof load>` is the type of the props a page's template sees,
derived from its `load` export: the props `load` resolves to. A `reply.props`
(see [Page replies](/docs/routing#page-replies)) is unwrapped to the props it
renders with, and a `reply.redirect` or `reply.notFound()` renders nothing,
so it adds nothing to the type. Use it to type a TSX page the same way:

```ts
import type { RequestContext } from 'jsails';
import { reply } from 'jsails/pages';
import type { PageProps } from 'jsails/view';

async function load(context: RequestContext) {
  if (context.session === null) return reply.redirect('/login');
  if (context.params['slug'] === 'draft') return reply.notFound();
  return reply.props({ title: 'Home' }, { status: 203 });
}

type HomeProps = PageProps<typeof load>; // { title: string }
const props: HomeProps = { title: 'Home' };
void props;
```

## Islands

An island is a component that renders on the server and then runs in the
browser, hydrated from the server's markup. A `.jsails` file under `islands/`
is one:

```jsails path=islands/counter.jsails
<script setup lang="ts">
import { useSignal } from '@preact/signals';

const { start, label } = defineProps<{ start: number; label: string }>();
const emit = defineEmits<{ change: [count: number] }>();
const count = useSignal(start);

function add(): void {
  count.value += 1;
  emit('change', count.value);
}
</script>

<template>
  <div class="counter">
    <button type="button" @click="add">{{ label }}</button>
    <output>{{ count.value }}</output>
    <input type="number" js-model="count" />
    <button type="button" @click.prevent="count.value = start">Reset</button>
  </div>
</template>
```

It compiles to a function component named after the file (`Counter`), and
its default export is `defineIsland('counter', Counter)`. The id is the path
under `islands/` without the extension (`islands/admin/user-card.jsails` is
`admin/user-card`), and it lives on the component itself, so the server
markup and the browser registry cannot name the island differently. Every
folder and file name under `islands/` is therefore in kebab case, and an id
`defineIsland` refuses is a compile error too: `islands/LoadMore.jsails`,
`islands/(marketing)/cta.jsails` or `islands/café/cart.jsails` is
`sfc.invalid_island_id`, reported at the template. Two island files can
then never share an id, which the browser registry would refuse. An
island may call hooks and render `<slot>`s; it renders synchronously, so
`await` in `<script setup>` is `sfc.await_in_sync_kind`.

### Events

In an island, `@event` on an HTML element sets Preact's typed handler prop of
that DOM event (`@click` → `onClick`, `@keydown` → `onKeyDown`, `@dblclick`
→ `onDblClick`), and `.capture` its capture variant (`onKeyDownCapture`), so
`$event` is typed by Preact. An event Preact has no handler prop for is
`sfc.unknown_event`. The handler is written as in Vue: a name (`add`) or a
function expression is the handler itself; a member path (`store.add`,
`form.reset`) is called through its object, so a method keeps its `this`;
any other expression or statement list runs with `$event` in scope
(`@input="search($event)"`, `@blur="touched = true"`). A handler is typed as
the prop it sets: a name or a member path must take the event or nothing,
with or without modifiers, and a handler of another type is a TypeScript
error at the handler.

The modifiers are `.once` (the handler runs once per element), `.self`
(only when the event's target is the element itself), `.prevent` and `.stop`:
`.once` is checked first, then the others run in the order written.
`.passive` is `sfc.event_modifier`, because Preact registers its own
listeners.

On a component, `@event` sets the component event's prop: `on` and the event
camel-cased (`@change` → `onChange`, `@update-value` → `onUpdateValue`),
without modifiers. An island declares its events with
`defineEmits<{ name: [args] }>()`: the parent's `on…` props are added to its
props, and `const emit = defineEmits<…>()` binds `emit(name, ...args)`, which
calls the parent's handler when it set one. A wrong event name or argument is
a TypeScript error at the `emit` call.

### `js-model`

`js-model="name"` binds a form control to a signal (any object with a
writable `value`), through `bindControl`. The binding comes from the control:

| Control | The signal holds | Modifiers |
| --- | --- | --- |
| `<input>` (text-like types), `<textarea>` | the text | `.lazy`, `.trim`, `.number` |
| `<input type="number">`, `<input type="range">` | a finite number, or `''` while empty | `.lazy` |
| `<input type="checkbox">` | a boolean | none |
| `<input type="radio" value="…">` | the value of the checked radio | none |
| `<select>` | the selected option's value | `.number` |

`.trim` stores the trimmed text and `.number` a finite number when the text is
one (the text otherwise), as in a live component. While the user types, the
control keeps the raw text as long as it still means the signal's value, so a
trailing space or a `1.` is not rewritten under the cursor; leaving the
control writes the normalised value back. `.lazy` writes the signal on
`change` only. The control's type must be written statically, and a
`value` or `checked` beside the model, a `multiple` select, a `file` or
button input, or a modifier the control does not take is `sfc.model_target`.
A signal of the wrong type is a TypeScript error at its name.

An `@input` or `@change` on the bound control runs after the binding's own
handler, wherever it is written: `<input js-model="query" @input="search">`
writes `query` and then calls `search`, which already reads the new value,
and a checkbox's `@change` sees the toggled signal. The handler goes to
`bindControl`'s `handlers` option, typed as the element's own prop, so
`$event.currentTarget` is the `<input>`; its modifiers apply to it alone.

```ts
import { bindControl } from 'jsails/view';

const title = { value: '' };
const attributes = bindControl(title, 'text', { trim: true });
attributes.onInput?.({ currentTarget: { value: ' Hello ' } });
// title.value === 'Hello'
```

### Mounting an island

A page, a layout, an error or not-found page, or a view mounts an island by
its tag. Its attributes are the island's props (`js-bind` spreads an object
of them), `:key` keys it, and `js-if`/`js-for` work as on any tag:

```jsails path=pages/index.jsails
<script setup lang="ts">
import Counter from '../islands/counter.jsails';

const items = [
  { id: 'likes', name: 'Likes', start: 3 },
  { id: 'shares', name: 'Shares', start: 0 },
];
</script>

<template>
  <Counter :start="0" label="Clicks" />
  <Counter js-for="item in items" :key="item.id" :start="item.start" :label="item.name" />
</template>
```

The tag compiles to `<Island component={Counter} props={{ start: 0, label:
'Clicks' }} />`. The props cross to the browser as JSON, so they are checked
against `IslandProps` of the island's props, each narrowed to what survives
JSON: a function, a `Date`, a `Map` or a class instance is a TypeScript error
at the attribute that passes it, and a missing prop is one at the tag.
An island's tag takes no children, no `@event` (handle the event inside the
island) and no other directive; `js-hydrate="load"` is the default, and
`idle` and `visible` arrive with the client runtime (`sfc.not_lowered`
until then). Inside another island, an island's tag is a plain component,
hydrated as part of that island; in a live component it is
`sfc.island_position`.

`<Island>` renders a marker element around the island's server render:

```html
<jsails-island data-jsails-island="counter" data-jsails-props="{&quot;start&quot;:0,&quot;label&quot;:&quot;Clicks&quot;}">…</jsails-island>
```

The element is phrasing content, valid inside a paragraph or a button.
`ISLAND_STYLE` (`jsails/view`), the rule `jsails-island{display:contents}`,
lays it out so the island's own root takes part in the parent's layout: in a
flex row or a grid, the island's root is the item, not the marker. It is a
stylesheet rule rather than a `style` attribute on each marker because a
Content-Security-Policy with a nonce blocks every style attribute. The
stylesheet collected from `.jsails` styles starts with it (see
[Styles](#styles)); until the app build serves that stylesheet, a layout
includes the rule once, in its own stylesheet or in a `<style>` carrying the
request's nonce:

```tsx
import type { RequestContext } from 'jsails';
import { ISLAND_STYLE, type ComponentChild } from 'jsails/view';

export function Head({ context }: { context: RequestContext }): ComponentChild {
  return <style nonce={context.cspNonce}>{ISLAND_STYLE}</style>;
}
```

Without it the marker is an inline element, which leaves normal flow as it
is but makes the marker the item of a flex or grid parent. The
server encodes the props, decodes them with the browser's decoder, and
renders the island from that copy, so the first paint is exactly what the
browser's hydrating render produces; props the browser would refuse fail the
server render instead. A view that mounts an island and itself renders
inside an island renders the island inline, without a second marker.

In TSX, name the island with `defineIsland` and mount it with `<Island>`:

```tsx
import { defineIsland, Island } from 'jsails/view';

export const Counter = defineIsland('counter', ({ start }: { start: number }) => (
  <button type="button">{start}</button>
));

export function Toolbar() {
  return <Island component={Counter} props={{ start: 0 }} />;
}
```

The browser registers defined islands by their ids with
`startClient({ islands: [Counter] })` (see [Client & Islands](/docs/client)).
The app build does not compile `.jsails` islands or generate that list yet.

### Island errors

| Code | When |
| --- | --- |
| `island.invalid_id` | An id that is not a path of letters, digits and `. _ $ -` segments, longer than 200 characters, or an `Object.prototype` member |
| `island.redefined` | A component already defined as an island under another id |
| `island.not_defined` | `<Island>` given a component that is not a defined island |
| `island.props_unserializable` | Props `JSON.stringify` cannot encode (a cycle, a `bigint`) |
| `island.props_too_large` | Props longer than 65 536 characters, deeper than 32 levels or with more than 1 000 keys |
| `island.props_invalid` | Props that are not a plain object, or hold a `__proto__`, `constructor` or `prototype` key |
| `island.props_unparseable` | A `data-jsails-props` value that is not JSON (in the browser) |
