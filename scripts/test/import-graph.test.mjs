/**
 * Tests for the loaded-set gate (`scripts/import-graph/`, gate
 * `import-graph`): URL classification, the probe on fixture packages (an
 * unconditional dynamic import at load time is caught), browser closures (a
 * browser-tier entry reaching `node:fs` through a lazy import is caught), the
 * verdict against tiers, ceilings and the ledger, and that the policy places
 * every public entry of this repo.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { listWorkspaces, loadParser } from '../api-report.mjs';
import { browserClosure, entryFileMap } from '../import-graph/browser-closure.mjs';
import { dependencyMap } from '../import-graph/index.mjs';
import { judge, lowerBudgets, violations } from '../import-graph/judge.mjs';
import {
  canonicalPath,
  classify,
  packageOfPath,
  pool,
  probe,
  probeEnv,
  publicEntries,
  summarize,
} from '../import-graph/loaded-set.mjs';
import { ENTRIES, SCENARIOS, TIERS, allowedPackages } from '../import-graph/policy.mjs';
import { repoRoot } from '../workspaces.mjs';

const parseSync = await loadParser();
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-import-graph-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const manifest = (name, exports, extra = {}) =>
  JSON.stringify({ name, version: '1.0.0', type: 'module', exports, ...extra });

/** A repo with workspace `app-kit` (two entries) and installed packages `heavy` and `light`. */
function repo() {
  return fixture({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'packages/kit/package.json': manifest('app-kit', {
      '.': './dist/index.js',
      './browser': './dist/browser.js',
      './package.json': './package.json',
    }),
    'packages/kit/dist/index.js': [
      "import 'light';",
      '// An unconditional dynamic import at load time: no static walk sees it.',
      "await import('heavy');",
      'export const ready = true;',
      '',
    ].join('\n'),
    'packages/kit/dist/browser.js': [
      "export { view } from './view.js';",
      "export const later = () => import('./lazy.js');",
      '',
    ].join('\n'),
    'packages/kit/dist/view.js': "import 'light';\nexport const view = 1;\n",
    'packages/kit/dist/lazy.js':
      "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
    'node_modules/heavy/package.json': manifest('heavy', { '.': './index.js' }),
    'node_modules/heavy/index.js': "import './inner.js';\nexport default 1;\n",
    'node_modules/heavy/inner.js': 'export const inner = 1;\n',
    'node_modules/light/package.json': manifest('light', { '.': './index.js' }),
    'node_modules/light/index.js': 'export default 2;\n',
  });
}

const policy = {
  entries: { 'app-kit': { tier: 'runtime' }, 'app-kit/browser': { tier: 'browser' } },
  scenarios: {},
};
const tiers = { runtime: ['light'], browser: ['light'] };

