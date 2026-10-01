/**
 * The format corpus of `.jsails` files (docs/design/sfc.md §5 and §10): one
 * small app written deliberately unformatted, which `sfc-format.test.mjs`
 * formats with Prettier through the repository's configuration.
 *
 * Every file is a valid component. Its templates hold the hazards sfc.md §5.1
 * lists: every whitespace row (inline siblings on an overflowing line, blocks
 * separated by a space, text against block siblings with no whitespace, edge
 * whitespace of block, inline-block and inline parents), `<pre>` and
 * `<textarea>`, `js-pre` behind `<!-- prettier-ignore -->` holding `{{a+b}}`,
 * `<template static>`, `<template js-for>` and slot templates, void elements,
 * one-line blocks, entities and literal `{`, `}` and `>`. The text is kept in
 * string literals because `npm run format` would rewrite committed `.jsails`
 * files.
 *
 * Unless a file sets `reformatsCode`, its scripts and expressions are already
 * in Prettier's style and only the markup around them is messy, so its shadow
 * TSX must survive formatting byte for byte. A file with `reformatsCode` has
 * code Prettier rewrites. The static `class`, `style`, `srcset` and `allow`
 * values Prettier reprints (`ui/printed-attributes.jsails`) need no flag: the
 * compiler writes them in a canonical form (docs/design/sfc.md §5.2), so they
 * survive byte for byte too.
 *
 * A file whose lowering has not landed sets `pending` to the lowering it
 * waits for, and lowers to exactly that lowering's `sfc.not_lowered`:
 * `'kind'` (its kind compiles to something not lowered yet; the diagnostic
 * sits at offset 0). Each render case of a lowered file renders
 * the default export: with `props`, or else with the module's
 * `load(context)`, or `{}`; an island renders as a component, because its
 * hooks need one. A live component (a `components/` file) renders
 * through the server-components runtime instead: as a page serves it, its
 * per-instance attributes masked, or, with `static`, as a static export
 * writes it. `contains` names markup the HTML must hold, with the scope
 * marker of an outermost element (`data-s`) spelled as the compiler writes it.
 */

/** The TypeScript modules the corpus imports through its catalog. */
export const FORMAT_MODULES = Object.freeze([
  {
    path: 'shared/posts.ts',
    source: `export interface Post {
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export const posts: readonly Post[] = [
  { slug: 'hello', title: 'Hello & welcome', date: '2026-01-02', body: '<p>First</p>', tags: ['intro', 'news'] },
  { slug: 'again', title: 'Again', date: '2026-02-03', body: '<p>Second</p>', tags: [] },
];

export function findPost(slug: string | undefined): Post | undefined {
  return posts.find((post) => post.slug === slug);
}
`,
  },
  {
    path: 'shared/format-date.ts',
    source: `export function formatDate(date: string): string {
  return date.split('-').reverse().join('/');
}
`,
  },
]);

/** What the corpus's free names and component tags resolve to. */
export const FORMAT_CATALOG = Object.freeze({
  posts: { path: 'shared/posts.ts', export: 'posts' },
  findPost: { path: 'shared/posts.ts', export: 'findPost' },
  formatDate: { path: 'shared/format-date.ts', export: 'formatDate' },
  Frame: { path: 'ui/frame.jsails', export: 'default' },
  TagBadge: { path: 'ui/tag-badge.jsails', export: 'default' },
  Card: { path: 'ui/card.jsails', export: 'default' },
  PostNotFound: { path: 'ui/post-not-found.jsails', export: 'default' },
  serverAction: { package: 'jsails/server-components', export: 'serverAction' },
  useSignal: { package: '@preact/signals', export: 'useSignal' },
});

const context = (pathname, params = {}) => ({ pathname, params });

