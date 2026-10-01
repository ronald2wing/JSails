# `.jsails` Toolchain — Decision Record

The toolchain decisions that the `.jsails` single-file component work
(SFC-01 to SFC-18) builds on, with the probe evidence behind each one. This is
package SFC-00 of the rebuild plan. The format itself (grammar, kinds, scope
rule, lowering) is specified in the plan's `sfc-plan.md`; this record decides
how TypeScript, typescript-eslint, Prettier, oxc and the editor carry that
format, and it corrects the plan where a probe contradicted it (§9).

Source comments and later packages cite this document as `docs/design/sfc.md
§N`. Section numbers are stable identifiers: renumber only together with every
citation.

Probed on 2026-11-20 on Linux, Node 26.13.1, against these versions:

| Tool | Version | Where it comes from |
|---|---|---|
| `tsc` (TypeScript 7 native) | 7.0.2 | root `@typescript/native` (`npm:typescript@^7.0.2`) |
| `tsc` with content mappers | 7.1.0-beta (2026-10-20) | registry tarball, probe only |
| TypeScript for typescript-eslint | 6.0.2 | root `typescript` (`npm:@typescript/typescript6`) |
| typescript-eslint / ESLint | 8.72.0 / 10.13.0 | root devDependencies |
| Prettier | 3.9.10 | root devDependencies |
| oxc transformer | through `rolldown/utils` 1.2.15 | `core` dependency `rolldown` |
| VS Code extension | `TypeScriptTeam.native-preview` 1.0.2 (2026-11-06) | Marketplace VSIX, inspected |
| Vue's content mapper (reference) | `@vue/content-mapper` 4.0.0-alpha.0 | registry tarball, inspected |

## 1. Decisions at a glance

| # | Question | Answer | Decision |
|---|---|---|---|
| Q1 | Does TS 7.0 resolve `import X from './x.jsails'` to a sidecar under NodeNext, and do planted diagnostics map back? | Only through a one-line bridge file: JSails apps are ESM, and ESM resolution does not append extensions to `.jsails` (§3.1) | Phase A sidecars are kept, as a pair per file: `<rel>.jsails.tsx` (checked code) plus `<rel>.d.jsails.ts` (re-export bridge), with `allowArbitraryExtensions` (§3.2). Verbatim, Alias and Atom spans map exactly (§3.3) |
| Q2 | Does typescript-eslint's `projectService` lint a shadow with typed rules? | Yes, on TS 6.0.2, with exact remapping (§4) | Typed lint on shadows is kept. The ignore pattern and two lowering rules change (§4.2) |
| Q3 | Does Prettier's `vue` parser format the grammar? | Yes for the template, `<template static>`, `:x`, `@x`, `#x` and `js-*`. It silently skips any `<script>` without `lang="ts"`, does not know `js-pre` (or `v-pre`) and reformats the `{{ }}`, `:x` and whitespace inside it, and adds or removes whitespace wherever its CSS display table says whitespace is insignificant, which Vue's whitespace rule does not match (§5) | Prettier `vue` without a plugin is kept. Every `<script>` must carry `lang="ts"`, every `js-pre` element must be preceded by `<!-- prettier-ignore -->`, and the whitespace rule is Prettier's own significance rule instead of Vue's `condense` (§5.2) |
| Q4 | Does a small content mapper handshake with TS 7.1 under `--runExternalCode`? | Yes. 7.1.0-beta reports the same diagnostics at the same `.jsails` positions as Phase A; hover, completion and definition work over LSP (§6) | **Go** for SFC-15's design; **no-go** for shipping it until 7.1 is stable, as planned. Four protocol facts change SFC-02, SFC-03 and SFC-15 (§6.3) |
| Q5 | Can the TS 7 VS Code extension attach to `.jsails` documents? | Yes, by file pattern, not by `languageId`. It does not activate on a `.jsails` file alone (§7) | `editors/vscode` declares the `jsails` language, depends on the TS 7 extension and registers `.jsails` through its `registerContentMappers` API (§7.2) |
| Q6 | Does oxc give JSX automatic runtime, source maps and isolated declarations in-process? | Yes. But the typed `typescript.inputMap` option is ignored; a declaration error discards the JS output too; every error, syntax or declaration, has `code: 'PARSE_ERROR'`; and messages carry ANSI colour and a code frame of the source (§8) | `compileSfc` composes maps itself from the span table and never requests declarations; only the package build does. oxc errors are read by `pos` and the `TSnnnn` token, never copied (§8.2) |

## 2. Shared terms

- **Shadow**: the TSX text `lowerSfc` derives from a `.jsails` file. TypeScript
  checks it and oxc compiles it (sfc-plan §3.1, "check what you ship").
- **Span table**: the shadow's mappings, as tuples
  `[generatedStart, generatedLength, originalStart, originalLength, kind]`.
  `kind` is Verbatim (the bytes are equal), Alias (generated text that stands
  for a source name, mapped to the name's first use) or Atom (generated code
  owned by a source range, mapped to the whole range). This is the shape of
  TS 7.1's `SpanMapping` minus its feature bits (§6.2), so one table serves
  both phases.
- **Phase A**: TS 7.0, sidecar files on disk plus a remapper. **Phase B**:
  TS 7.1 or later, a content mapper inside `tsc` and the language server.

The probe fixture used throughout is a page and a view:

```html
<!-- pages/post.jsails (template part) -->
<template>
  <main>
    <h1>{{ pgae.title }}</h1>                         <!-- line 15: typo -->
    <p>{{ formatDate(page.date) }}</p>
    <Card :title="42" />                              <!-- line 17: wrong prop type -->
    <ul><li js-for="tag of page.count">{{ tag }}</li></ul>  <!-- line 18: not iterable -->
  </main>
</template>
```

`pages/post.jsails` imports `../shared/format.js` (a real `.ts` file) and
`../ui/card.jsails` (another shadow). `ui/card.jsails` plants a type error in
its `<script>` (`const wrong: number = 'x'`, line 4). `pages/index.ts` imports
the view and calls it with a wrong prop. The page's shadow also ends with one
deliberately broken generated import, to exercise the unmapped footer.

