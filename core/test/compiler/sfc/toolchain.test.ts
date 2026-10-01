/**
 * The Phase A toolchain regression (docs/design/sfc.md §3, §10 row 1), on the
 * real TypeScript 7 compiler: a page and a view lowered to shadows, each with
 * its bridge, type-checked with `rootDirs` and `allowArbitraryExtensions`
 * under NodeNext ESM. A `.ts` file and another shadow both resolve
 * `import … from '…/card.jsails'` through the bridge, with types; each
 * planted fault is reported once, remapped to the exact `.jsails` position
 * (a template expression, an implicit prop, an attribute name, a `js-for`
 * source, a `<script>` line), and faults
 * in a shadow's header and footer are `internal`.
 *
 * The fixtures are strings: a `.ts` file with a planted type error cannot
 * live in `core/test`, which the repository build type-checks.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { nameTable } from '../../../src/compiler/sfc/name-resolver.js';
import {
  assembleShadow,
  atom,
  segmentSource,
  verbatim,
} from '../../../src/compiler/sfc/segments.js';
import { sourceSpan } from '../../../src/compiler/sfc/source-span.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';

const POST = `<script lang="ts">
/** The probe page: a typo, a wrong prop type and a loop over a value that is not a list. */
export function load(): { page: { title: string; date: Date; flag: boolean } } {
  return { page: { title: 'Probe', date: new Date(0), flag: true } };
}
</script>

<template>
  <main>
    <h1>{{ pgae.title }}</h1>
    <p>{{ formatDate(page.date) }}</p>
    <Card :title="42" />
    <ul><li js-for="tag of page.flag" :key="String(tag)">{{ tag }}</li></ul>
  </main>
</template>
`;

const CARD = `<script lang="ts">
/** The probe view: a planted type error in its script. */
const wrong: number = 'x';
export const label: string = String(wrong);
</script>

<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <h2>{{ title }}</h2>
</template>
`;

const FILES = [
  { path: 'pages/post.jsails', source: POST },
  { path: 'ui/card.jsails', source: CARD },
  {
    path: 'shared/format.ts',
    source: 'export function formatDate(date: Date): string {\n  return date.toISOString();\n}\n',
  },
  {
    path: 'pages/index.ts',
    source:
      "import Card, { label } from '../ui/card.jsails';\n\nexport const text: string = label;\nexport const element = Card({ title: 1 });\n",
  },
];

const RESOLVER = nameTable({
  formatDate: { source: { path: 'shared/format.ts' }, export: 'formatDate' },
  Card: { source: { path: 'ui/card.jsails' }, export: 'default' },
});

let app: CompiledFixtureApp | undefined;
after(() => app?.dispose());

function probe(): CompiledFixtureApp {
  app ??= compileFixtureApp(FILES, { resolver: RESOLVER });
  return app;
}

/** The 1-based position of the `nth` occurrence of `needle` in `text`. */
function at(text: string, needle: string, nth = 0): string {
  let offset = -1;
  for (let count = 0; count <= nth; count += 1) offset = text.indexOf(needle, offset + 1);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

describe('the Phase A toolchain on TypeScript 7', () => {
  it('reports every planted fault at its .jsails position, and nothing internal', () => {
    const result = probe().typecheck();
    assert.deepEqual(result.unparsed, []);
    assert.deepEqual(
      result.diagnostics
        .map(
          (entry) =>
            `${entry.origin} ${entry.file}:${entry.position === null ? '-' : `${entry.position.line}:${entry.position.column}`} TS${entry.code}${entry.generatedFor === undefined ? '' : ` ${entry.generatedFor}`}`,
        )
        .sort(),
      [
        `file pages/index.ts:${at(FILES[3]?.source ?? '', 'title: 1')} TS2322`,
        `source pages/post.jsails:${at(POST, 'pgae')} TS2339`,
        `source pages/post.jsails:${at(POST, 'title="42"')} TS2322`,
        `source pages/post.jsails:${at(POST, 'page.flag')} TS2769`,
        `source ui/card.jsails:${at(CARD, 'wrong')} TS2322`,
      ],
    );
    assert.notEqual(result.status, 0);
  });

  it('carries the types of a .jsails module to a .ts importer through the bridge', () => {
    const result = probe().typecheck();
    const index = result.diagnostics.find((entry) => entry.file === 'pages/index.ts');
    assert.match(index?.message ?? '', /'number' is not assignable to type 'string'/);
  });

  it('reports faults in a shadow header and footer as internal', () => {
    const text =
      '<script lang="ts">\n/** A hand-built shadow. */\nexport const value: number = 1;\n</script>\n<template><p></p></template>\n';
    const source = segmentSource('ui/plain.jsails', text);
    const scriptStart = text.indexOf('/**');
    const scriptEnd = text.indexOf('</script>');
    const template = sourceSpan(text.indexOf('<template>'), text.length - 1);
    const shadow = assembleShadow({
      header:
        "import type { NotExported } from 'jsails/view';\nexport type Unused = NotExported;\n",
      body: [
        verbatim(source, sourceSpan(scriptStart, scriptEnd)),
        atom('export default function Plain(): null {\n  return null;\n}\n', source, template),
      ],
      footer: "import './plain.css';\n",
    });
    const result = probe().typecheck([{ file: 'ui/plain.jsails', shadow }]);
    const plain = result.diagnostics.filter((entry) => entry.file === 'ui/plain.jsails');
    assert.ok(plain.length >= 2, 'the header and the footer each fail');
    assert.ok(plain.every((entry) => entry.origin === 'internal' && entry.position === null));
  });
});
