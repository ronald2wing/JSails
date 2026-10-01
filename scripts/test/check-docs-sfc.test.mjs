/**
 * The docs compile gate's ` ```jsails ` fences (`website/scripts/docs-sfc.mjs`
 * through `checkDocs`): each fence lowers at its path with the build's
 * compiler, type-checks through its sidecars, and every problem is reported
 * at the doc's own line and column; the fences of one document are one app;
 * a position the compiler cannot map, and the compiler's own bug diagnostic
 * (`sfc.internal`), are errors no ledger excuses; and every fence of the
 * components reference compiles.
 *
 * It reads core's build, as every CI leg, `npm test` and `npm run check`
 * build before the tooling tests.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { checkDocs } from '../../website/scripts/check-docs.mjs';
import { checkSfcGroup, SFC_COMPILER } from '../../website/scripts/docs-sfc.mjs';
import { repoRoot } from '../workspaces.mjs';

const FENCE = '```';
const COMPONENTS = 'website/content/docs/components.md';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-sfc-test-'));
  roots.push(root);
  return root;
}

before(() => {
  if (!existsSync(join(repoRoot, ...SFC_COMPILER, 'lower.js'))) {
    throw new Error('check-docs-sfc reads core/dist: run npm run build first');
  }
});

/**
 * `checkDocs` over `pages` (`{ name: lines }`) with the checkout's packages,
 * stub metadata, and no fixtures preamble (the real one needs real metadata).
 */
function check(pages, extra = {}) {
  const dir = scratch();
  return checkDocs({
    repoRoot,
    documents: Object.entries(pages).map(([name, lines]) => ({
      source: `website/content/docs/${name}`,
      text: lines.join('\n'),
      page: true,
    })),
    generateMeta: false,
    fixturesFile: join(dir, 'no-fixtures.d.ts'),
    entries: [],
    exemptions: new Map(),
    tempDir: dir,
    ...extra,
  });
}

const where = (findings) => findings.map((finding) => [finding.where, finding.id]);