/** The `.jsails` files of the corpus. */
export const FORMAT_CORPUS = Object.freeze([
  {
    path: 'pages/blog/[slug].jsails',
    source: `<script lang="ts">
/** A post page: one per slug, with the next post and a reading time. */
import type { RequestContext } from 'jsails';
import type { Post } from '../../shared/posts.js';

interface Neighbour {
  readonly slug: string;
  readonly title: string;
}

export function getStaticPaths(): { slug: string }[] {
  return posts.map((post) => ({ slug: post.slug }));
}

export function load(context: RequestContext): {
  page: Post | null;
  next?: Neighbour;
  minutes: number;
} {
  const page = findPost(context.params['slug']) ?? null;
  if (page === null) return { page, minutes: 0 };
  const after = posts[posts.indexOf(page) + 1];
  return {
    page,
    ...(after === undefined ? {} : { next: { slug: after.slug, title: after.title } }),
    minutes: Math.max(1, Math.round(page.body.length / 200)),
  };
}
</script>

<script setup lang="ts">
const meta = page === null ? '' : [formatDate(page.date), \`\${minutes} min read\`].join(' · ');
</script>

<template>
  <Frame :title="page?.title ?? 'Not found'">
      <article js-if="page"   class="post prose max-w-2xl"   :class="{ long: minutes > 5 }"><header class="mb-10"><h1 class="display max-w-2xl text-4xl sm:text-5xl">{{ page.title }}</h1>
        <p class="tabular mt-5 text-xs text-base-content/45">{{ meta }}</p>
      <ul js-if="page.tags.length > 0" class="mt-4 flex flex-wrap gap-x-4 gap-y-1"><li js-for="tag of page.tags" :key="tag"><TagBadge :tag="tag" :count="page.tags.length" /></li></ul>
        <hr class="rule mt-8"></header>
      <div js-html="page.body"></div>
        <nav js-if="next" class="mt-16 grid gap-4 border-t pt-8 sm:grid-cols-2" aria-label="Post navigation"><a class="group rounded-box border p-5" :href="\`/blog/\${next.slug}\`"><span class="eyebrow">Next &rarr;</span>
            <span class="mt-2 block font-serif text-lg">{{ next.title }}</span></a></nav>
      <span js-else>Last post</span>
    </article>
  <PostNotFound js-else :path="context.url.pathname" />
  </Frame>
</template>
`,
    renders: [
      {
        context: context('/blog/hello', { slug: 'hello' }),
        contains: ['<h1 class="display max-w-2xl text-4xl sm:text-5xl">Hello &amp; welcome</h1>'],
      },
      {
        context: context('/blog/again', { slug: 'again' }),
        contains: ['<span>Last post</span>'],
      },
      {
        context: context('/blog/missing', { slug: 'missing' }),
        contains: ['/blog/missing'],
      },
    ],
  },
  {
    path: 'pages/index.jsails',
    source: `<!-- The home page: literal text, entities, and whitespace-keeping elements. -->
<template>
<main>
          <h1>Welcome</h1>
  <p>Braces { and } and a > are text,    &amp; entities decode: &lt;tag&gt; &copy; &#65;&#x42;.</p>
  <pre>  keep
      this   exactly
  </pre>
  <textarea name="note">  also
   kept  </textarea>
      <ol><li js-for="n in 3" :key="n">Item {{ n }}</li></ol>
</main>
</template>
`,
    renders: [{ contains: ['<pre>  keep\n      this   exactly\n  </pre>', 'Item 3'] }],
  },
  {
    path: 'pages/layout.jsails',
    reformatsCode: true,
    source: `<script lang="ts">/** The root layout: awaits its navigation, written as one-line blocks. */
async function navigation(): Promise<readonly { href: string; label: string }[]> { return [{ href: '/', label: 'Home' }, { href: '/blog', label: 'Blog' }]; }</script>
<script setup lang="ts">const links = await navigation();</script>
<template><div class="layout"><nav><a js-for="(link, index) in links" :key="link.href" :href="link.href" :data-index="index">{{ link.label }}</a></nav><slot /></div></template>
`,
    renders: [{ props: { children: 'PAGE BODY' }, contains: ['data-index="1"', 'PAGE BODY'] }],
  },
  {
    path: 'pages/error.jsails',
    source: `<!-- The error boundary of every page. -->
<template>
  <section class="error" :data-status="error.status">
    <h1 js-if="error.status === 404">Not found</h1>
        <h1 js-else-if="error.status >= 500">Server error</h1>


    <h1 js-else>Error {{ error.status }}</h1>
    <p>  {{ error.message }}  </p>
  </section>
</template>
`,
    renders: [
      { props: { error: { status: 404, message: 'No page' } }, contains: ['Not found'] },
      { props: { error: { status: 503, message: 'Down' } }, contains: ['Server error'] },
      { props: { error: { status: 418, message: 'Teapot' } }, contains: ['Error 418'] },
    ],
  },
  {
    path: 'ui/frame.jsails',
    source: `<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="frame"><header><h2>{{ title }}</h2><slot name="actions"><a href="/">Home</a></slot></header>
    <slot>Nothing to show.</slot>
  </div>
</template>
`,
    renders: [{ props: { title: 'T' }, contains: ['<h2>T</h2>', 'Nothing to show.'] }],
  },
  {
    path: 'ui/tag-badge.jsails',
    source: `<script setup lang="ts">
const { tag, count = 1 } = defineProps<{ tag: string; count?: number }>();
const label = tag.toUpperCase();
</script>

<template>
  <span class="badge" :class="[count > 3 && 'small', { solo: count === 1 }]" style="color: red" :style="{ fontWeight: 'bold' }" js-show="label !== ''">{{ label }}</span>
</template>
`,
    renders: [
      { props: { tag: 'news', count: 1 }, contains: ['NEWS', 'solo'] },
      { props: { tag: '', count: 5 }, contains: ['display:none'] },
    ],
  },
  {
    path: 'ui/post-not-found.jsails',
    source: `<script setup lang="ts">
defineProps<{ path: string }>();
</script>

<template><p class="empty">No post at <code>{{ path }}</code>.</p></template>
`,
    renders: [{ props: { path: '/x' }, contains: ['<code>/x</code>'] }],
  },
  {
    path: 'ui/card.jsails',
    source: `<script lang="ts">
/** A card listing rows, with header, row and default slots. */
import type { ComponentChild } from 'jsails/view';

export interface Row {
  readonly id: number;
  readonly label: string;
}
</script>

<script setup lang="ts">
interface CardSlots {
  readonly header?: ComponentChild;
  readonly children?: ComponentChild;
  readonly row?: (props: { item: Row; index: number }) => ComponentChild;
}
defineProps<{ rows: readonly Row[]; attributes?: Record<string, string>; note: string }>();
defineSlots<CardSlots>();
</script>

<template>
  <section class="card" js-bind="attributes">
    <header><slot name="header">Rows</slot></header>
    <ol><template js-for="(item, index) in rows" :key="item.id"><slot name="row" :item="item" :index="index"><li>{{ item.label }}</li></slot></template></ol>
    <slot />
    <component :is="rows.length > 1 ? 'strong' : 'em'" class="count">{{ rows.length }}</component>
    <!-- prettier-ignore -->
    <pre js-pre>{{a+b}}   <b   :t="p+q">raw   </b>
      kept</pre>
    <p>Inline raw: <!-- prettier-ignore --><code js-pre>{{ not   interpolated }}</code> after.</p>
    <p js-text="note"></p>
    <div js-html="'<i>trusted</i>'"></div>
  </section>
</template>
`,
    renders: [
      {
        props: { rows: [{ id: 1, label: 'One' }], note: 'n', attributes: { id: 'c' } },
        contains: ['<pre>{{a+b}}   <b :t="p+q">raw   </b>\n      kept</pre>', '<i>trusted</i>'],
      },
    ],
  },
  {
    path: 'ui/post-list.jsails',
    source: `<script setup lang="ts">
import type { Row } from './card.jsails';
defineProps<{ rows: readonly Row[]; totals: Record<string, number> }>();
</script>

<template>
  <Card :rows="rows" :attributes="{ id: 'posts', class: 'wide' }" note="Totals below">
        <template #header><b>Posts</b></template>
    <template #row="{ item, index }"><li :data-index="index">#{{ item.id }} {{ item.label }}</li></template>
    <dl><template js-for="(value, key, index) in totals" :key="key"><dt>{{ index + 1 }}. {{ key }}</dt>
          <dd>{{ value }}</dd></template></dl>
  </Card>
</template>
`,
    renders: [
      {
        props: {
          rows: [
            { id: 1, label: 'One' },
            { id: 2, label: 'Two' },
          ],
          totals: { posts: 2, drafts: 1 },
        },
        contains: ['<li data-index="1" data-s="cu47kewx">#2 Two</li>', '<dt>2. drafts</dt>'],
      },
    ],
  },
  {
    path: 'ui/whitespace-rows.jsails',
    source: `<script setup lang="ts">
defineProps<{ name: string }>();
</script>

<template>
  <div class="rows">
    <p><TagBadge tag="first-tag-with-a-long-name" :count="1" /> <TagBadge tag="second-tag-with-a-long-name" :count="2" /> <TagBadge tag="third" /></p>
    <p>Some <em>emphasis that runs long enough</em> you <strong>will see the line overflow the print width</strong> here.</p>
    <div>a</div> <div>b</div>
    <div>text<p>x</p>more</div>
    <div> text </div>
    <button> x </button>
    <span> x </span>
    <span> <b>bold</b> </span>
    <p>a<button>x</button>b</p>
    <p>Hello,
       {{ name }}!   <a href="/next">Next</a>
    </p>
    <ul>   <li> one </li>   <li>two</li>   </ul>
    <label>Name <input name="n"><br>Next line</label>
  </div>
</template>
`,
    renders: [
      {
        props: { name: 'Ada' },
        contains: ['<button>x</button>', '<span> x </span>', 'a<button>x</button>b', 'Hello, Ada!'],
      },
    ],
  },
  {
    path: 'ui/printed-attributes.jsails',
    source: `<script setup lang="ts">
defineProps<{ wide: boolean; extra?: Record<string, string> }>();
</script>

<template>
  <div class="  card   wide
     shadow " style="COLOR:#FFAA00;margin:0 auto;transition:opacity .30s ease,transform .3s ease-in-out,box-shadow 0.3s linear;font:12px/1.5 'Helvetica Neue',Arial,sans-serif">
    <img src="/a.png" srcset="/a.png 1x,/b.png   2x" alt="A">
    <picture><source srcset="/hero-small.webp 480w,/hero-medium.webp   800w,/hero-large-version.webp 1200w,/hero-extra-large-version.webp 2400w" type="image/webp"><img src="/hero.png" alt="Hero"></picture>
    <iframe src="/embed" allow="fullscreen;autoplay  'self';camera https://camera.example.com https://other.example.com;microphone" title="Embed"></iframe>
    <p class="note  muted" :class="{ wide }" style="background:URL(/bg.png) no-repeat center/cover;--Accent:#FFAA00" :style="{ fontWeight: 'bold' }">Merged</p>
    <section class=" spread   box " style="padding:.50EM 1.0em" js-bind="extra">Spread</section>
    <TagBadge class="  a   b " tag="x" />
    <span style="width:calc(100% - 2*var(--gap,8px));content:&quot;\\201C&quot;;color:#ABCDEF !IMPORTANT">Calc</span>
  </div>
</template>
`,
    renders: [
      {
        props: { wide: true, extra: { id: 'spread', class: 'from-extra' } },
        contains: [
          'class="card wide shadow"',
          'srcset="/a.png 1x, /b.png 2x"',
          'srcset="/hero-small.webp 480w, /hero-medium.webp 800w, /hero-large-version.webp 1200w, /hero-extra-large-version.webp 2400w"',
          'allow="fullscreen; autoplay \'self\'; camera https://camera.example.com https://other.example.com; microphone"',
          'class="note muted wide"',
          'class="spread box from-extra"',
          'width: calc(100% - 2 * var(--gap, 8px))',
        ],
      },
      { props: { wide: false }, contains: ['class="note muted"', 'class="spread box"'] },
    ],
  },
  {
    path: 'ui/messy-code.jsails',
    reformatsCode: true,
    source: `<script setup lang="ts">
const {a,b,items}=defineProps<{a:number;b:number;items:readonly string[]}>()
const label = "sum"
</script>

<template>
  <section :title="label+':'+(a+b)">
    <p js-if="a>b">{{a+b}}</p>
    <p js-else-if="a===b">{{ a*2 }}</p>
    <p js-else>{{ \`\${b-a}\` }}</p>
    <i js-for="(item,i) in items" :key="item" :data-i="i">{{item.toUpperCase()}}</i>
  </section>
</template>
`,
    renders: [
      { props: { a: 2, b: 1, items: ['x', 'y'] }, contains: ['<p>3</p>', 'data-i="1"'] },
      { props: { a: 1, b: 1, items: [] }, contains: ['<p>2</p>'] },
    ],
  },
  {
    path: 'components/task-list.jsails',
    renders: [
      {
        contains: [
          'data-jsails-submit="add"',
          'data-jsails-model="title" data-jsails-trim',
          'data-jsails-loading-target>Add</button>',
          'No tasks yet.',
          '0 tasks',
        ],
      },
      { static: true, contains: ['<p>The task list works when the site is served.</p>'] },
    ],
    source: `<script lang="ts">
/** Demo task list: server state, two actions, and a static-export fallback. */
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
        state.tasks.push(z.string().trim().min(1).parse(state.title));
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
  <section class="card w-full bg-base-100 shadow-xl">
    <form class="flex gap-2" @submit="add"><input class="input input-bordered w-full" js-model.trim="title" placeholder="New task"><button class="btn btn-primary" js-loading>Add</button></form>
    <p js-if="errors.title" class="text-error">{{ errors.title }}</p>
    <ul js-if="tasks.length > 0" class="list"><li js-for="(task, index) in tasks" :key="task" class="list-row">{{ task }}
        <button class="btn btn-ghost btn-xs" @click="remove({ index })" js-confirm="'Remove it?'">Remove</button></li></ul>
    <p js-else class="text-base-content/60">No tasks yet.</p>
    <p class="text-sm">{{ count }} {{ count === 1 ? 'task' : 'tasks' }}</p>
  </section>
</template>

<template static>
  <section class="card w-full bg-base-100 p-6">    <p>The task list works when the site is served.</p></section>
</template>
`,
  },
  {
    path: 'ui/scoped-note.jsails',
    renders: [{ props: { text: 'Hi' }, contains: ['<p>Hi</p>', '<small>Scoped</small>'] }],
    source: `<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <aside class="note"><p>  {{ text }}  </p>
      <small>Scoped</small></aside>
</template>

<style scoped>
.note {
  align-items: center;
}
</style>
`,
  },
  {
    path: 'islands/counter.jsails',
    renders: [{ props: { start: 2 }, contains: ['<output>2</output>', '<input value="2"/>'] }],
    source: `<script setup lang="ts">
const { start = 0 } = defineProps<{ start?: number }>();
const count = useSignal(start);
</script>

<template>
  <form @submit.prevent="count.value = 0"><button type="button" @click="count.value++">+</button> <output>{{ count.value }}</output> <input js-model.number="count"></form>
</template>
`,
  },
]);
