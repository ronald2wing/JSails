/**
 * The two layouts of a `.jsails` component (`layout.ts`): the folder paths
 * of a component path, a split and its join that give back the canonical
 * file byte for byte (the corpora and seeded variants), every refusal with
 * the diagnostics that explain it, the split's position map, and the
 * grouping of a project's paths into components with its layout conflict.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  joinSfc,
  sfcComponents,
  sfcFolderPaths,
  sfcServerPath,
  splitSfc,
  toFolderPaths,
  toSinglePaths,
} from '../../../src/compiler/sfc/layout.js';
import { forEachSeed, type SeededRandom } from '../../../src/testing/seeded-random.js';
import { SFC_CORPUS } from './corpus.js';
import { LIVE_SFC } from './live-corpus.js';

/** `source` split and joined again at the component path `file`. */
function roundTrip(source: string, file: string): string {
  const split = splitSfc(source, file);
  assert.ok(split.ok, `${file} splits`);
  const joined = joinSfc(split.folder, file);
  assert.ok(joined.ok, `${file} joins`);
  return joined.source;
}

describe('folder paths', () => {
  it('name every member after the component, in a folder of its name', () => {
    assert.deepEqual(sfcFolderPaths('pages/blog/[slug].jsails'), {
      template: 'pages/blog/[slug]/[slug].jsails',
      script: 'pages/blog/[slug]/[slug].ts',
      style: 'pages/blog/[slug]/[slug].css',
      scopedStyle: 'pages/blog/[slug]/[slug].scoped.css',
      server: 'pages/blog/[slug]/[slug].server.ts',
    });
    assert.equal(sfcFolderPaths('x.jsails').template, 'x/x.jsails');
    assert.equal(sfcServerPath('ui/card.jsails'), 'ui/card.server.ts');
  });

  it('map the server module between the layouts under each spelling that names it', () => {
    const toFolder = toFolderPaths('ui/card.jsails');
    const toSingle = toSinglePaths('ui/card.jsails');
    for (const spelling of ['.js', '.ts', '']) {
      assert.equal(toFolder(`ui/card.server${spelling}`), `ui/card/card.server${spelling}`);
      assert.equal(toSingle(`ui/card/card.server${spelling}`), `ui/card.server${spelling}`);
    }
    assert.equal(toFolder('ui/card.ts'), 'ui/card.ts');
    assert.equal(toSingle('ui/card/other.js'), 'ui/card/other.js');
  });

  it('map no sibling whose name only starts like the server module', () => {
    const toFolder = toFolderPaths('ui/card.jsails');
    const toSingle = toSinglePaths('ui/card.jsails');
    for (const sibling of ['types.js', 'schema.ts', 'tsx', 'jsx', 'd.ts', 'js.map']) {
      assert.equal(toFolder(`ui/card.server.${sibling}`), `ui/card.server.${sibling}`);
      assert.equal(toSingle(`ui/card/card.server.${sibling}`), `ui/card/card.server.${sibling}`);
    }
  });
});