## 3. Q1 — Types on TS 7.0: sidecars under NodeNext

### 3.1 Finding: ESM resolution does not reach `x.jsails.tsx`

sfc-plan §0.1 records that TS 7.0.2 resolves `./card.jsails` to a `rootDirs`
sidecar `card.jsails.tsx`. That probe had no `package.json`, so TypeScript
resolved in CommonJS mode, which appends extensions. Every JSails app and
starter is `"type": "module"`. In ESM mode, `--traceResolution` shows that TS
7.0.2 strips the unknown extension and looks only for the arbitrary-extension
declaration file:

```text
Resolving in ESM mode with conditions 'import', 'types', 'node'.
File name '…/ui/card.jsails' has a '.jsails' extension - stripping it.
File '…/ui/card.d.jsails.ts' does not exist.
…
Loading 'ui/card.jsails' from the root dir '…/.jsails/sfc', candidate location '…/.jsails/sfc/ui/card.jsails'.
File '…/.jsails/sfc/ui/card.d.jsails.ts' does not exist.
======== Module name '../ui/card.jsails' was not resolved. ========
```

With the plan's layout, both `pages/index.ts` and the page's shadow fail with
`TS2307 Cannot find module '../ui/card.jsails'`. A single
`card.d.jsails.ts` holding the shadow does not work either: it is a `.ts`
declaration file, so JSX does not parse and function bodies are not allowed.

`moduleResolution: "Bundler"` (with `module: "Preserve"`) does append
extensions, and there the plan's layout resolves. It is not adopted: apps and
the repo compile with NodeNext, and the bridge below works under both.

### 3.2 Decision: a shadow pair per file

`jsails sync` writes two files per `.jsails` file, atomically and only when the
content changes:

```text
.jsails/sfc/ui/card.jsails.tsx     the shadow (checked code)
.jsails/sfc/ui/card.jsails.map.json  the span table
.jsails/sfc/ui/card.d.jsails.ts    the bridge
```

The bridge is fixed text, derived from the basename only:

```ts
export * from './card.jsails.js';
export { default } from './card.jsails.js';
```

Under NodeNext, `./card.jsails.js` resolves to `card.jsails.tsx` by the
ordinary `.js`-to-`.tsx` substitution, so no `allowImportingTsExtensions` is
needed. `export *` does not carry `default`, hence the second line; it is
always valid because every kind in sfc-plan §2.2 has a default export. The
bridge is a declaration file, so `skipLibCheck` (on in every starter) would
hide an error inside it; its text is fixed so that it cannot have one. The app tsconfig gains:

```jsonc
{
  "compilerOptions": {
    "rootDirs": [".", ".jsails/sfc"],
    "allowArbitraryExtensions": true
  },
  "include": [/* the app's patterns */, ".jsails/sfc/**/*.tsx"]
}
```

Facts the probe established:

- A shadow is an ES module, because the app's `package.json` is the nearest one
  above `.jsails/sfc/`.
- From a shadow, `../shared/format.js` reaches `shared/format.ts` through
  `rootDirs`, and `../ui/card.jsails` reaches the other shadow's bridge.
- `node_modules` resolution from `.jsails/sfc/**` walks up to the app's
  `node_modules`. `jsxImportSource: "jsails"` resolves `jsails/jsx-runtime`
  from a shadow.
- Shadows belong only in a `noEmit` program. With `rootDir: "."` and an
  emitting `tsc` they would be written to `dist/.jsails/sfc/`. KRN-16 makes
  `tsc` check-only, and before M5 no app compiles `.jsails` (sfc-plan D3).
- A missing shadow is a plain `TS2307`. `jsails typecheck` therefore always
  runs `jsails sync` first.
- A run over the fixture takes about 0.1 s.

### 3.3 Evidence: planted diagnostics, remapped

`tsc --pretty false` over the fixture, remapped through the span table:

| Planted fault | Shadow position | Span | Remapped to |
|---|---|---|---|
| `{{ pgae.title }}` | `__props.pgae` | Alias (the property name) | `pages/post.jsails:15:12` `TS2339` |
| `<Card :title="42" />` | the attribute name `title` | Alias (attribute name to `title` after `:`) | `pages/post.jsails:17:12` `TS2322` |
| `js-for="tag of page.count"` | `page.count` | Verbatim | `pages/post.jsails:18:28` `TS2345` |
| `const wrong: number = 'x'` | in the `<script>` copy | Verbatim | `ui/card.jsails:4:7` `TS2322` |
| `Card({ title: 1 })` in `index.ts` | — | real file | `pages/index.ts:5:27` `TS2322` |
| the cascade of the `js-for` fault | `(tag) => <li>…` | none | gap: `TS2322 Type 'unknown' is not assignable to type 'ComponentChildren'` |
| the broken footer import | footer | none | gap: `TS2882` |

With the bridges removed, each `.jsails` import fails with `TS2307`, and the
errors that depend on the imported types (the `:title` prop and the call in
`index.ts`) disappear, because the import is then `any`. With
`jsxImportSource: "jsails"`, a shadow that imports a name `jsails` does not
export (`ComponentChild`, which `jsails/view` will provide) produces a gap
`TS2305` on the generated header, which the remapper correctly classes as a
compiler bug (`sfc_internal`).

Three rules follow, and SFC-02 and SFC-03 encode them:

1. TypeScript reports a wrong JSX attribute at the **attribute name**, not the
   value. Every lowered attribute name is an Alias span to its source name.
2. TypeScript reports a missing property at the **property name**. The Alias
   in `const page = __props.page;` covers the name after `__props.`, not the
   whole access.
3. A cascade lands in generated code (the `js-for` callback above). Every
   generated chunk inside the render function must be an Atom span owned by
   the template node that produced it, so a cascade maps to that node. Only
   the module header and footer stay unmapped, and a diagnostic there is
   `sfc_internal`. §6.3 shows that TS 7.1 needs the same Atom spans.

