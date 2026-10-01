/**
 * Tests for the ESLint fragment convention (`scripts/eslint-fragments.mjs`)
 * and the promise-safety fragment (`eslint/promises.mjs`): composition rules,
 * that the repository config applies the fragment to shipped source, and that
 * planted violations fail lint in a minimal type-checked project.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import { composeFragments, loadFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const noop = { create: () => ({}) };

describe('composeFragments', () => {
  it('registers custom and restricted-syntax rules in one plugin', () => {
    const configs = composeFragments([
      { file: 'eslint/a.mjs', configs: [{ files: ['x'] }], rules: { 'rule-a': noop } },
      {
        file: 'eslint/b.mjs',
        configs: [],
        restrictedSyntax: [{ name: 'ban-b', files: ['y'], selector: 'Identifier', message: 'No.' }],
      },
    ]);
    const plugin = configs[0].plugins.jsails;
    assert.deepEqual(Object.keys(plugin.rules).sort(), ['ban-b', 'rule-a']);
    assert.deepEqual(configs.at(-1), { files: ['y'], rules: { 'jsails/ban-b': 'error' } });
  });

  it('refuses a rule name two fragments define', () => {
    assert.throws(
      () =>
        composeFragments([
          { file: 'eslint/a.mjs', configs: [], rules: { same: noop } },
          {
            file: 'eslint/b.mjs',
            configs: [],
            restrictedSyntax: [
              { name: 'same', files: ['y'], selector: 'Identifier', message: 'x' },
            ],
          },
        ]),
      /already defined by another fragment/,
    );
  });

  it('refuses core no-restricted-syntax in a fragment', () => {
    assert.throws(
      () =>
        composeFragments([
          { file: 'eslint/a.mjs', configs: [{ rules: { 'no-restricted-syntax': 'error' } }] },
        ]),
      /restrictedSyntax/,
    );
  });

  it('refuses a ban without files or message', () => {
    assert.throws(
      () =>
        composeFragments([
          {
            file: 'eslint/a.mjs',
            configs: [],
            restrictedSyntax: [{ name: 'x', files: [], selector: 'Identifier', message: 'm' }],
          },
        ]),
      /must name the files/,
    );
  });
});

describe('repository config', () => {
  it('applies the promise rules to every workspace src/ but not to tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const file of ['core/src/server/app.ts', 'packages/live/src/plugin.ts']) {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      assert.deepEqual(rules['@typescript-eslint/no-floating-promises'], [
        2,
        { ignoreVoid: false },
      ]);
      assert.equal(rules['no-void'][0], 2);
      assert.deepEqual(rules['jsails/no-silent-rejection-handler'], [2]);
    }
    const { rules } = await eslint.calculateConfigForFile(join(repoRoot, 'core/test/x.test.ts'));
    assert.deepEqual(rules['@typescript-eslint/no-floating-promises'], [0]);
  });
});

describe('promise fragment on planted code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-lint-plant-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let messages;
  let expected;

  before(async () => {
    mkdirSync(join(dir, 'core', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', noEmit: true },
        include: ['core/src/**/*.ts'],
      }),
    );
    const lines = [
      ['async function work(): Promise<number> { return 1; }'],
      ['declare function detach(p: PromiseLike<unknown>, report: (e: unknown) => void): void;'],
      ['declare function later(callback: () => void): void;'],
      ['declare function mapLater(callback: () => Promise<number | undefined>): void;'],
      ['function noop(): void {}'],
      ['const swallow = (): undefined => undefined;'],
      ['function reportIt(error: unknown): void { console.error(error); }'],
      ['export async function planted(): Promise<void> {'],
      ['  void work();', 'no-void', '@typescript-eslint/no-floating-promises'],
      ['  work();', '@typescript-eslint/no-floating-promises'],
      ['  work().catch(() => {});', 'jsails/no-silent-rejection-handler'],
      ['  work().then(undefined, () => {});', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(function () {});', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => undefined);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => null);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => false);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => ({}));', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => { return undefined; });', 'jsails/no-silent-rejection-handler'],
      ['  await work().catch(() => undefined);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(() => undefined).finally(() => 1);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(noop);', 'jsails/no-silent-rejection-handler'],
      ['  work().catch(swallow);', 'jsails/no-silent-rejection-handler'],
      ['  detach(work(), () => {});', 'jsails/no-silent-rejection-handler'],
      ['  detach(work(), () => undefined);', 'jsails/no-silent-rejection-handler'],
      ['  detach(work(), noop);', 'jsails/no-silent-rejection-handler'],
      ['  later(() => work().catch(() => undefined));', 'jsails/no-silent-rejection-handler'],
      // Allowed from here on.
      ['  work().catch(() => {'],
      ['    // Deliberately ignored: the primary error wins.'],
      ['  });'],
      ['  // Marked handled: dispatch() awaits the same promise and reports it.'],
      ['  work().catch(() => undefined);'],
      ['  const value = await work().catch(() => undefined);'],
      ['  const mapped = work().catch(() => null);'],
      ['  mapLater(() => work().catch(() => undefined));'],
      ['  work().catch(reportIt);'],
      ['  work().catch((error: unknown) => console.error(error));'],
      ['  detach(work(), (error) => console.error(error));'],
      ['  detach(work(), reportIt);'],
      ['  console.log(value, await mapped);'],
      ['}'],
      [''],
    ];
    expected = lines.flatMap(([, ...rules], index) => rules.map((rule) => `${index + 1} ${rule}`));
    const source = lines.map(([text]) => text).join('\n');
    writeFileSync(join(dir, 'core', 'src', 'planted.ts'), source);
    const fragments = await loadFragments(new URL('../../eslint/', import.meta.url));
    const eslint = new ESLint({
      cwd: dir,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { projectService: true, tsconfigRootDir: dir },
          },
          plugins: { '@typescript-eslint': tseslint.plugin },
        },
        ...fragments,
      ],
    });
    const [result] = await eslint.lintFiles(['core/src/planted.ts']);
    messages = result.messages.map((message) => `${message.line} ${message.ruleId}`);
  });

  it('reports exactly the planted violations, line by line', () => {
    assert.deepEqual([...messages].sort(), [...expected].sort());
  });

  it('fails a planted `void asyncFn()` and a bare floating promise', () => {
    assert.ok(expected.includes('9 no-void'));
    assert.ok(expected.includes('10 @typescript-eslint/no-floating-promises'));
  });

  it('fails every silent swallow, including inert values, named handlers, and detach', () => {
    assert.equal(
      expected.filter((line) => line.endsWith('jsails/no-silent-rejection-handler')).length,
      16,
    );
  });
});