describe('splitSfc and joinSfc', () => {
  it('give every corpus file back byte for byte', () => {
    for (const { path, source } of [...SFC_CORPUS, ...LIVE_SFC]) {
      assert.equal(roundTrip(source, path), source, path);
    }
  });

  it('move each block body byte for byte, the template file keeping the rest', () => {
    const source = [
      '<!-- the card -->',
      '<script lang="ts">\nimport { a } from \'../shared/a.js\';\nexport const b = a;\n</script>',
      '<script setup lang="ts">\nimport x from \'./x.js\';\n</script>',
      '<template>\n  <p>{{ b }}</p>\n</template>',
      '<style>\np { color: red; }\n</style>',
      '<style scoped>\np { margin: 0; }\n</style>',
    ].join('\n\n');
    const split = splitSfc(`${source}\n`, 'ui/card.jsails');
    assert.ok(split.ok);
    assert.deepEqual(split.folder, {
      template: [
        '<!-- the card -->',
        '<script setup lang="ts">\nimport x from \'../x.js\';\n</script>',
        '<template>\n  <p>{{ b }}</p>\n</template>\n',
      ].join('\n\n'),
      script: "import { a } from '../../shared/a.js';\nexport const b = a;\n",
      style: 'p { color: red; }\n',
      scopedStyle: 'p { margin: 0; }\n',
    });
    assert.equal(roundTrip(`${source}\n`, 'ui/card.jsails'), `${source}\n`);
  });

  it('round-trip seeded canonical files, and reach a fixed point from any block order', async (t: TestContext) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const canonical = randomFile(random, true);
        assert.equal(roundTrip(canonical, 'pages/x.jsails'), canonical, canonical);
        const shuffled = randomFile(random, false);
        const once = roundTrip(shuffled, 'pages/x.jsails');
        assert.equal(roundTrip(once, 'pages/x.jsails'), once, shuffled);
        const first = splitSfc(shuffled, 'pages/x.jsails');
        const second = splitSfc(once, 'pages/x.jsails');
        assert.ok(first.ok && second.ok);
        assert.equal(second.folder.script, first.folder.script);
        assert.equal(second.folder.style, first.folder.style);
        assert.equal(second.folder.scopedStyle, first.folder.scopedStyle);
      }
    });
  });

  it('positions every copied offset in the folder file that holds it', () => {
    const source = SFC_CORPUS.find((file) => file.path === 'pages/blog/[slug].jsails')?.source;
    assert.ok(source !== undefined);
    const split = splitSfc(source, 'pages/blog/[slug].jsails');
    assert.ok(split.ok);
    const texts = new Map<string, string>([
      ['pages/blog/[slug]/[slug].jsails', split.folder.template],
      ['pages/blog/[slug]/[slug].ts', split.folder.script ?? ''],
    ]);
    for (const needle of ['getStaticPaths', '<template>', 'export interface Neighbour']) {
      const offset = source.indexOf(needle);
      const position = split.positionOf(offset);
      assert.ok(position !== undefined, needle);
      const text = texts.get(position.file);
      assert.equal(text?.slice(position.offset, position.offset + needle.length), needle);
    }
    assert.equal(split.positionOf(source.indexOf('<script lang="ts">')), undefined);
  });

  it('refuses a file whose blocks do not scan, whose script does not parse, or with two styles of a kind', () => {
    const refusal = (source: string): string | undefined => {
      const split = splitSfc(source, 'ui/x.jsails');
      return split.ok ? undefined : split.refusal;
    };
    assert.equal(refusal('<template><p></template>\n<script>\nlet\n'), 'invalid_blocks');
    assert.equal(
      refusal('<script lang="ts">\nimport from;\n</script>\n<template><p /></template>\n'),
      'script_syntax',
    );
    assert.equal(
      refusal('<template><p /></template>\n<style>\na{}\n</style>\n<style>\nb{}\n</style>\n'),
      'style_count',
    );
    assert.equal(
      refusal(
        '<template><p /></template>\n<style>\na{}\n</style>\n<style scoped>\nb{}\n</style>\n',
      ),
      undefined,
    );
    const split = splitSfc(
      '<template><p /></template>\n<style>\na{}\n</style>\n<style>\nb{}\n</style>\n',
      'ui/x.jsails',
    );
    assert.ok(!split.ok);
    assert.ok(split.diagnostics.length > 0);
    assert.ok(split.diagnostics.every((entry) => entry.file === 'ui/x.jsails'));
  });

  it('refuses a folder whose template file holds a <script> or <style>, at the start tag', () => {
    const template = '<template><p /></template>\n\n<style>\np {}\n</style>\n';
    const joined = joinSfc({ template }, 'ui/x.jsails');
    assert.ok(!joined.ok);
    assert.equal(joined.refusal, 'folder_block');
    assert.deepEqual(
      joined.diagnostics.map((entry) => [entry.code, entry.file, entry.start, entry.end]),
      [['sfc.folder_block', 'ui/x/x.jsails', 28, 35]],
    );
  });

  it('relocates an import of a sibling named like the server module as the file it is', () => {
    const source =
      "<script lang=\"ts\">\nimport type { T } from './x.server.types.js';\nimport { f } from './x.server.js';\nexport const v: T = f();\n</script>\n\n<template><p>{{ v }}</p></template>\n";
    const split = splitSfc(source, 'components/x.jsails');
    assert.ok(split.ok);
    assert.equal(
      split.folder.script,
      "import type { T } from '../x.server.types.js';\nimport { f } from './x.server.js';\nexport const v: T = f();\n",
    );
    const joined = joinSfc(split.folder, 'components/x.jsails');
    assert.ok(joined.ok);
    assert.equal(joined.source, source);
  });

  it('refuses a folder whose script or style text would end its block in one file', () => {
    const joined = joinSfc(
      {
        template: '<template>\n  <p>{{ html }}</p>\n</template>\n',
        script: "export const html = '<b></b>';\n// end tag: </script>\nexport const n = 1;\n",
        style: 'p { color: red; } /* </style> */\n',
        scopedStyle: 'p { content: "</Style\tx"; }\n',
      },
      'components/x.jsails',
    );
    assert.ok(!joined.ok);
    assert.equal(joined.refusal, 'end_tag');
    assert.deepEqual(
      joined.diagnostics.map((entry) => [entry.code, entry.file, entry.start, entry.end]),
      [
        ['sfc.raw_text_end_tag', 'components/x/x.ts', 43, 51],
        ['sfc.raw_text_end_tag', 'components/x/x.css', 21, 28],
        ['sfc.raw_text_end_tag', 'components/x/x.scoped.css', 14, 21],
      ],
    );
  });

  it('joins text that only resembles an end tag, which splits back unchanged', () => {
    const folder = {
      template: '<template>\n  <p>{{ n }}</p>\n</template>\n',
      script: "export const n = '</scripts>' + '<\\/script>';\n// ends with </script",
      style: 'p { content: "</styles>"; }\n',
    };
    const joined = joinSfc(folder, 'ui/x.jsails');
    assert.ok(joined.ok);
    const split = splitSfc(joined.source, 'ui/x.jsails');
    assert.ok(split.ok);
    assert.deepEqual(split.folder, folder);
  });

  it('join seeded folders to a file that splits back to them, or refuse them', async (t: TestContext) => {
    const fragments = [
      '</script>',
      '</SCRIPT ',
      '</script/',
      '</scripts>',
      '</style>',
      '<\\/script>',
      '</',
    ];
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const pick = (): string => fragments[random.int(0, fragments.length - 1)] ?? '';
        const folder = {
          template: '<template>\n  <p>{{ n }}</p>\n</template>\n',
          script: `export const n = 1;\n// ${pick()}\n`,
          style: `p { color: red; } /* ${pick()} */\n`,
        };
        const joined = joinSfc(folder, 'ui/x.jsails');
        const unsafe =
          /<\/script[\s/>]/i.test(folder.script) || /<\/style[\s/>]/i.test(folder.style);
        if (!joined.ok) {
          assert.equal(joined.refusal, 'end_tag', JSON.stringify(folder));
          assert.ok(unsafe, JSON.stringify(folder));
          continue;
        }
        assert.ok(!unsafe, JSON.stringify(folder));
        const split = splitSfc(joined.source, 'ui/x.jsails');
        assert.ok(split.ok, JSON.stringify(folder));
        assert.deepEqual(split.folder, folder);
      }
    });
  });

  it('refuses a folder whose script does not parse, naming x.ts', () => {
    const joined = joinSfc(
      { template: '<template><p /></template>\n', script: 'import from;\n' },
      'ui/x.jsails',
    );
    assert.ok(!joined.ok);
    assert.equal(joined.refusal, 'script_syntax');
    assert.deepEqual(
      joined.diagnostics.map((entry) => [entry.code, entry.file]),
      [['sfc.script_syntax', 'ui/x/x.ts']],
    );
  });
});