### 3.4 Editor support in Phase A

Over `tsc --lsp --stdio` (7.0.2), in `pages/index.ts`:

- go to definition on `Card` lands on the shadow's `Card` declaration in
  `.jsails/sfc/ui/card.jsails.tsx` (the bridge is skipped);
- hover shows `(alias) function Card(__props: { title: string; }): ComponentChild`;
- go to definition on the specifier `'../ui/card.jsails'` lands on the bridge.

That is sfc-plan §3.5's "go-to-definition into readable shadows". Nothing lands
on the `.jsails` source before Phase B.

### 3.5 Reading diagnostics

`--pretty false` prints `file(line,col): error TSnnnn: message`, followed by
indented continuation lines for message chains and notes. The remapper parses
the first line and keeps the continuation lines with it. TypeScript prints
paths with `/` on every platform; the remapper still resolves them through
`core/src/support/project-paths.server.ts`.

TS 7.0.2 also exposes a program API under
`@typescript/native/unstable/sync`. On the fixture,
`project.program.getSemanticDiagnostics()` returned the same seven diagnostics
as `[pos, end)` offsets in 80 ms. That would map whole ranges instead of start
points, but the subpath is `unstable` in 7.0; it becomes the `typescript/sync`
export in 7.1. Phase A therefore parses the CLI output. SFC-15 may switch to
the API once 7.1 is the floor.

## 4. Q2 — Typed lint on shadows

### 4.1 Evidence

ESLint 10.13 with `tseslint.configs.recommendedTypeChecked` and
`projectService: true`, linting the fixture. typescript-eslint runs on
TypeScript 6.0.2, which resolves the bridge exactly as TS 7.0 does. Messages
were remapped through the same span table:

| Message | Remapped to |
|---|---|
| `no-floating-promises` on a bare `ping();` in `<script>` | `ui/card.jsails:6:1` |
| `no-unsafe-member-access` on `{{ JSON.parse(title).x }}` | `ui/card.jsails:14:69` (inside the template expression) |
| `no-unused-vars` on `wrong` | `ui/card.jsails:4:7` |
| `require-await` on `load` | `pages/post.jsails:6:8` |
| `no-unsafe-member-access` on `pgae.title` (cascade of `TS2339`) | `pages/post.jsails:15:17` |
| `require-await` on the generated `async function Page` | gap |
| `no-unsafe-assignment` of the error-typed `pgae` | gap |

`pages/index.ts` had no unsafe-call message, which shows that its import of
`../ui/card.jsails` resolved, with types, under TS 6. `projectService` picked
the app's `tsconfig.json` for files under `.jsails/sfc/`, because it is the
nearest one.

### 4.2 Decisions

