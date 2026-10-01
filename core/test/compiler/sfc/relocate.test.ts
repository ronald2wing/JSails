/**
 * Specifier relocation (`relocate.ts`): every literal specifier form is
 * found, a relative specifier is rewritten to name the same file from its
 * new place (through the files that move with it), a package specifier is
 * left alone, and a normalized specifier survives a move and its reverse
 * byte for byte.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { parseSync } from 'rolldown/utils';

import {
  applyTextEdits,
  relocateSpecifier,
  relocationEdits,
  resolveSpecifier,
  specifierFor,
  specifierLiterals,
} from '../../../src/compiler/sfc/relocate.js';
import { forEachSeed } from '../../../src/testing/seeded-random.js';

describe('specifierLiterals', () => {
  it('finds every literal specifier form, and no computed one', () => {
    const code = [
      "import a from './a.js';",
      "import type { B } from '../b.js';",
      "export { c } from './c.js';",
      "export * from './d.js';",
      "const e = await import('./e.js');",
      "type F = typeof import('./f.js');",
      "import g = require('./g.js');",
      'const h = await import(`./${name}.js`);',
      "const i = 'not-a-specifier';",
    ].join('\n');
    const { program } = parseSync('m.ts', code, { lang: 'ts', sourceType: 'module' });
    assert.deepEqual(
      specifierLiterals(program).map((literal) => literal.value),
      ['./a.js', '../b.js', './c.js', './d.js', './e.js', './f.js', './g.js'],
    );
  });
});

describe('resolveSpecifier and specifierFor', () => {
  it('resolve against the importing file and write the shortest relative path back', () => {
    assert.equal(resolveSpecifier('pages/blog/[slug].jsails', '../../shared/a.js'), 'shared/a.js');
    assert.equal(resolveSpecifier('x.jsails', '../outside/a.js'), '../outside/a.js');
    assert.equal(resolveSpecifier('pages/a.ts', './b/../c.js'), 'pages/c.js');
    assert.equal(specifierFor('pages/blog/x/x.ts', 'shared/a.js'), '../../../shared/a.js');
    assert.equal(specifierFor('pages/x.jsails', 'pages/x/y.js'), './x/y.js');
    assert.equal(specifierFor('x.jsails', '../outside/a.js'), '../outside/a.js');
    assert.equal(specifierFor('pages/x/x.ts', 'pages'), '..');
    assert.equal(specifierFor('pages/x.ts', 'pages', true), './');
  });
});

describe('relocateSpecifier', () => {
  const toFolder = (path: string): string =>
    path.startsWith('pages/about.server.') ? `pages/about/about.server.${path.slice(19)}` : path;

  it('rewrites a relative specifier for its new place, through the files that move', () => {
    assert.equal(
      relocateSpecifier('../shared/a.js', 'pages/about.jsails', 'pages/about/about.ts'),
      '../../shared/a.js',
    );
    assert.equal(
      relocateSpecifier(
        './about.server.js',
        'pages/about.jsails',
        'pages/about/about.ts',
        toFolder,
      ),
      './about.server.js',
    );
    assert.equal(
      relocateSpecifier('./about.jsails', 'pages/about.jsails', 'pages/about/about.ts'),
      '../about.jsails',
    );
  });

  it('leaves a package specifier, and a specifier whose file does not move, as written', () => {
    assert.equal(relocateSpecifier('zod', 'a/b.ts', 'c/d/e.ts'), 'zod');
    assert.equal(relocateSpecifier('jsails/view', 'a/b.ts', 'c/d/e.ts'), 'jsails/view');
    assert.equal(relocateSpecifier('./x/../y.js', 'pages/a.ts', 'pages/b.ts'), './x/../y.js');
  });

  it('round-trips a normalized specifier through a move and its reverse', async (t: TestContext) => {
    const segments = ['shared', 'ui', 'pages', 'blog', '[slug]', 'deep'];
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 50; round += 1) {
        const pick = (): string => segments[random.int(0, segments.length - 1)] ?? 'a';
        const depth = random.int(0, 3);
        const directory = Array.from({ length: depth }, pick);
        const file = [...directory, 'x.jsails'].join('/');
        const moved = [...directory, 'x', 'x.ts'].join('/');
        const target = [
          ...Array.from({ length: random.int(0, depth + 1) }, () => '..'),
          ...Array.from({ length: random.int(0, 2) }, pick),
          'm.js',
        ].join('/');
        const specifier = specifierFor(file, resolveSpecifier(file, `./${target}`));
        const there = relocateSpecifier(specifier, file, moved);
        assert.equal(resolveSpecifier(moved, there), resolveSpecifier(file, specifier));
        assert.equal(relocateSpecifier(there, moved, file), specifier);
      }
    });
  });
});

describe('relocationEdits', () => {
  it('rewrites only the literals that change, keeping their quotes', () => {
    const code = `import a from "../a.js";\nimport z from 'zod';\nexport * from './b.js';\n`;
    const edits = relocationEdits(code, 'pages/x.jsails', 'pages/x/x.ts');
    assert.ok(edits !== undefined);
    assert.equal(
      applyTextEdits(code, edits),
      `import a from "../../a.js";\nimport z from 'zod';\nexport * from '../b.js';\n`,
    );
  });

  it('is undefined for code that does not parse', () => {
    assert.equal(relocationEdits('import from;', 'a.ts', 'b/c.ts'), undefined);
  });
});