describe('URL classification', () => {
  const workspaces = [{ name: 'app-kit', dir: resolve('/r', 'packages', 'kit') }];

  it('names the package of a node_modules path, scoped or not, innermost first', () => {
    assert.equal(packageOfPath(resolve('/r', 'node_modules', 'a', 'x.js')), 'a');
    assert.equal(packageOfPath(resolve('/r', 'node_modules', '@s', 'b', 'x.js')), '@s/b');
    assert.equal(
      packageOfPath(resolve('/r', 'node_modules', 'a', 'node_modules', 'c', 'x.js')),
      'c',
    );
    assert.equal(packageOfPath(resolve('/r', 'src', 'x.js')), undefined);
  });

  it('tells builtins, packages, workspaces and the harness apart', () => {
    assert.deepEqual(classify('node:fs', workspaces), { kind: 'builtin', name: 'node:fs' });
    assert.equal(
      classify(pathToFileURL(resolve('/r', 'node_modules', 'a', 'i.js')).href, workspaces).kind,
      'package',
    );
    assert.deepEqual(
      classify(pathToFileURL(resolve('/r', 'packages', 'kit', 'dist', 'i.js')).href, workspaces),
      { kind: 'workspace', name: 'app-kit' },
    );
    assert.equal(
      classify(pathToFileURL(resolve('/tmp', 'probe.mjs')).href, workspaces).kind,
      'harness',
    );
  });

  it('counts only first- and third-party modules and judges packages entered from first party', () => {
    const kit = (file) => pathToFileURL(resolve('/r', 'packages', 'kit', file)).href;
    const pkg = (file) => pathToFileURL(resolve('/r', 'node_modules', file)).href;
    const summary = summarize(
      [
        [pathToFileURL(resolve('/tmp', 'probe.mjs')).href, null],
        [kit('index.js'), pathToFileURL(resolve('/tmp', 'probe.mjs')).href],
        [pkg('a/index.js'), kit('index.js')],
        [pkg('dep/index.js'), pkg('a/index.js')],
        ['node:fs', kit('index.js')],
      ],
      workspaces,
    );
    assert.equal(summary.modules, 3);
    assert.deepEqual([...summary.entered.keys()], ['a']);
    assert.deepEqual([...summary.enteredBuiltins.keys()], ['node:fs']);
    assert.deepEqual([...summary.packages.keys()].sort(), ['a', 'dep']);
  });

  it('compares workspace directories the way Node reports module paths', () => {
    const root = fixture({ 'packages/kit/dist/i.js': '' });
    const link = `${root}-link`;
    roots.push(link);
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    // Node realpaths every module URL, so a workspace listed under a symlinked
    // root (macOS's /var -> /private/var) must still own its modules.
    const url = pathToFileURL(join(realpathSync(root), 'packages', 'kit', 'dist', 'i.js')).href;
    assert.deepEqual(classify(url, [{ name: 'app-kit', dir: join(link, 'packages', 'kit') }]), {
      kind: 'workspace',
      name: 'app-kit',
    });
    // Resolved through the link, and case-folded only where the platform's
    // default file system ignores case.
    const real = realpathSync(root);
    assert.equal(canonicalPath(link, 'linux'), real);
    assert.equal(canonicalPath(link, 'darwin'), real.toLowerCase());
    assert.equal(canonicalPath(link, 'win32'), real.toLowerCase());
  });

  it('folds case where the default file system ignores it', () => {
    const folded = [{ name: 'app-kit', dir: resolve('/R', 'Packages', 'Kit') }];
    const url = pathToFileURL(resolve('/r', 'packages', 'kit', 'dist', 'i.js')).href;
    for (const platform of ['win32', 'darwin']) {
      assert.deepEqual(classify(url, folded, platform), { kind: 'workspace', name: 'app-kit' });
    }
    assert.deepEqual(classify(url, folded, 'linux'), { kind: 'harness' });
  });

  it('keeps the compile cache and a test runner context away from a probe', () => {
    const env = probeEnv({ NODE_TEST_CONTEXT: 'child-v8', NODE_COMPILE_CACHE: '/c', KEEP: '1' });
    assert.equal(env.NODE_DISABLE_COMPILE_CACHE, '1');
    assert.equal(env.NODE_TEST_CONTEXT, undefined);
    assert.equal(env.NODE_COMPILE_CACHE, undefined);
    assert.equal(env.KEEP, '1');
  });
});