- **Ignore pattern.** The repo's `**/.jsails/**` cannot be undone by
  `!**/.jsails/sfc/**`: ESLint does not re-include files under an ignored
  directory. The pattern that works, bridges included, is
  `ignores: ['**/.jsails/*', '!**/.jsails/sfc/', '**/*.d.jsails.ts']`
  (checked with `isPathIgnored` and a lint of `.`: only the shadow and the
  app's own files are linted). ESLint 10 does not skip dot-directories by
  itself, so a lint of `.` reaches shadows once the pattern allows it. Bridges
  hold no code.
- **No `async` without `await`.** The emitter writes `async` on a generated
  page or layout function only when the setup block contains `await`.
  Otherwise every page gets a `require-await` in a gap.
- **Lint runs after a clean typecheck.** Type errors cascade into
  `no-unsafe-*` messages, some of them in gaps. `jsails lint` and the repo
  gate run typed lint on shadows only when `jsails typecheck` has no errors
  for that file, so a gap message always means a compiler bug.

## 5. Q3 — Prettier `--parser vue`

### 5.1 Evidence

Prettier 3.9.10 with the repo's `.prettierrc.json`, over the plan's two
examples (§2.7 `task-list.jsails`, §2.8 `blog/[slug].jsails`), a sweep of
every §2.1 and §2.4 construct, and edge cases. Every file formatted without
error, the second pass was identical to the first, and every `js-*`
attribute and its value survived byte for byte. The rows marked **changes
output** are cases where the formatted file would render different HTML under
the rule they name; §5.2 removes each one.

| Construct | Result |
|---|---|
| `:x`, `@x.mod`, `#x="{ item }"`, `#default` | values formatted as JS or TS expressions |
| `js-if`, `js-for`, `js-model.trim`, `js-confirm`, `js-hydrate`, … | kept verbatim (plain attributes) |
| `{{ }}`, including a template literal holding `}}` | formatted |
| text with `{`, `}`, `a > b`, entities | kept |
| `<pre>` | content kept exactly |
| `<template static>` (second root template) | formatted as a template, also when its content is messy |
| `<template js-for>`, `<Card><template #x>` | formatted with Prettier's whitespace-safe `><` hugging, exactly as it formats `v-for` and `v-slot` |
| void elements | printed as `<input />`; both forms are legal |
| unknown blocks (`<server>`, `<fallback initial />`) | left verbatim |
| one-line blocks | each block is formatted on its own |
| an invalid expression (`:title="a +"`, `{{ a + }}`) | left verbatim, **no error** |
| `<script>` **without** `lang="ts"` holding TS syntax | left **verbatim, no error**: Prettier parses it with Babel, fails, and keeps the text |
| `{{ (n as number) }}` when no script has `lang="ts"` | left verbatim; formatted when any script has `lang="ts"` |
| `<script lang="ts">` beside `<script setup>` without `lang` | the first is formatted, the second is not |
| `js-pre` content | **rewritten**: runs of spaces collapse and `<b   >` becomes `<b>`. Prettier has no notion of `js-pre`, nor of Vue's `v-pre` |
| `{{a+b}}` and `:t="p+q"` inside a `js-pre` subtree, including `<pre js-pre>` and `<code js-pre>` | **reformatted** to `{{ a + b }}` and `:t="p + q"`. These are literal text under `js-pre`, so this **changes output** under any `js-pre` rule |
| `<!-- prettier-ignore -->` before a `js-pre` element, as a block child or inline in a paragraph | the element is kept byte for byte, interpolations and whitespace included, and the rest of the file is formatted |
| `<!-- prettier-ignore -->` before an element | honoured |
| a space between two inline siblings, on a line that overflows | **replaced by a line break**: `<Card … /> <Card … />` becomes `<Card … />⏎<Card … />`, and `</em> you <strong>` breaks at the space as well. **Changes output** under Vue's `condense`, which deletes a whitespace-only node that contains a line break |
| `<div>a</div> <div>b</div>` (a space, no line break, between blocks) | the space becomes a line break. **Changes output** under any rule that keys on line breaks |
| `<div>text<p>x</p>more</div>` (no whitespace at all) | becomes `text⏎<p>x</p>⏎more`: Prettier **adds** whitespace next to a block sibling |
| `<div> text </div>`, `<button> x </button>` | becomes `<div>text</div>`, `<button>x</button>`: Prettier **removes** edge whitespace in a block or `inline-block` parent |
| `<span> x </span>`, `<span> <b>bold</b> </span>`, `a<button>x</button>b` | kept: edge whitespace of an inline parent, and whitespace (or its absence) next to an inline or `inline-block` sibling, is significant |
| static `class`, `style`, `srcset` (on `img` and `source`), `allow` (on `iframe`) and `on*` values (found by SFC-06's format corpus) | **rewritten** by Prettier's attribute printers: class names joined by one space, style declarations, srcset candidates and permission directives reprinted, broken across lines indented to the element's depth when long, a handler formatted as JavaScript. The rendered attribute **bytes change**. Mostly the browser reads the same value, but not always: Prettier's CSS printer glues or splits words around a backslash escape outside a string, an `!important` that does not end its declaration, a `url(` whose argument is not one string and a `/` next to a call, and turns a `+`-signed number into an addition |

### 5.2 Decisions

- **`lang="ts"` is required on every `<script>` block.** A missing `lang` is
  `sfc.script_lang_required`, with a fix-it that inserts it. This is what Vue
  does (no `lang` means JavaScript there). It also makes Prettier format the
  script and parse template expressions as TypeScript, and lets the TextMate
  grammar and editors embed TypeScript by the attribute. A default `lang`
  would make Prettier skip every script silently.
- **Every `js-pre` element is preceded by `<!-- prettier-ignore -->`.**
  Prettier formats the interpolations and bound attributes inside a `js-pre`
  subtree, which are literal text there, so without the comment `jsails
  format` would change what the page renders (§5.1). With it, Prettier keeps
  the element byte for byte, so `js-pre` keeps sfc-plan §2.4's meaning: a raw
  subtree, no interpolation, no directives, byte-exact. A `js-pre` element
  whose previous sibling, ignoring whitespace, is not that comment is
  `sfc.js_pre_needs_prettier_ignore`, with a fix-it that inserts it. A
  Prettier plugin that teaches the `vue` printer about `js-pre` was rejected:
  the comment works with any Prettier, in any editor, with no configuration,
  and keeps sfc-plan's "no plugin" decision.
- **The whitespace rule is Prettier's significance rule, not Vue's
  `condense`.** sfc-plan §2.4 adopts Vue 3's rule "because Prettier's `vue`
  printer assumes it". It does not. Prettier decides, from its CSS
  default-display table (`prettier/plugins/html.mjs`, the
  `isLeadingSpaceSensitive` and `isTrailingSpaceSensitive` passes), where
  whitespace is significant. Where it is, Prettier only swaps a space for a
  line break; where it is not, Prettier adds or removes whitespace freely
  (§5.1). Vue's rule keys on line breaks instead, so formatting changes the
  HTML it renders. The JSails rule takes Prettier's classification, so that a
  formatted file always renders the same HTML. For each whitespace run in the
  template, inside a text node or forming one:
  - it is **removed** when it is insignificant: at the start or end of the
    children of the root `<template>`, or of an element whose default display
    is `block`, `list-item`, `table*`, `inline-block` or `none`; or next to a
    sibling element whose default display is `block`, `list-item` or
    `table*`;
  - otherwise it becomes **one space**;
  - line breaks play no part;
  - comments are removed before the rule applies, so the whitespace on both
    sides of a comment counts as one run;
  - `<pre>`, `<textarea>` and `js-pre` subtrees keep whitespace exactly.

  The display table is Prettier's, copied into SFC-01 and pinned by a test to
  the installed Prettier; unknown elements, components included, are inline.
  Consequences: components written on separate lines get a space between
  them, as inline elements do in HTML; between components that render blocks
  the browser does not show it. Whitespace at the edges of a `<div>` or a
  `<button>` is dropped, which a browser displays the same way, because it
  does not show whitespace at the start or end of a line box.
- **The template parser canonicalizes the static values Prettier prints.**
  A static `class`, `style`, `srcset` (on `img` and `source`) or `allow` (on
  `iframe`) value is written in one canonical form that the original and
  every printing of it share (`core/src/compiler/sfc/printed-attributes.ts`
  states it), so a formatted file renders the same bytes as the original,
  for every kind's lowering at once. A `js-pre` subtree keeps its values as
  written, as Prettier does behind `<!-- prettier-ignore -->`. A `style`
  value outside the subset whose meaning Prettier keeps (§5.1) is
  `sfc.unstable_style`: write plain declarations, or bind it with `:style`.
  `printed-attributes.test.ts` formats a seeded sweep of values with the
  installed Prettier at several widths, depths and quote styles and checks
  each output reduces to its input's form; the format corpus
  (`scripts/test/sfc-format.test.mjs`) then compares rendered HTML byte for
  byte. Comparing such values by meaning in the corpus was rejected: it left
  the rendered bytes depending on whether a file was formatted, with no
  owner for the gap.
- **An `on*` attribute is `sfc.event_handler_attribute`.** An inline handler
  is inline script, which the planned CSP refuses, the server renderer drops
  it anyway, and Prettier formats it as JavaScript. Events are handled with
  `@event` in an island or a live component. The check covers `js-pre`
  subtrees too, since the browser runs the attribute there just the same.
- Vue's `.prop` shorthand (`.x`) and `slot-scope` are `sfc.vue_syntax`, with
  fixes to `:x` and `#default`, like the other Vue spellings.
- **Prettier is a formatter, not a validator.** It keeps invalid code
  verbatim without failing. Syntax errors are the compiler's job (SFC-01), and
  `format:check` passing says nothing about validity.
- `htmlWhitespaceSensitivity` stays at the default `css`, the mode whose
  output the rule above preserves. The `><` hugging is cosmetic. `ignore`
  would let Prettier put line breaks between inline siblings that had no
  whitespace between them, and the rule above would render those as spaces.

## 6. Q4 — The TS 7.1 content mapper

### 6.1 Status today

`npm view typescript dist-tags` on 2026-11-20: `latest 7.0.2` (2026-07-08),
`beta 7.1.0-beta` (2026-10-20), `next 7.1.0-dev.20261120.1`. There is no 7.1
release candidate. For comparison, 7.0 went from `7.0.1-rc` (2026-06-18) to
`7.0.2` in three weeks. Vue's mapper is `4.0.0-alpha.0` and declares
`typescript >=7.1.0-beta` as its peer.

### 6.2 Evidence: a JSails mapper over the same span table

A 32-line mapper (Appendix A) was installed as a package. Its `transform`
returned the Phase A shadow text and span table, converted to `SpanMapping`.
The app tsconfig dropped `rootDirs` and the shadow include and added:

```jsonc
"contentMappers": [{ "package": "jsails-cm-probe", "extensions": [".jsails"] }],
"include": [/* … */, "pages/**/*.jsails", "ui/**/*.jsails"]
```

`tsc 7.1.0-beta -p . --runExternalCode --noEmit --pretty false`:

```text
pages/index.ts(5,27): error TS2322: Type 'number' is not assignable to type 'string'.
pages/post.jsails(15,12): error TS2339: Property 'pgae' does not exist on type '{ page: … }'.
pages/post.jsails(17,12): error TS2322: Type 'number' is not assignable to type 'string'.
pages/post.jsails(18,28): error TS2345: Argument of type 'number' is not assignable to parameter of type 'readonly unknown[]'.
pages/post.jsails(18,24): error TS2322: Type 'unknown' is not assignable to type 'ComponentChildren'.
pages/post.jsails(19,8): error TS2882: Cannot find module or type declarations for side-effect import of '../__missing.js'.
  This location is in virtual code produced by the content mapper 'jsails-cm-probe@0.0.0' and has no corresponding location in the original file.
ui/card.jsails(4,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

Every mapped diagnostic has the code and position Phase A computed (§3.3).
The mapper received `initialize`, `openProject`, one `transform` per
`.jsails` file and `closeProject`, and the whole run took about 0.09 s.
`pages/index.ts` imported `../ui/card.jsails` directly, with no bridge.
Without `--runExternalCode`, `tsc` reports `TS18068 Content mappers require
the '--runExternalCode' command line flag` on the tsconfig, plus a `TS2307`
for each import.

Over `tsc --lsp --stdio` (7.1.0-beta), with
`initializationOptions.runExternalCode: true` (the LSP mode takes no
`--runExternalCode` flag), and the file opened with `languageId: "jsails"`:

- hover on `page` inside `{{ formatDate(page.date) }}` shows its type;
- completion after `page.` lists `title`, `date`, `tags`, `count`;
- pull diagnostics return the `.jsails` ranges above;
- go to definition on `formatDate` lands in `shared/format.ts`;
- go to definition on `<Card>` returned nothing until the shadow's `Card`
  declaration name was mapped (an Atom to the `<template>` tag of
  `ui/card.jsails`); then it landed there.

Without `runExternalCode`, every request on the `.jsails` file returns
`null`.

### 6.3 What this changes

1. **Gaps.** For an unmapped position, TS 7.1 picks a neighbouring mapping:
   the `js-for` cascade landed on `18:24`, the end of the alias `tag`. For a
   position in the footer it reports the virtual line and column against the
   `.jsails` file name, with a note. With Atom spans over the generated chunks
   of the `js-for` lowering (§3.3, rule 3), the cascade landed on `18:9`, the
   `<li js-for>` start tag, which is where Phase A's remapper puts it. So the
   owner Atoms are what makes SFC-15's diagnostic-equality gate achievable.
   The footer never produces a diagnostic, by construction.
2. **Declarations need a mapping.** Definition, references and rename resolve
   only to mapped positions. The generated component function name (and any
   other generated declaration a caller can reach) gets an Atom to the
   `<template>` tag, or to the `defineProps` call when there is one.
3. **`configIdentity` needs `dynamicConfig`.** Returning `configIdentity`
   from `openProject` fails every transform with `TS18069 … only allowed when
   it declares "dynamicConfig": true`. JSails' mapper returns `{}` unless its
   options affect the transform; if they do, it declares `dynamicConfig`.
4. **Protocol facts.** LSP-style `Content-Length` framing over stdio;
   `positionEncoding` must be negotiated, and `utf-16` is what TypeScript
   offers; the mapping tuple is
   `[generatedStart, generatedLength, originalStart, originalLength, kind, features]`
   with `kind` Verbatim = 0, Atom = 1, Alias = 2 and twenty feature bits;
   `extension` is one of the JS, TS and JSON extensions (`.tsx` here). The
   package declares the mapper as
   `"typescript": { "contentMapper": { "exec": ["node", "<file>"] } }`.
5. **Phase A and Phase B in one checkout.** With sidecars and a mapper in one
   tsconfig, 7.1 resolves `./card.jsails` to the mapped file, and the included
   shadows are checked as well, so each error is reported twice. TS 7.0 and
   TS 6 ignore the top-level `contentMappers` key without an error, and
   `"contentMappers": null` in an extending tsconfig removes inherited
   mappers. The Phase B layout that worked in the probe:
   - the app `tsconfig.json` declares the mapper, includes the `.jsails`
     files, and keeps `rootDirs` and `allowArbitraryExtensions`, but does not
     include `.jsails/sfc/**`. Under 7.1 the mapper wins resolution; under
     TS 6 (typescript-eslint) a `.ts` file's `.jsails` import still resolves
     through the bridge, so typed lint of `.ts` files keeps working;
   - `jsails sync` writes `.jsails/sfc/tsconfig.json`, which extends the app
     tsconfig, sets `"contentMappers": null` and includes the shadows plus the
     app's TypeScript files. `projectService` picks it for every shadow,
     because it is the nearest `tsconfig.json`.

**Go/no-go.** Go for SFC-15's design: the transport is a thin layer over the
span table, and the diagnostics already agree. No-go for shipping before 7.1
is stable; the protocol has no stability promise while it is in beta. When
7.1 ships, SFC-15 re-runs this probe against the release before it bumps
`@typescript/native`.

## 7. Q5 — The TS 7 VS Code extension and `.jsails`

### 7.1 Evidence

From `TypeScriptTeam.native-preview` 1.0.2 (its `package.json` and bundled
client code):

- Its base document selector is the four language ids `typescript`,
  `typescriptreact`, `javascript` and `javascriptreact`, and it activates only
  on those (`onLanguage:*`).
- Content-mapped files are matched **by file pattern**, not language id. When
  a project with `contentMappers` loads, the 7.1 server sends
  `client/registerCapability` with ids prefixed `content-mapper-` and
  `documentSelector: [{ "pattern": "**/*.jsails" }]` for `didOpen`,
  `didChange` and `didClose` (observed in the LSP probe after a `.ts` file
  opened). The extension adds those patterns to its selector.
- It exports `registerContentMappers(contributorId, [{ extensions,
  inferredProjectContribution? }])` for other extensions (the same interface
  ships as `typescript/vscode` in 7.1). It rejects extensions that end in a
  built-in one; `.jsails` is accepted. A registration also re-sends the
  `.jsails` documents that are already open.
- `js/ts.contentMappers.enabled` (default `true`) becomes the server's
  `initializationOptions.runExternalCode`.
- The extension bundles TypeScript 7.0.2, so content mappers need the
  workspace's TypeScript (7.1 or later) to be selected.

### 7.2 Decision

The language id does not matter to the TypeScript side, so `.jsails` keeps its
own `jsails` language for highlighting. Because the TS 7 extension does not
activate on a `.jsails` file alone, `editors/vscode` (SFC-06; content mapper
wiring in SFC-15):

- contributes the `jsails` language (extension `.jsails`) and the TextMate
  grammar;
- declares `extensionDependencies: ["TypeScriptTeam.native-preview"]` and
  activates on `onLanguage:jsails`;
- on activation, once TypeScript 7.1 or later is available, calls
  `registerContentMappers('jsails', [{ extensions: ['.jsails'] }])`, which
  starts the TypeScript server and attaches the open `.jsails` documents.

Svelte needed a change in the TypeScript extension for the same problem
(sfc-plan §8, risk 3). Here the extension point already exists, so that risk
is retired.

## 8. Q6 — oxc `transformSync`

### 8.1 Evidence

`transformSync` from `rolldown/utils` (1.2.15), on the view's shadow, with
`lang: 'tsx'`, `jsx: { runtime: 'automatic', importSource: 'jsails' }`,
`sourcemap: true` and `typescript: { declaration: {} }`:

- The output imports `jsx`/`jsxs` from `jsails/jsx-runtime` and has no
  errors.
- `declaration` holds the `.d.ts`, keeping `import type` and the explicit
  return type:
  `export default function Card(__props: { title: string; }): ComponentChild;`.
- Without explicit return types the result has
  `TS9007 Function must have an explicit return type annotation with
  --isolatedDeclarations` errors, no declaration, **and no JavaScript**: `code`
  is `''`. That holds for any exported function, an author's `<script>` helper
  (`export function helper(x: number) { … }`) as much as the generated
  component. The same input without the `declaration` option compiles with no
  error. sfc-plan's "explicit return types on generated functions" is
  therefore a hard requirement, not a style, and requesting declarations
  makes every author export subject to isolated declarations.
- A syntax error is **returned** in `errors` (with `pos` and `loc`), and
  `code` is `''`. Nothing throws. A syntax error and a declaration error look
  alike: both have `code: 'PARSE_ERROR'` and `kind: 'PARSE_ERROR'`; only the
  message tells them apart (`[PARSE_ERROR] TS9007: …` against
  ``[PARSE_ERROR] Expected `)` but found `EOF` ``). Each error's `message`
  contains ANSI colour codes and a rendered code frame that quotes the
  source.
- Cost: 200 transforms of the view's shadow took 12.5 ms, about 0.06 ms each.
- **Map composition.** The typed option `typescript.inputMap` is ignored: the
  output map still names the shadow. An untyped top-level `inputMap` is what
  rolldown's wrapper actually collapses with the output map (it calls the
  binding's `collapseSourcemaps`), and it throws `ArrayExpected` when that map
  has `sourcesContent: null`. The types and the implementation disagree in
  1.2.15.
- oxc leaves import specifiers alone: `'../ui/card.jsails'` stays as it is.

### 8.2 Decisions

- `compileSfc` composes the maps itself: for each oxc mapping it looks up the
  shadow offset in the span table. It does not use an untyped option, and it
  does not depend on a rolldown fix. That is a small function in SFC-02's
  segment module, and SFC-04 uses it.
- `compileSfc` (apps, `{ js, map }`, sfc-plan §3.1) never passes
  `typescript.declaration`, so an author's untyped export never costs the
  build its JavaScript. Only SFC-18's `compileSfcPackage` requests
  declarations. There, every export of a package `.jsails` needs explicit
  types, the rule the repo's `isolated-declarations` gate already holds for
  `.ts` sources, and a declaration error is an author error positioned in the
  `<script>` Verbatim segment, or `sfc_internal` when it lands in generated
  code.
- oxc errors are converted to a positioned `CompilerError` through the span
  table, from `pos` and one token of the message: after removing ANSI codes,
  a leading `TSnnnn` on the first line marks a declaration error; anything
  else is a syntax error. The `message` is never copied into a JSails error:
  it echoes source text, and JSails errors are value-free.
- In the compiled-fixture harness (SFC-04), where modules are written without
  a bundler, the lowering rewrites relative `.jsails` specifiers to `.js` as
  Atom segments. In the one build (SFC-10), resolution belongs to the bundler.

## 9. Corrections to `sfc-plan.md`

Each item names the plan text, the contradicting evidence, and the proposed
replacement.

1. **§0.1, row "TS 7.0.2 resolves `import X from './card.jsails'` to a
   `rootDirs` sidecar under NodeNext".** True only in CommonJS mode (§3.1).
   Replace the result with: "true through a bridge: in ESM mode only
   `card.d.jsails.ts` is looked up, so each shadow `card.jsails.tsx` gets a
   re-export bridge `card.d.jsails.ts` and the app sets
   `allowArbitraryExtensions` (docs/design/sfc.md §3)".
2. **§3.5, Phase A.** Replace "`jsails sync` writes
   `.jsails/sfc/<rel>.jsails.tsx` plus `<rel>.jsails.map.json`" with "…plus
   `<rel>.jsails.map.json` and the bridge `<rel>.d.jsails.ts`", and add
   `"allowArbitraryExtensions": true` to the app tsconfig line.
3. **§2.5, "How the rewrite works".** "The `__props.page` part is an Alias
   segment" becomes "the property name after `__props.` is an Alias segment",
   and add: "each lowered attribute name is an Alias to its source name"
   (§3.3, rules 1 and 2).
4. **§3.1 and §3.5, gap handling.** "gap diagnostics map to the owning
   template node" becomes a property of the segment list: every generated
   chunk inside a render function is an Atom span owned by its template node.
   Only the module header and footer are unmapped, and any diagnostic there
   is `sfc_internal`. Generated declarations a caller can reach get an Atom
   (§3.3 rule 3, §6.3 items 1 and 2). SFC-02's property test "no mapping
   overlaps" stays; the Atoms cover only gap chunks.
5. **§2.1, `<script>` and `<script setup>` rows.** "`lang="ts"` (default;
   …)" becomes "`lang="ts"`, required: a missing `lang` is
   `sfc.script_lang_required` with a fix-it; any other value is
   `sfc.unsupported_lang`" (§5.2).
6. **§2.4, `js-pre`.** "raw subtree, byte-exact" stays, and gains: "the
   element must be preceded by `<!-- prettier-ignore -->`
   (`sfc.js_pre_needs_prettier_ignore`, with a fix-it), because Prettier
   reformats `{{ }}` and bound attributes inside it" (§5.2). SFC-01 owns the
   check.
7. **§0.1, Prettier row.** Add: "it does not format a `<script>` without
   `lang="ts"`, keeps invalid expressions verbatim without an error, knows
   neither `js-pre` nor `v-pre`, and adds or removes whitespace wherever its
   display table makes it insignificant".
8. **§0.1, oxc row, §3.1 `compileSfc`, and SFC-18.** Add: "the typed
   `typescript.inputMap` is ignored in rolldown 1.2.15, so `compileSfc`
   composes the oxc map with the span table itself; a declaration error
   discards the JavaScript, so `compileSfc` never requests declarations and
   only `compileSfcPackage` does, where every export of a package `.jsails`
   needs explicit types; oxc errors are read by `pos` and their `TSnnnn`
   token, never copied" (§8.2).
9. **§3.5, Phase B, and SFC-15.** "Sidecars stay for typed lint" becomes the
   two-tsconfig layout of §6.3 item 5: the app tsconfig declares the mapper
   and keeps `rootDirs`/`allowArbitraryExtensions` without including shadows,
   and `jsails sync` writes `.jsails/sfc/tsconfig.json` with
   `"contentMappers": null`. `typescript.contentMapper` in `@jsails/dev`'s
   manifest declares `dynamicConfig` only if options affect the transform.
   The language server needs `initializationOptions.runExternalCode` (VS Code:
   `js/ts.contentMappers.enabled`).
10. **§3.6, lint.** "un-ignores `**/.jsails/sfc/**/*.jsails.tsx`" becomes:
    the global ignore `**/.jsails/**` is replaced by
    `['**/.jsails/*', '!**/.jsails/sfc/', '**/*.d.jsails.ts']`, which also
    ignores the bridges; typed lint
    runs only on files that typecheck; and the emitter writes `async` only
    when setup awaits (§4.2).
11. **§2.4, text and whitespace, and SFC-06's exit.** "Whitespace follows
    Vue 3's `condense` rule exactly, because Prettier's `vue` printer assumes
    it" is false (§5.1, the **changes output** rows). Replace it with the
    rule in §5.2, Prettier's own significance classification. SFC-01 embeds
    Prettier's default-display table, and a test pins it to the installed
    Prettier. SFC-06's "renders identical HTML" check is what catches drift;
    its corpus includes every §5.1 whitespace row.
12. **§8, risk 3.** Retired: the extension matches content-mapped files by
    pattern and exports `registerContentMappers` (§7). Replace the mitigation
    with the activation rule of §7.2.
13. **SFC-00 itself (§4).** Its "Owns" and exit list
    `core/test/compiler/sfc/fixtures/toolchain/**` and `toolchain.test.ts`.
    That directory cannot exist while `core/test/compiler/sfc.test.ts` does
    (`src-structure`: a test file beside a same-named directory), and SFC-01
    deletes that file. The regression fixtures therefore move to the packages
    that own each subject (§10). This record is SFC-00's deliverable.

## 10. Regression probes that later packages commit

Each probe above becomes a test in the package that owns its subject. None of
them needs the network or a TypeScript version outside the lockfile, except
the 7.1 ones, which SFC-15 runs against the 7.1 it adopts.

| Probe | Test | Owner |
|---|---|---|
| §3: shadow pair, bridge, ESM resolution from `.ts` and from another shadow, planted Verbatim/Alias/Atom diagnostics, footer as `sfc_internal` | `core/test/compiler/sfc/toolchain.test.ts` with fixtures under `core/test/compiler/sfc/fixtures/toolchain/` | SFC-04 (sidecar and remap library); the directory exists once SFC-01 has deleted `core/test/compiler/sfc.test.ts` |
| §3.3 rules 1–3 and §6.3 items 1–2 as segment properties | `core/test/compiler/sfc/segments.test.ts` | SFC-02 |
| §4: typed lint on a shadow, remapped; ignore pattern; no `async` without `await` | the `sfc-lint` gate test | SFC-11 |
| §5: the format corpus, including `lang="ts"`, `<template static>`, `js-pre` with `<!-- prettier-ignore -->` holding `{{a+b}}`, and every §5.1 whitespace row, each rendering identical HTML before and after formatting | `scripts/test/sfc-format.test.mjs` | SFC-06 |
| §5.2: the whitespace rule and its display table, pinned to Prettier's | `core/test/compiler/sfc/template-parse.test.ts` | SFC-01 |
| §5.2: `sfc.script_lang_required` and `sfc.js_pre_needs_prettier_ignore` | `core/test/compiler/sfc/blocks.test.ts`, `template-parse.test.ts` | SFC-01 |
| §8: JSX automatic runtime, composed map, no declaration request, syntax error by `pos` | `compileSfc` tests | SFC-04 |
| §8: declarations, an untyped `<script>` export as a positioned author error, the `TSnnnn` classification | `compileSfcPackage` tests | SFC-18 |
| §6: mapper handshake, diagnostic equality with Phase A, LSP hover and definition | content-mapper tests | SFC-15 |
| §7: activation and `registerContentMappers` | `editors/vscode` | SFC-06, SFC-15 |

Windows was not probed. The bridge, `rootDirs` and the mapper's `exec` are
path-agnostic, and TypeScript prints `/` separators. The SFC-04 and SFC-15
tests run on the Windows CI leg like every other test.

## Appendix A — The probe content mapper

The package's `package.json`:

```json
{ "name": "jsails-cm-probe", "version": "0.0.0", "type": "module",
  "typescript": { "contentMapper": { "exec": ["node", "server.mjs"] } } }
```

`server.mjs`. For the probe it read the Phase A shadow and span table from
disk; SFC-15's version calls `lowerSfc` on `params.content` instead. It
answers every message, which was enough for `tsc`; SFC-15's version must not
reply to a notification (a message without `id`), as JSON-RPC requires:

```js
import { readFileSync } from 'node:fs';
import { dirname, relative, join } from 'node:path';
const KIND = { verbatim: 0, atom: 1, alias: 2 }, ALL = (1 << 20) - 1;
let input = Buffer.alloc(0); const roots = new Map();
const handlers = {
  initialize: () => ({ positionEncoding: 'utf-16', diagnosticSource: 'jsails' }),
  openProject: (p) => { roots.set(p.projectHandle, dirname(p.configFileName)); return {}; },
  closeProject: (p) => { roots.delete(p.projectHandle); return null; },
  transform: (p) => {
    const root = roots.get(p.projectHandle), rel = relative(root, p.fileName).replaceAll('\\', '/');
    const base = join(root, 'lowered/sfc', rel);
    const { spans } = JSON.parse(readFileSync(base + '.map.json', 'utf8'));
    return { text: readFileSync(base + '.tsx', 'utf8'), extension: '.tsx',
      mappings: spans.map(([g, gl, s, sl, k]) => [g, gl, s, sl, KIND[k], ALL]) };
  },
};
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const h = input.indexOf('\r\n\r\n'); if (h < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0, h).toString('ascii'))[1]);
    if (input.length < h + 4 + len) return;
    const msg = JSON.parse(input.subarray(h + 4, h + 4 + len).toString('utf8'));
    input = input.subarray(h + 4 + len);
    let reply;
    try { reply = { jsonrpc: '2.0', id: msg.id, result: handlers[msg.method](msg.params) }; }
    catch { reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'jsails_mapper_failed' } }; }
    const body = Buffer.from(JSON.stringify(reply));
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  }
});
```

## Appendix B — Reproducing the probes

The probes ran in a scratch directory outside the repository, against the
checkout's `node_modules`. The fixture app had `"type": "module"`,
`node_modules/jsails` linked to `core/`, and `preact` linked from the root.
The commands, from the fixture root:

- Q1: `node_modules/.bin/tsc -p . --pretty false` (add `--traceResolution` or
  `--explainFiles` for §3.1), then remap each `.jsails/sfc/` position through
  its `.map.json`. Editor: `@typescript/typescript-linux-x64/lib/tsc --lsp
  --stdio` with `initialize`, `didOpen`, then `textDocument/definition` and
  `textDocument/hover`.
- Q2: the ESLint API (`eslint/lib/api.js`) with
  `tseslint.configs.recommendedTypeChecked` and
  `parserOptions: { projectService: true, tsconfigRootDir }`.
- Q3: `prettier.format(source, { ...repoOptions, parser: 'vue' })`, run twice.
- Q4: `npm pack @typescript/typescript-linux-x64@7.1.0-beta` into an empty
  directory; `lib/tsc -p . --runExternalCode --noEmit --pretty false`; the LSP
  probe passes `initializationOptions: { runExternalCode: true }`.
- Q5: the VSIX from the Marketplace gallery, unzipped; read `package.json` and
  `dist/extension.bundle.js`.
- Q6: `transformSync` from `rolldown/utils`, resolved from `core/package.json`.