describe('sfcComponents', () => {
  it('groups single files and folders by component path, with their files', () => {
    const index = sfcComponents([
      'pages/about.jsails',
      'pages/about.server.ts',
      'ui/card/card.jsails',
      'ui/card/card.ts',
      'ui/card/card.scoped.css',
      'ui/card/card.server.ts',
      'ui/card/notes.md',
      'ui/menu/menu.ts',
      'shared/posts.ts',
    ]);
    assert.deepEqual(index.diagnostics, []);
    assert.deepEqual(index.components, [
      {
        file: 'pages/about.jsails',
        layout: 'file',
        files: ['pages/about.jsails', 'pages/about.server.ts'],
      },
      {
        file: 'ui/card.jsails',
        layout: 'folder',
        files: [
          'ui/card/card.jsails',
          'ui/card/card.scoped.css',
          'ui/card/card.server.ts',
          'ui/card/card.ts',
        ],
      },
    ]);
  });

  it('leaves out both layouts of a component that has both, reporting the single file', () => {
    const index = sfcComponents(['ui/card.jsails', 'ui/card/card.jsails', 'ui/list.jsails']);
    assert.deepEqual(
      index.components.map((component) => component.file),
      ['ui/list.jsails'],
    );
    assert.deepEqual(
      index.diagnostics.map((entry) => [entry.code, entry.file, entry.start, entry.end]),
      [['sfc.layout_conflict', 'ui/card.jsails', 0, 0]],
    );
  });
});

/** A small `.jsails` file: canonical order and separators, or blocks in any order with any blank lines. */
function randomFile(random: SeededRandom, canonical: boolean): string {
  const chance = (): boolean => random.int(0, 1) === 1;
  const parts: string[] = [];
  if (chance()) parts.push(`<!-- note ${random.int(0, 9)} -->`);
  if (chance()) {
    parts.push(
      `<script lang="ts">\nimport { v${random.int(0, 9)} } from '${chance() ? '../shared' : './local'}/m.js';\nexport const n = 1;\n</script>`,
    );
  }
  if (chance())
    parts.push(`<script setup lang="ts">\nimport w from '../w.js';\nconst k = w;\n</script>`);
  parts.push(`<template>\n  <p>{{ ${chance() ? 'n' : '1'} }}</p>\n</template>`);
  if (chance()) parts.push('<template static>\n  <p>static</p>\n</template>');
  if (chance()) parts.push(`<style>\np { color: #${random.int(100, 999)}; }\n</style>`);
  if (chance()) parts.push('<style scoped>\np { margin: 0; }\n</style>');
  if (canonical) return `${parts.join('\n\n')}\n`;
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    [parts[index], parts[other]] = [parts[other] as string, parts[index] as string];
  }
  const separators = ['\n', '\n\n', '\n\n\n'];
  return (
    parts.reduce(
      (text, part, index) => (index === 0 ? part : `${text}${separators[random.int(0, 2)]}${part}`),
      '',
    ) + (chance() ? '\n' : '')
  );
}