describe('the probe', () => {
  it('records a package an entry loads through an unconditional dynamic import', async () => {
    const root = repo();
    const workspaces = listWorkspaces(root);
    const entries = publicEntries(workspaces);
    assert.deepEqual(
      entries.map((entry) => entry.entry),
      ['app-kit', 'app-kit/browser'],
    );
    const record = await probe({ mode: 'import', file: entries[0].file }, { cwd: root });
    const summary = summarize(record, workspaces);
    assert.deepEqual([...summary.entered.keys()].sort(), ['heavy', 'light']);
    // index.js, heavy (2 modules) and light.
    assert.equal(summary.modules, 4);

    const measurement = {
      workspaces,
      entries,
      loaded: new Map([['app-kit', { ...summary, workspace: 'app-kit' }]]),
      closures: new Map(),
      declared: undefined,
    };
    const found = violations(measurement, { ...policy, tiers }).map((violation) => violation.id);
    assert.ok(found.includes('app-kit enters heavy'));
  });

  it('measures a repo reached through a symlinked root', async () => {
    const root = repo();
    const link = `${root}-link`;
    roots.push(link);
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const workspaces = listWorkspaces(link);
    const entries = publicEntries(workspaces);
    const record = await probe({ mode: 'import', file: entries[0].file }, { cwd: link });
    const summary = summarize(record, workspaces);
    assert.deepEqual([...summary.entered.keys()].sort(), ['heavy', 'light']);
    assert.deepEqual([...summary.firstParty], ['app-kit']);
    assert.equal(summary.modules, 4);
  });

  it('kills a probe that never exits and names it', async () => {
    const root = fixture({ 'hang.mjs': 'setInterval(() => {}, 1000);\n' });
    await assert.rejects(
      probe(
        { mode: 'import', file: join(root, 'hang.mjs') },
        { cwd: root, label: 'hang', timeoutMs: 300 },
      ),
      (error) => error.code === 'probe_timeout' && /^hang: .*300 ms/.test(error.message),
    );
  });

  it('reports a failing target with its output', async () => {
    const root = fixture({ 'boom.mjs': "throw new Error('boom at load');\n" });
    await assert.rejects(
      probe({ mode: 'import', file: join(root, 'boom.mjs') }, { cwd: root, label: 'boom' }),
      (error) => error.code === 'probe_failed' && /boom at load/.test(error.message),
    );
  });

  it('runs tasks with bounded concurrency, keeping order', async () => {
    let running = 0;
    let peak = 0;
    const task = (value) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value;
    };
    assert.deepEqual(await pool([task(1), task(2), task(3), task(4)], 2), [1, 2, 3, 4]);
    assert.equal(peak, 2);
  });
});

describe('browser closures', () => {
  it('follow lazy imports, so a browser entry reaching node:fs lazily is caught', () => {
    const root = repo();
    const entries = publicEntries(listWorkspaces(root));
    const browser = entries.find((entry) => entry.entry === 'app-kit/browser');
    const closure = browserClosure(parseSync, browser.file, entryFileMap(entries));
    assert.deepEqual([...closure.builtins], ['node:fs']);
    assert.deepEqual([...closure.packages], ['light']);
    assert.equal(closure.modules, 3);
  });
});

/** A measurement for `judge`, built from plain data. */
function measured({
  loaded = {},
  closures = {},
  declared,
  entryNames = Object.keys(policy.entries),
}) {
  return {
    workspaces: [{ name: 'app-kit', dir: '/r', manifest: {} }],
    entries: entryNames.map((entry) => ({ entry, workspace: 'app-kit', file: '/r/x.js' })),
    loaded: new Map(
      Object.entries(loaded).map(([name, { modules, entered = {} }]) => [
        name,
        {
          modules,
          entered: new Map(Object.entries(entered)),
          builtins: new Set(),
          packages: new Map(),
          workspace: 'app-kit',
        },
      ]),
    ),
    closures: new Map(
      Object.entries(closures).map(([name, { builtins = [], packages = [] }]) => [
        name,
        { builtins: new Set(builtins), packages: new Set(packages), modules: 1 },
      ]),
    ),
    declared,
  };
}

const ledger = (...ids) => ({ entries: ids.map((id) => ({ id, reason: 'r', fixedBy: 'KRN-22' })) });
const budgets = (entries, scenarios = {}) => ({ node: 'v26.0.0', entries, scenarios });

