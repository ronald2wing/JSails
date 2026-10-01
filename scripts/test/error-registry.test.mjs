/**
 * Tests for the error-registry gate (`scripts/gates/error-registry.mjs`) and
 * its lint fragment (`eslint/errors.mjs`): the adoption scan finds exactly the
 * hand-written error forms, the registry judgement reports conflicts and
 * reference drift, the adoption ratchet fails both ways, and the fragment bans
 * the same forms in converted units only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import * as prettier from 'prettier';
import tseslint from 'typescript-eslint';

import * as errors from '../../eslint/errors.mjs';
import { listWorkspaces, loadParser } from '../api-report.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import {
  adoptionUnits,
  adoptionViolations,
  judgeAdoption,
  judgeRegistry,
  referenceData,
  REFERENCE_FILE,
  registryCalls,
  renderReference,
  registryModules,
  scanAdoption,
  unregisteredDomains,
} from '../gates/error-registry.mjs';
import { repoRoot } from '../workspaces.mjs';

const parseSync = await loadParser(repoRoot);

const scan = (text, options) =>
  adoptionViolations(parseSync, 'x.ts', text, options).map((found) => found.what);

describe('adoptionViolations', () => {
  it('finds raw errors constructed, called, rejected and extended', () => {
    assert.deepEqual(
      scan(
        [
          "throw new Error('x');",
          "throw TypeError('x');",
          'reject(new RangeError());',
          'class A extends Error {}',
          'const B = class extends TypeError {};',
          'class C extends JsailsError {}',
        ].join('\n'),
      ),
      [
        'raw Error',
        'raw TypeError',
        'raw RangeError',
        'class extends Error',
        'class extends TypeError',
        'hand-written JsailsError subclass',
      ],
    );
  });

  it('ignores registry errors, comments, strings, and member calls', () => {
    assert.deepEqual(
      scan(
        [
          "throw new QueueErrors.Error('missing', { queue: 'mail' });",
          '// new Error() in a comment',
          "const text = 'new Error()';",
          'const e = errors.Error();',
          'if (error instanceof Error) {}',
        ].join('\n'),
      ),
      [],
    );
  });

  it('lets the kernel extend Error and JsailsError but not construct raw errors', () => {
    assert.deepEqual(
      scan('class A extends Error {}\nclass B extends JsailsError {}\nnew Error();', {
        kernel: true,
      }),
      ['raw Error'],
    );
  });
});

describe('adoption units and scan', () => {
  it('splits core/src by top-level entry and keeps each package src whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'error-adoption-'));
    try {
      const write = (path, text) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('core/src/clean/a.ts', 'export const a = 1;\n');
      write('core/src/dirty/b.ts', "throw new Error('b');\n");
      write('core/src/top.ts', "throw new TypeError('t');\n");
      write('core/src/types.d.ts', 'declare const x: Error;\n');
      write('packages/p/src/deep/c.tsx', 'class X extends JsailsError {}\n');
      const workspaces = [{ dir: join(root, 'core') }, { dir: join(root, 'packages', 'p') }];
      assert.deepEqual(
        adoptionUnits(root, workspaces).map((unit) => unit.unit),
        ['core/src/clean', 'core/src/dirty', 'core/src/top.ts', 'packages/p/src'],
      );
      assert.deepEqual(scanAdoption(parseSync, root, workspaces), [
        'adoption:core/src/dirty',
        'adoption:core/src/top.ts',
        'adoption:packages/p/src',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a new unconverted unit and a converted unit still listed', () => {
    const ledger = { entries: [{ id: 'adoption:core/src/a' }, { id: 'adoption:core/src/b' }] };
    const failures = judgeAdoption(['adoption:core/src/a', 'adoption:core/src/c'], ledger);
    assert.equal(failures.length, 2);
    assert.match(failures[0], /^core\/src\/c raises a hand-written error/);
    assert.match(failures[1], /^fixed: "adoption:core\/src\/b"/);
  });
});

describe('registry discovery', () => {
  it('finds module-scope calls with literal domains and flags the rest', () => {
    const calls = registryCalls(
      parseSync,
      'x.ts',
      [
        "export const A = defineErrors('alpha', {});",
        "const B: R = defineErrors<'beta', D>('beta', {});",
        'const C = defineErrors(name, {});',
        "function lazy() { return defineErrors('gamma', {}); }",
        "const d = () => defineErrors('delta', {});",
        "class E { static f = defineErrors('epsilon', {}); }",
        "// defineErrors('comment', {})",
        "const g = other.defineErrors('member', {});",
      ].join('\n'),
    );
    assert.deepEqual(calls, [
      { line: 1, domain: 'alpha', deferred: false },
      { line: 2, domain: 'beta', deferred: false },
      { line: 3, domain: undefined, deferred: false },
      { line: 4, domain: 'gamma', deferred: true },
      { line: 5, domain: 'delta', deferred: true },
      { line: 6, domain: 'epsilon', deferred: true },
    ]);
  });

  it('lists every defining module of every workspace, whatever imports it', () => {
    const root = mkdtempSync(join(tmpdir(), 'error-registries-'));
    try {
      const write = (path, text) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('core/src/errors/registry.ts', "export const K = defineErrors('errors', {});\n");
      write('core/src/plain.ts', '// mentions defineErrors only in a comment\n');
      // Reached from no public entry, only from a bin: still found.
      write('packages/tool/src/bin.ts', "import './deep/errors.js';\n");
      write(
        'packages/tool/src/deep/errors.tsx',
        "export const T = defineErrors('tool', {});\nexport const U = defineErrors('tool_more', {});\n",
      );
      write('packages/lazy/src/a.ts', 'export function f() { return defineErrors(d, {}); }\n');
      write('packages/lazy/src/types.d.ts', 'declare const X: typeof defineErrors;\n');
      const workspaces = ['core', 'packages/tool', 'packages/lazy'].map((dir) => ({
        dir: join(root, dir),
      }));
      const { modules, problems } = registryModules(parseSync, root, workspaces);
      assert.deepEqual(
        modules.map(({ source, built, domains }) => ({
          source,
          built: built
            .slice(root.length + 1)
            .split('\\')
            .join('/'),
          domains,
        })),
        [
          {
            source: 'core/src/errors/registry.ts',
            built: 'core/dist/src/errors/registry.js',
            domains: ['errors'],
          },
          { source: 'packages/lazy/src/a.ts', built: 'packages/lazy/dist/src/a.js', domains: [] },
          {
            source: 'packages/tool/src/deep/errors.tsx',
            built: 'packages/tool/dist/src/deep/errors.js',
            domains: ['tool', 'tool_more'],
          },
        ],
      );
      assert.equal(problems.length, 2);
      assert.match(
        problems[0],
        /^packages\/lazy\/src\/a\.ts:1: defineErrors runs inside a function/,
      );
      assert.match(problems[1], /^packages\/lazy\/src\/a\.ts:1: .*use a string literal$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a literal domain that registered no code', () => {
    const modules = [{ source: 'packages/p/src/e.ts', domains: ['present', 'absent'] }];
    const codes = [{ code: 'present.one' }, { code: 'other.two' }];
    assert.deepEqual(unregisteredDomains(modules, codes), [
      'packages/p/src/e.ts: error domain "absent" registered no code when imported',
    ]);
  });

  it('reaches the registries only a package bin loads, in this repo', () => {
    const { modules, problems } = registryModules(parseSync, repoRoot, listWorkspaces(repoRoot));
    assert.deepEqual(problems, []);
    const jamal = modules.find(
      ({ source }) => source === 'packages/jamal/src/credentials-delivery.ts',
    );
    assert.deepEqual(jamal?.domains, ['jamal_credentials']);
    const sources = modules.map(({ source }) => source);
    assert.deepEqual(sources, [...sources].sort());
  });
});

describe('registry judgement', () => {
  const codes = [
    {
      code: 'request.not_found',
      kind: 'not_found',
      audience: 'client',
      message: 'Not found.',
      exposes: [],
    },
    {
      code: 'queue.missing',
      kind: 'internal',
      audience: 'operator',
      message: 'queue {queue} is missing',
      exposes: [],
    },
    {
      code: 'request.invalid',
      kind: 'invalid',
      audience: 'client',
      message: 'Invalid.',
      exposes: ['issues'],
    },
  ];

  it('keeps client messages and exposed members, never operator messages', () => {
    assert.deepEqual(referenceData(codes), {
      'request.not_found': { kind: 'not_found', audience: 'client', message: 'Not found.' },
      'queue.missing': { kind: 'internal', audience: 'operator' },
      'request.invalid': {
        kind: 'invalid',
        audience: 'client',
        exposes: ['issues'],
        message: 'Invalid.',
      },
    });
  });

  it('renders the reference the way format:check expects it', async () => {
    const text = await renderReference(repoRoot, codes);
    assert.deepEqual(JSON.parse(text), referenceData(codes));
    const options = (await prettier.resolveConfig(join(repoRoot, REFERENCE_FILE))) ?? {};
    assert.equal(
      await prettier.check(text, { ...options, filepath: join(repoRoot, REFERENCE_FILE) }),
      true,
    );
    assert.match(text, /"exposes": \["issues"\]/);
    // One key per line, as committed, so a changed code diffs on its own lines.
    assert.match(
      text,
      /^ {2}"queue\.missing": \{\n {4}"kind": "internal",\n {4}"audience": "operator"\n {2}\},$/m,
    );
  });

  it('passes when the reference matches and reports each kind of drift', () => {
    const committed = referenceData(codes);
    assert.deepEqual(judgeRegistry({ codes, conflicts: [], failures: [] }, committed), []);

    const drifted = { ...committed, 'old.gone': { kind: 'internal', audience: 'operator' } };
    delete drifted['queue.missing'];
    drifted['request.not_found'] = { ...drifted['request.not_found'], audience: 'operator' };
    const failures = judgeRegistry({ codes, conflicts: ['twice'], failures: ['e: boom'] }, drifted);
    assert.deepEqual(failures.slice(0, 5), [
      'registry collection: e: boom',
      'error domain "twice" is defined twice with different codes',
      'error code old.gone was removed',
      'error code queue.missing is new',
      'error code request.not_found changed',
    ]);
    assert.match(failures[5], /--write/);
  });

  it('asks for the reference file when it is missing', () => {
    assert.match(
      judgeRegistry({ codes, conflicts: [], failures: [] }, undefined).join('\n'),
      /api\/error-codes\.json is missing/,
    );
  });
});

describe('errors fragment', () => {
  it('lints converted units, not the units the ledger lists, nor tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const state = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules['jsails/no-raw-error']?.[0] ?? 0;
    };
    assert.equal(await state('core/src/extensions/services.ts'), 2);
    assert.equal(await state('core/src/errors/registry.ts'), 2);
    assert.equal(await state('core/src/app/index.ts'), 0);
    assert.equal(await state('core/test/errors/registry.test.ts'), 0);
  });

  it('reports the banned forms on planted code and lets the kernel extend', () => {
    const cwd = join(repoRoot, 'plant');
    const config = [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...composeFragments([
        {
          file: 'eslint/errors.mjs',
          configs: errors.default,
          restrictedSyntax: errors.restrictedSyntax,
        },
      ]),
    ];
    const reports = (text, file) =>
      new Linter({ cwd })
        .verify(text, config, { filename: join(cwd, file) })
        .map((message) => message.ruleId);
    const planted = [
      "throw new Error('x');",
      'promise.catch(() => reject(new Error()));',
      'class A extends RangeError {}',
      'class B extends JsailsError {}',
      "throw new ServiceErrors.Error('closed', { token: 'db' });",
    ].join('\n');
    assert.deepEqual(reports(planted, 'core/src/x/y.ts'), [
      'jsails/no-raw-error',
      'jsails/no-raw-error',
      'jsails/no-raw-error-class',
      'jsails/no-hand-written-error-class',
    ]);
    assert.deepEqual(reports('class B extends JsailsError {}', 'core/src/errors/z.ts'), []);
  });
});