describe('the docs jsails fences', () => {
  it('reports a template typo at its doc line and column, as TypeScript reports it', async () => {
    const { findings, errors, stats } = await check({
      'views.md': [
        '# Views',
        '',
        `${FENCE}jsails path=ui/card.jsails`,
        '<script setup lang="ts">',
        'defineProps<{ title: string }>();',
        '</script>',
        '',
        '<template>',
        '  <h2>{{ titel }}</h2>',
        '</template>',
        FENCE,
      ],
    });
    assert.deepEqual(errors, []);
    assert.equal(stats.jsails, 1);
    assert.deepEqual(where(findings), [
      [
        'website/content/docs/views.md:9:10',
        "website/content/docs/views.md#views[1] TS2339: Property 'titel' does not exist on type '{ title: string; }'.",
      ],
    ]);
  });

  it("reports the compiler's diagnostics at their doc lines, warnings included", async () => {
    const { findings, errors } = await check({
      'views.md': [
        '# Views',
        '',
        'A fence without a path is a view.',
        '',
        `${FENCE}jsails`,
        '<template>',
        '  <button @click="count++">Add</button>',
        '</template>',
        FENCE,
        '',
        '## Lists',
        '',
        `${FENCE}jsails path=ui/list.jsails`,
        '<script setup lang="ts">',
        'defineProps<{ items: string[] }>();',
        '</script>',
        '',
        '<template>',
        '  <ul><li js-for="item in items">{{ item }}</li></ul>',
        '</template>',
        FENCE,
      ],
    });
    assert.deepEqual(errors, []);
    const codes = findings.map((finding) => [finding.where, finding.id.split(' ')[1]]);
    assert.deepEqual(codes, [
      ['website/content/docs/views.md:19:11', 'sfc.for_without_key:'],
      ['website/content/docs/views.md:7:11', 'sfc.event_without_client:'],
    ]);
    assert.match(findings[0].message, /^sfc\.for_without_key \(warning\): /);
  });

  it('compiles the fences of one document as one app, and each document as its own', async () => {
    const island = [
      `${FENCE}jsails path=islands/counter.jsails`,
      '<script setup lang="ts">',
      "import { useSignal } from '@preact/signals';",
      '',
      'const { start } = defineProps<{ start: number }>();',
      'const count = useSignal(start);',
      '</script>',
      '',
      '<template>',
      '  <button type="button" @click="count.value += 1">{{ count.value }}</button>',
      '</template>',
      FENCE,
    ];
    const mount = (start) => [
      `${FENCE}jsails path=pages/index.jsails`,
      '<script setup lang="ts">',
      "import Counter from '../islands/counter.jsails';",
      '</script>',
      '',
      '<template>',
      `  <Counter :start="${start}" />`,
      '</template>',
      FENCE,
    ];
    const { findings, errors } = await check({
      'islands.md': ['# Islands', '', ...island, '', ...mount('0')],
      'mounts.md': ['# Mounts', '', ...mount('0')],
      'typed.md': ['# Typed', '', ...island, '', ...mount("'zero'")],
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      findings.map((finding) => [finding.where, finding.message.split(':')[0]]),
      [
        // The island is not on this page, so its import does not resolve.
        ['website/content/docs/mounts.md:5:21', 'TS2307'],
        ['website/content/docs/typed.md:22:13', 'TS2322'],
      ],
    );
  });

  it('refuses a path named twice on one page, and attributes a jsails fence does not take', async () => {
    const { errors } = await check({
      'twice.md': [
        '# Twice',
        '',
        `${FENCE}jsails path=ui/card.jsails`,
        '<template><p>one</p></template>',
        FENCE,
        '',
        `${FENCE}jsails path=ui/card.jsails`,
        '<template><p>two</p></template>',
        FENCE,
        '',
        `${FENCE}jsails fragment`,
        '<template><p>three</p></template>',
        FENCE,
      ],
    });
    assert.deepEqual(errors, [
      'website/content/docs/twice.md:11: fragment belongs to ts, tsx and js fences only',
      'website/content/docs/twice.md:7: this jsails fence and the one at line 3 both stand for ui/card.jsails',
    ]);
  });

  it('counts the imports of a clean jsails fence as documenting a published entry', async () => {
    const page = (template) => [
      '# Views',
      '',
      `${FENCE}jsails path=ui/note.jsails`,
      '<script setup lang="ts">',
      "import type { ComponentChild } from 'jsails/view';",
      '',
      'const { body } = defineProps<{ body: ComponentChild }>();',
      '</script>',
      '',
      `<template>${template}</template>`,
      FENCE,
    ];
    const entry = 'entry jsails/view: no compiled docs sample imports it';
    const clean = await check(
      { 'views.md': page('<p>{{ body }}</p>') },
      { entries: ['jsails/view'] },
    );
    assert.deepEqual(clean.errors, []);
    assert.deepEqual(clean.findings, []);
    const broken = await check(
      { 'views.md': page('<p>{{ bodi }}</p>') },
      { entries: ['jsails/view'] },
    );
    assert.ok(broken.findings.some((finding) => finding.id === entry));
  });

  it('compiles every fence of the components reference with no finding', async () => {
    const text = readFileSync(join(repoRoot, COMPONENTS), 'utf8');
    const { findings, errors, stats } = await checkDocs({
      repoRoot,
      documents: [{ source: COMPONENTS, text, page: true }],
      entries: [],
      exemptions: new Map(),
      tempDir: scratch(),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(where(findings), []);
    assert.equal(stats.noCheck, 0);
    assert.ok(stats.jsails >= 10, 'the reference shows the format in checked samples');
  });
});

describe('checkSfcGroup', () => {
  /**
   * A compiler that lowers every fence to a shadow, compiles it with the
   * diagnostics `compiled`, and remaps to `entries`.
   */
  const fakeCompiler = (entries, compiled = []) => ({
    lowerSfc: (_body, file) => ({ file, shadow: {} }),
    compileSfc: () => ({ diagnostics: compiled }),
    writeSidecars: () => undefined,
    shadowPath: (file) => `.jsails/sfc/${file}.tsx`,
    remapTscOutput: () => entries,
    resolver: undefined,
    lineIndex: () => ({ positionAt: () => ({ line: 0, column: 0 }) }),
  });

  const fence = {
    source: 'website/content/docs/views.md',
    line: 10,
    path: 'ui/card.jsails',
    body: '<template />',
    mapLine: (line) => line,
  };

  it('fails on code the compiler generated that does not check, and on other files', async () => {
    const dir = scratch();
    const tsc = join(dir, 'tsc.mjs');
    writeFileSync(tsc, '');
    const position = { line: 1, column: 1 };
    const { located, errors } = await checkSfcGroup({
      compiler: fakeCompiler([
        { origin: 'internal', file: 'ui/card.jsails', position: null, code: 2322, message: 'm' },
        { origin: 'file', file: 'shared/x.ts', position, code: 2304, message: 'n' },
        { origin: 'source', file: 'ui/card.jsails', position, code: 2339, message: 'o' },
        {
          origin: 'generated',
          file: 'ui/card.jsails',
          position,
          code: 2322,
          message: 'p',
          generatedFor: '<li>',
        },
      ]),
      fences: [fence],
      dir: join(dir, 'g01'),
      options: {},
      support: [],
      tsc,
      projectError: (file, at, message) => `outside: ${file} ${at?.line} ${message}`,
    });
    assert.deepEqual(errors, [
      'website/content/docs/views.md:10: the compiler generated code for path=ui/card.jsails that does not check (a compiler bug): TS2322: m',
      'outside: shared/x.ts 1 TS2304: n',
    ]);
    assert.deepEqual(
      located.map((entry) => [entry.origin, entry.code, entry.generatedFor]),
      [
        ['tsc', 2339, undefined],
        ['tsc', 2322, '<li>'],
      ],
    );
  });

  it("fails on the compiler's own bug diagnostic, and locates its other ones", async () => {
    const dir = scratch();
    const tsc = join(dir, 'tsc.mjs');
    writeFileSync(tsc, '');
    const diagnostic = (code, message, severity) => ({ code, message, severity, start: 0 });
    const { located, errors } = await checkSfcGroup({
      compiler: fakeCompiler(
        [],
        [
          diagnostic('sfc.internal', 'The compiler generated code it cannot compile', 'error'),
          diagnostic('sfc.compile_error', 'The template does not compile', 'error'),
          diagnostic('sfc.for_without_key', 'A js-for has no :key', 'warning'),
        ],
      ),
      fences: [fence],
      dir: join(dir, 'g01'),
      options: {},
      support: [],
      tsc,
      projectError: () => assert.fail('no project file is involved'),
    });
    assert.deepEqual(errors, [
      'website/content/docs/views.md:10: the compiler failed on path=ui/card.jsails (a compiler bug): sfc.internal: The compiler generated code it cannot compile',
    ]);
    assert.deepEqual(
      located.map((entry) => [entry.origin, entry.code, entry.severity, entry.line, entry.column]),
      [
        ['sfc', 'sfc.compile_error', 'error', 1, 1],
        ['sfc', 'sfc.for_without_key', 'warning', 1, 1],
      ],
    );
  });
});