describe('judge', () => {
  const clean = {
    loaded: { 'app-kit': { modules: 4 }, 'app-kit/browser': { modules: 2 } },
  };

  it('passes a measurement within its tiers and ceilings', () => {
    const verdict = judge(measured(clean), {
      ...policy,
      tiers,
      budgets: budgets({ 'app-kit': 4, 'app-kit/browser': 2 }),
      ledger: ledger(),
    });
    assert.deepEqual(verdict, { failures: [], notes: [] });
  });

  it('fails a new package outside the tier, and a listed one that is gone', () => {
    const verdict = judge(
      measured({
        loaded: {
          'app-kit': { modules: 4, entered: { heavy: '/r/packages/kit/dist/index.js' } },
          'app-kit/browser': { modules: 2 },
        },
      }),
      {
        ...policy,
        tiers,
        budgets: budgets({ 'app-kit': 4, 'app-kit/browser': 2 }),
        ledger: ledger('app-kit/browser enters gone'),
      },
    );
    assert.deepEqual(verdict.failures, [
      'new violation: app-kit (runtime tier) loads heavy, imported by /r/packages/kit/dist/index.js',
      'fixed: "app-kit/browser enters gone" no longer occurs; remove it from import-graph.json',
    ]);
  });

  it('accepts a listed violation', () => {
    const verdict = judge(
      measured({
        loaded: {
          'app-kit': { modules: 4, entered: { heavy: '/r/i.js' } },
          'app-kit/browser': { modules: 2 },
        },
      }),
      {
        ...policy,
        tiers,
        budgets: budgets({ 'app-kit': 4, 'app-kit/browser': 2 }),
        ledger: ledger('app-kit enters heavy'),
      },
    );
    assert.deepEqual(verdict.failures, []);
  });

  it('fails a browser closure that reaches a builtin', () => {
    const verdict = judge(
      measured({ ...clean, closures: { 'app-kit/browser': { builtins: ['node:fs'] } } }),
      {
        ...policy,
        tiers,
        budgets: budgets({ 'app-kit': 4, 'app-kit/browser': 2 }),
        ledger: ledger(),
      },
    );
    assert.deepEqual(verdict.failures, [
      'new violation: app-kit/browser is browser tier, but its closure imports node:fs',
    ]);
  });

  it('fails a count above its ceiling, a missing ceiling and a stale one, and notes a lower count', () => {
    const verdict = judge(measured(clean), {
      ...policy,
      tiers,
      budgets: budgets({ 'app-kit': 3, gone: 1 }),
      ledger: ledger(),
    });
    assert.match(verdict.failures[0], /^app-kit loads 4 modules, above its ceiling of 3/);
    assert.match(verdict.failures[1], /^app-kit\/browser has no module ceiling/);
    assert.match(verdict.failures[2], /^budgets\.json lists gone, which is no public entry/);
    const lower = judge(measured(clean), {
      ...policy,
      tiers,
      budgets: budgets({ 'app-kit': 9, 'app-kit/browser': 2 }),
      ledger: ledger(),
    });
    assert.deepEqual(lower.failures, []);
    assert.match(lower.notes[0], /below its ceiling of 9/);
  });

  it('fails an entry without a tier and a tier for no entry', () => {
    const verdict = judge(
      measured({
        loaded: { 'app-kit': { modules: 1 }, extra: { modules: 1 } },
        entryNames: ['app-kit', 'extra'],
      }),
      {
        entries: { 'app-kit': { tier: 'runtime' }, ghost: { tier: 'leaf' } },
        scenarios: {},
        tiers,
        budgets: budgets({ 'app-kit': 1, extra: 1 }),
        ledger: ledger(),
      },
    );
    assert.ok(
      verdict.failures.includes('extra has no tier: place it in scripts/import-graph/policy.mjs'),
    );
    assert.ok(verdict.failures.includes('policy entry ghost is no public entry; remove it'));
  });

  it('checks the policy against what core declares browser-safe, both ways', () => {
    const entries = {
      'jsails/client': { tier: 'browser' },
      'jsails/rich-text': { tier: 'browser' },
      'jsails/app': { tier: 'runtime' },
    };
    const names = Object.keys(entries);
    const verdict = judge(
      measured({
        loaded: Object.fromEntries(names.map((name) => [name, { modules: 1 }])),
        entryNames: names,
        declared: ['jsails/client', 'jsails/app'],
      }),
      {
        entries,
        scenarios: {},
        tiers,
        budgets: budgets(Object.fromEntries(names.map((name) => [name, 1]))),
        ledger: ledger(),
      },
    );
    assert.deepEqual(verdict.failures, [
      'jsails/app is declared browser-safe by core but is not browser tier in the policy',
      "new violation: jsails/rich-text is browser tier in the policy but missing from core's BROWSER_SAFE_SUBPATHS",
    ]);
  });

  it('records new ceilings and only lowers existing ones', () => {
    const next = lowerBudgets(
      budgets({ 'app-kit': 3, 'app-kit/browser': 1, gone: 5 }, { 'cli-help': 10 }),
      measured({
        loaded: {
          'app-kit': { modules: 4 },
          'app-kit/browser': { modules: 2 },
          'cli-help': { modules: 8 },
        },
      }),
      { scenarios: { 'cli-help': { tier: 'leaf' } }, node: 'v26.1.0' },
    );
    assert.deepEqual(next, {
      node: 'v26.1.0',
      entries: { 'app-kit': 3, 'app-kit/browser': 1 },
      scenarios: { 'cli-help': 8 },
    });
  });

  it('gives an unsettled workspace no ceiling and notes its untiered entries', () => {
    const measurement = measured({
      loaded: { 'app-kit': { modules: 4 }, 'app-kit/new': { modules: 9 } },
      entryNames: ['app-kit', 'app-kit/new'],
    });
    const options = { ...policy, tiers, ledger: ledger(), unsettled: { 'app-kit': 'LANE-01' } };
    const verdict = judge(measurement, { ...options, budgets: budgets({}) });
    assert.deepEqual(verdict, {
      failures: ['policy entry app-kit/browser is no public entry; remove it'],
      notes: ['app-kit/new has no tier yet; its workspace is unsettled'],
    });
    // A ceiling left behind for it is stale.
    const stale = judge(measurement, { ...options, budgets: budgets({ 'app-kit': 4 }) });
    assert.ok(
      stale.failures.includes(
        'budgets.json lists app-kit, whose workspace is unsettled; remove its ceiling',
      ),
    );
    // Its entries are still judged against their tiers.
    const heavy = measured({
      loaded: { 'app-kit': { modules: 4, entered: { heavy: '/r/i.js' } } },
      entryNames: ['app-kit'],
    });
    const judged = judge(heavy, { ...options, budgets: budgets({}) });
    assert.ok(judged.failures.some((failure) => failure.startsWith('new violation: app-kit')));
    assert.deepEqual(
      lowerBudgets(budgets({}), measurement, {
        scenarios: {},
        node: 'v26.1.0',
        unsettled: { 'app-kit': 'LANE-01' },
      }),
      { node: 'v26.1.0', entries: {}, scenarios: {} },
    );
  });
});

