/**
 * Tests for the bundle-size gate (`scripts/bundle-size/`, gate
 * `bundle-size`): fixtures are bundled with Rolldown, split into initial and
 * lazy gzip sizes deterministically, and an over-budget bundle fails.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  compare,
  fixtureFiles,
  loadRolldown,
  lowerBudget,
  measureAll,
  measureFixture,
} from '../bundle-size/index.mjs';
import { repoRoot } from '../workspaces.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-bundle-size-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Text gzip cannot shrink much: a pseudo-random string of `length` characters. */
function noise(length, seed = 7) {
  let state = seed;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += String.fromCharCode(97 + (state % 26));
  }
  return text;
}

const { rolldown } = await loadRolldown();

describe('measureFixture', () => {
  it('splits initial and lazy chunks, and is deterministic', async () => {
    const root = fixture({
      'entry.mjs':
        "import { small } from './small.mjs';\nexport const go = () => import('./lazy.mjs');\nexport { small };\n",
      'small.mjs': "export const small = 'small';\n",
      'lazy.mjs': `export const big = '${noise(4000)}';\n`,
    });
    const first = await measureFixture(rolldown, join(root, 'entry.mjs'), { cwd: root });
    const second = await measureFixture(rolldown, join(root, 'entry.mjs'), { cwd: root });
    assert.deepEqual(first, second);
    assert.ok(first.initial > 0 && first.initial < 200, `initial ${first.initial}`);
    assert.ok(first.lazy > 2000, `lazy ${first.lazy}`);
    assert.deepEqual(
      first.chunks.map((chunk) => [chunk.file, chunk.initial]),
      [
        ['entry.js', true],
        ['lazy.js', false],
      ],
    );
  });

  it('never makes a lazy chunk import the entry, and counts what they share as initial', async () => {
    const shared = noise(1500, 11);
    const root = fixture({
      'entry.mjs':
        "import { shared } from './shared.mjs';\nconsole.log(shared);\nimport('./lazy.mjs').then((lazy) => console.log(lazy.big));\n",
      'shared.mjs': `export const shared = '${shared}';\n`,
      'lazy.mjs': `import { shared } from './shared.mjs';\nexport const big = shared + '${noise(4000)}';\n`,
    });
    const measured = await measureFixture(rolldown, join(root, 'entry.mjs'), { cwd: root });
    assert.deepEqual(
      measured.chunks.map((chunk) => [chunk.file, chunk.initial]),
      [
        ['entry.js', true],
        ['lazy.js', false],
        ['shared.js', true],
      ],
    );
    assert.ok(measured.initial > 800, `the shared module is initial: ${measured.initial}`);
  });

  it('fails an over-budget bundle', async () => {
    const root = fixture({
      'fixtures/app.mjs': "export const app = 'app';\n",
    });
    const before = await measureAll({ root: repoRoot, dir: join(root, 'fixtures') });
    const budget = lowerBudget({ fixtures: {} }, before, 'v26.0.0');
    assert.deepEqual(compare(before.sizes, budget), { failures: [], notes: [] });

    writeFileSync(join(root, 'fixtures', 'app.mjs'), `export const app = '${noise(3000)}';\n`);
    const after = await measureAll({ root: repoRoot, dir: join(root, 'fixtures') });
    const { failures } = compare(after.sizes, budget);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^app: initial chunks are \d+ B gzip, above the budget of \d+ B/);
  });
});

describe('budgets', () => {
  it('fail a fixture without a budget and a budget without a fixture, and note shrinkage', () => {
    const { failures, notes } = compare(
      { a: { initial: 5, lazy: 0 }, b: { initial: 1, lazy: 1 } },
      { fixtures: { b: { initial: 2, lazy: 1 }, gone: { initial: 1, lazy: 1 } } },
    );
    assert.match(failures[0], /^a: no budget/);
    assert.match(failures[1], /^gone has a budget but no fixture/);
    assert.match(notes[0], /^b: initial chunks are 1 B gzip, below the budget of 2 B/);
  });

  it('record new fixtures and only lower existing ones', () => {
    assert.deepEqual(
      lowerBudget(
        { fixtures: { a: { initial: 10, lazy: 5 } } },
        { rolldown: '1.0.0', sizes: { a: { initial: 12, lazy: 4 }, b: { initial: 3, lazy: 0 } } },
        'v26.0.0',
      ),
      {
        node: 'v26.0.0',
        rolldown: '1.0.0',
        fixtures: { a: { initial: 10, lazy: 4 }, b: { initial: 3, lazy: 0 } },
      },
    );
  });

  it('lists the committed fixtures', () => {
    assert.ok(fixtureFiles().some((entry) => entry.name === 'island'));
  });
});