describe('the dependency map', () => {
  it('lists who loads each package and the declared packages nothing loads', () => {
    const map = dependencyMap(
      {
        loaded: new Map([
          [
            'a',
            { entered: new Map([['x', resolve('/r', 'f.js')]]), packages: new Map([['x', 1]]) },
          ],
          [
            'b',
            {
              entered: new Map([['x', resolve('/r', 'g.js')]]),
              packages: new Map([
                ['x', 1],
                ['y', 2],
              ]),
            },
          ],
        ]),
      },
      ['x', 'unused'],
      '/r',
    );
    assert.deepEqual(map, {
      packages: [
        {
          package: 'x',
          loadedBy: [
            { name: 'a', importer: 'f.js' },
            { name: 'b', importer: 'g.js' },
          ],
        },
      ],
      unused: ['unused'],
    });
  });
});

describe('the policy', () => {
  it('places every public entry of this repo in a tier, and names no other', () => {
    const names = publicEntries(listWorkspaces(repoRoot)).map((entry) => entry.entry);
    assert.deepEqual(
      names.filter((name) => ENTRIES[name] === undefined),
      [],
    );
    assert.deepEqual(
      Object.keys(ENTRIES).filter((name) => !names.includes(name)),
      [],
    );
  });

  it('uses only known tiers', () => {
    for (const [name, entry] of [...Object.entries(ENTRIES), ...Object.entries(SCENARIOS)]) {
      assert.ok(TIERS[entry.tier] !== undefined, `${name} has unknown tier ${entry.tier}`);
    }
  });

  it('lets a plugin tier load what its own manifest declares', () => {
    const allowed = allowedPackages(
      { tier: 'plugin' },
      { dependencies: { shiki: '1' }, peerDependencies: { typeorm: '1' } },
    );
    assert.ok(allowed.has('shiki') && allowed.has('typeorm') && allowed.has('hono'));
    assert.ok(!allowedPackages({ tier: 'leaf' }, undefined).has('hono'));
  });
});
