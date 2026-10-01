/**
 * Tests for `scripts/api-report.mjs` and its gates (`api-report`,
 * `api-untagged`): export resolution through barrels, homes and re-export
 * lines, tiers and TSDoc findings, value budgets, the platform header, and the
 * check/write cycle, all on fixture repositories with hand-written
 * declaration files.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildModel,
  compareReport,
  entrySpecifier,
  findings,
  loadParser,
  main,
  parseDoc,
  readBudget,
  recordFindings,
  renderReport,
  reportPath,
} from '../api-report.mjs';
import { judge } from '../gates/api-untagged.mjs';

const parseSync = await loadParser();
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const entry = (path) => ({ types: `./dist/src/${path}.d.ts`, default: `./dist/src/${path}.js` });

/** A fixture monorepo: workspace `alpha` (two entries) and `@scope/beta` (one). */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-api-report-'));
  roots.push(root);
  write(root, {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/alpha/package.json': JSON.stringify({
      name: 'alpha',
      exports: {
        '.': entry('index'),
        './util': entry('util/index'),
        './package.json': './package.json',
      },
    }),
    'packages/alpha/dist/src/index.d.ts': [
      '/** Module header: never an export doc. */',
      "export * from './util/index.js';",
      "export { helper as renamed } from './inner.js';",
      "import { Thing } from './inner.js';",
      'export { Thing };',
      "export * as tools from './tools.js';",
      "export { z } from 'zod';",
      '/** A documented, tagged root function.\n * @public\n */',
      'export declare function rootFn(a: string): number;',
      '',
    ].join('\n'),
    'packages/alpha/dist/src/index.js': "import './util/index.js';\n",
    'packages/alpha/dist/src/inner.d.ts': [
      '/** Inner module header. */',
      '/** Helper doc.\n * @public */',
      'export declare function helper(): void;',
      '/** A thing. @internal */',
      'export interface Thing { a: number }',
      '',
    ].join('\n'),
    'packages/alpha/dist/src/tools.d.ts':
      '/** Tools header. */\n/** Tool. @public */\nexport declare const tool: 1;\n',
    'packages/alpha/dist/src/util/index.d.ts': [
      '/** Util header. */',
      "export { untagged, Shape } from './impl.js';",
      'declare const defaults: { readonly retries: 3 };',
      '/** Frozen defaults. @public */',
      'export declare const DEFAULTS: typeof defaults;',
      '',
    ].join('\n'),
    'packages/alpha/dist/src/util/index.js':
      "import { readFileSync } from 'node:fs';\nimport 'es-toolkit';\n",
    'packages/alpha/dist/src/util/impl.d.ts': [
      '/** Impl header. */',
      'export declare function untagged(): string;',
      '/** The shape. @public */',
      'export interface Shape { readonly thing: Thing }',
      "import type { Thing } from '../inner.js';",
      '',
    ].join('\n'),
    'packages/beta/package.json': JSON.stringify({
      name: '@scope/beta',
      exports: { '.': entry('index') },
    }),
    'packages/beta/dist/src/index.d.ts': [
      "export { untagged } from 'alpha/util';",
      '/** Beta also has a rootFn. @public */',
      'export declare function rootFn(): void;',
      '/** Experimental here. @experimental */',
      'export declare const early: string;',
      '/** Two tiers. @public @internal */',
      'export declare const confused: string;',
      '',
    ].join('\n'),
    'packages/beta/dist/src/index.js': "export { untagged } from 'alpha/util';\n",
    'packages/private/package.json': JSON.stringify({
      name: 'private-thing',
      private: true,
      exports: { '.': entry('index') },
    }),
    ...overrides,
  });
  return root;
}

const byName = (model, specifier) =>
  new Map(
    model.entries.find((e) => e.specifier === specifier).exports.map((item) => [item.name, item]),
  );

describe('entry naming', () => {
  it('maps export-map keys to specifiers and report paths', () => {
    assert.equal(entrySpecifier('jsails', '.'), 'jsails');
    assert.equal(entrySpecifier('@jsails/ai', './client'), '@jsails/ai/client');
    assert.equal(reportPath('jsails', '.'), 'api/jsails/index.api.md');
    assert.equal(reportPath('jsails', './broadcast/client'), 'api/jsails/broadcast/client.api.md');
    assert.equal(reportPath('@jsails/ai', './client'), 'api/@jsails/ai/client.api.md');
  });
});

describe('parseDoc', () => {
  it('reads the tier and whether a summary precedes the tags', () => {
    assert.deepEqual(parseDoc('*\n * Does a thing.\n * @public\n '), {
      tier: 'public',
      tiers: ['public'],
      summary: true,
    });
    assert.deepEqual(parseDoc('* @experimental '), {
      tier: 'experimental',
      tiers: ['experimental'],
      summary: false,
    });
    assert.deepEqual(parseDoc(null), { tier: null, tiers: [], summary: false });
  });

  it('does not take a tag-like word for a tier and reports two tiers', () => {
    assert.equal(parseDoc('* Not @publicly tagged. ').tier, null);
    assert.deepEqual(parseDoc('* x @public @internal').tiers, ['public', 'internal']);
    assert.equal(parseDoc('* x @public @internal').tier, null);
  });
});

describe('buildModel', () => {
  it('follows every re-export form to the declaring file', async () => {
    const model = await buildModel({ root: fixture(), parseSync });
    const root = byName(model, 'alpha');
    assert.deepEqual(
      [...root.keys()],
      ['DEFAULTS', 'Shape', 'Thing', 'renamed', 'rootFn', 'tools', 'tools.tool', 'untagged', 'z'],
    );
    assert.equal(root.get('renamed').signature, 'function helper(): void');
    assert.equal(root.get('renamed').tier, 'public');
    assert.equal(root.get('Thing').kind, 'interface');
    assert.equal(root.get('Thing').value, false);
    assert.equal(root.get('z').signature, "export { z } from 'zod'");
    assert.equal(root.get('tools').kind, 'namespace-export');
    assert.equal(root.get('tools.tool').signature, 'const tool: 1');
  });

  it('never takes a module header for a declaration doc', async () => {
    const model = await buildModel({ root: fixture(), parseSync });
    const untagged = byName(model, 'alpha/util').get('untagged');
    assert.equal(untagged.summary, false);
    assert.equal(untagged.tier, null);
  });

  it('inlines a same-file declaration no entry reports', async () => {
    const model = await buildModel({ root: fixture(), parseSync });
    assert.equal(
      byName(model, 'alpha/util').get('DEFAULTS').signature,
      'const DEFAULTS: typeof defaults; where const defaults: { readonly retries: 3 }',
    );
  });

  it('inlines declarations from other files that no entry reports, transitively', async () => {
    const root = fixture({
      'packages/alpha/dist/src/tools.d.ts': [
        '/** Tools header. */',
        "import type { Options } from './options.js';",
        "import * as shapes from './shapes.js';",
        '/** Tool. @public */',
        "export declare const tool: (options: Options, shape: shapes.Circle, raw: import('./raw.js').Raw) => 1;",
        '',
      ].join('\n'),
      'packages/alpha/dist/src/options.d.ts': [
        '/** Options header. */',
        "import type { Shape } from './util/impl.js';",
        'declare const modes: readonly ["a", "b"];',
        'export interface Options { mode: (typeof modes)[number]; shape: Shape }',
        '',
      ].join('\n'),
      'packages/alpha/dist/src/shapes.d.ts':
        '/** Shapes header. */\nexport interface Circle { r: number }\nexport interface Square { s: number }\n',
      'packages/alpha/dist/src/raw.d.ts': '/** Raw header. */\nexport type Raw = Uint8Array;\n',
    });
    const model = await buildModel({ root, parseSync });
    assert.equal(
      byName(model, 'alpha').get('tools.tool').signature,
      [
        "const tool: (options: Options, shape: shapes.Circle, raw: import('./raw.js').Raw) => 1",
        'where packages/alpha/dist/src/options.d.ts#Options: interface Options { mode: (typeof modes)[number]; shape: Shape }',
        'where packages/alpha/dist/src/options.d.ts#modes: const modes: readonly ["a", "b"]',
        'where packages/alpha/dist/src/raw.d.ts#Raw: type Raw = Uint8Array',
        'where packages/alpha/dist/src/shapes.d.ts#Circle: interface Circle { r: number }',
      ].join('; '),
      // Shape is reported by alpha/util, so its own line carries it; Square is never named.
    );
  });

  it('fails --check when an imported type no entry exports changes shape', async () => {
    const root = fixture({
      'packages/alpha/dist/src/tools.d.ts': [
        '/** Tools header. */',
        "import type { Options } from './options.js';",
        '/** Tool. @public */',
        'export declare function tool(options: Options): void;',
        '',
      ].join('\n'),
      'packages/alpha/dist/src/options.d.ts':
        '/** Options header. */\nexport interface Options { a: string }\n',
    });
    assert.equal((await main(['--write'], { root })).status, 0);
    assert.equal((await main(['--check'], { root })).status, 0);
    write(root, {
      'packages/alpha/dist/src/options.d.ts':
        '/** Options header. */\nexport interface Options { a: number; required: boolean }\n',
    });
    const stale = await main(['--check'], { root });
    assert.equal(stale.status, 1);
    assert.match(stale.messages[0], /^api\/alpha\/index\.api\.md is stale/);
    assert.match(
      stale.messages[0],
      /options\.d\.ts#Options: interface Options \{ a: number; required: boolean \}/,
    );
  });

  it('gives each declaration one home and leaves private workspaces out', async () => {
    const model = await buildModel({ root: fixture(), parseSync });
    assert.deepEqual(
      model.entries.map((e) => e.specifier),
      ['alpha', 'alpha/util', '@scope/beta'],
    );
    assert.equal(byName(model, 'alpha').get('DEFAULTS').home, 'alpha/util');
    assert.equal(byName(model, 'alpha').get('rootFn').home, 'alpha');
    assert.equal(byName(model, '@scope/beta').get('untagged').home, 'alpha/util');
  });

  it('derives the platform from the static runtime closure', async () => {
    const model = await buildModel({ root: fixture(), parseSync });
    const [alpha, util, beta] = model.entries;
    assert.equal(alpha.platform, 'node');
    assert.deepEqual(alpha.builtins, ['fs']);
    assert.deepEqual(util.externals, ['es-toolkit']);
    // beta reaches node:fs through the workspace entry it imports.
    assert.equal(beta.platform, 'node');
  });
});

describe('findings', () => {
  it('reports each problem once, at the declaration home', async () => {
    const ids = findings(await buildModel({ root: fixture(), parseSync })).map((f) => f.id);
    assert.deepEqual(ids, [
      '@scope/beta confused conflicting-tiers',
      '@scope/beta early experimental-outside',
      'alpha z undocumented',
      'alpha z untagged',
      'alpha/util Shape public-uses-internal packages/alpha/dist/src/inner.d.ts#Thing',
      'alpha/util untagged undocumented',
      'alpha/util untagged untagged',
      'duplicate rootFn @scope/beta,alpha',
    ]);
    assert.ok(ids.includes('@scope/beta confused conflicting-tiers'));
    assert.ok(ids.includes('@scope/beta early experimental-outside'));
    assert.ok(ids.includes('alpha/util untagged untagged'));
    assert.ok(ids.includes('alpha/util untagged undocumented'));
    assert.ok(ids.includes('alpha Thing untagged') === false, 'Thing is tagged @internal');
    // A re-export is judged at its home only.
    assert.equal(ids.filter((id) => id.startsWith('@scope/beta untagged')).length, 0);
    // Tagged and documented declarations produce nothing.
    assert.equal(ids.filter((id) => id.startsWith('alpha rootFn')).length, 0);
  });

  it('fails an added untagged export through the api-untagged gate', async () => {
    const root = fixture();
    const baseline = recordFindings(findings(await buildModel({ root, parseSync })), null);
    assert.deepEqual(judge(findings(await buildModel({ root, parseSync })), baseline), []);
    write(root, {
      'packages/alpha/dist/src/tools.d.ts':
        '/** Tools header. */\n/** Tool. @public */\nexport declare const tool: 1;\nexport declare const added: 2;\n',
    });
    const failures = judge(findings(await buildModel({ root, parseSync })), baseline);
    assert.equal(failures.length, 2);
    assert.deepEqual(failures, [
      'new finding: alpha tools.added has no TSDoc summary (tag and document the export)',
      'new finding: alpha tools.added has no @public, @experimental or @internal tag (tag and document the export)',
    ]);
  });

  it('fails a fixed finding until its ledger entry is removed', async () => {
    const root = fixture();
    const baseline = recordFindings(findings(await buildModel({ root, parseSync })), null);
    write(root, {
      'packages/alpha/dist/src/util/impl.d.ts': [
        '/** Impl header. */',
        '/** Now documented. @public */',
        'export declare function untagged(): string;',
        '/** The shape. @public */',
        'export interface Shape { readonly thing: Thing }',
        "import type { Thing } from '../inner.js';",
        '',
      ].join('\n'),
    });
    const failures = judge(findings(await buildModel({ root, parseSync })), baseline);
    assert.deepEqual(failures, [
      'fixed: "alpha/util untagged undocumented" no longer occurs; remove it from api-untagged.json',
      'fixed: "alpha/util untagged untagged" no longer occurs; remove it from api-untagged.json',
    ]);
  });

  it('fails a third conflicting declaration of a listed duplicate name', async () => {
    const root = fixture();
    const baseline = recordFindings(findings(await buildModel({ root, parseSync })), null);
    write(root, {
      'packages/gamma/package.json': JSON.stringify({
        name: 'gamma',
        exports: { '.': entry('index') },
      }),
      'packages/gamma/dist/src/index.d.ts':
        '/** Gamma header. */\n/** Gamma has one too. @public */\nexport declare function rootFn(n: number): void;\n',
    });
    assert.deepEqual(judge(findings(await buildModel({ root, parseSync })), baseline), [
      'new finding: rootFn names 3 different declarations (@scope/beta, alpha, gamma) (give the name one declaration)',
      'fixed: "duplicate rootFn @scope/beta,alpha" no longer occurs; remove it from api-untagged.json',
    ]);
  });

  it('fails a listed public-uses-internal finding that names one more internal declaration', async () => {
    const root = fixture();
    const baseline = recordFindings(findings(await buildModel({ root, parseSync })), null);
    write(root, {
      'packages/alpha/dist/src/util/impl.d.ts': [
        '/** Impl header. */',
        'export declare function untagged(): string;',
        '/** The shape. @public */',
        'export interface Shape { readonly thing: Thing; readonly secret: Secret }',
        "import type { Thing } from '../inner.js';",
        "import type { Secret } from './secret.js';",
        '',
      ].join('\n'),
      'packages/alpha/dist/src/util/secret.d.ts':
        '/** Secret header. */\n/** A secret. @internal */\nexport interface Secret { s: string }\n',
    });
    const failures = judge(findings(await buildModel({ root, parseSync })), baseline);
    assert.deepEqual(failures, [
      'new finding: alpha/util Shape is @public but names @internal packages/alpha/dist/src/inner.d.ts#Thing, packages/alpha/dist/src/util/secret.d.ts#Secret (make every declaration it names public)',
      'fixed: "alpha/util Shape public-uses-internal packages/alpha/dist/src/inner.d.ts#Thing" no longer occurs; remove it from api-untagged.json',
    ]);
  });

  it('finds an @internal declaration named through an unreported declaration in another file', async () => {
    const root = fixture({
      'packages/alpha/dist/src/tools.d.ts': [
        '/** Tools header. */',
        "import type { Options } from './options.js';",
        '/** Tool. @public */',
        'export declare const tool: (options: Options) => 1;',
        '',
      ].join('\n'),
      'packages/alpha/dist/src/options.d.ts': [
        '/** Options header. */',
        "import type { Hidden } from './hidden.js';",
        'export interface Options { hidden: Hidden }',
        '',
      ].join('\n'),
      'packages/alpha/dist/src/hidden.d.ts':
        '/** Hidden header. */\n/** Hidden. @internal */\nexport type Hidden = string;\n',
    });
    const ids = findings(await buildModel({ root, parseSync })).map((f) => f.id);
    assert.ok(
      ids.includes(
        'alpha tools.tool public-uses-internal packages/alpha/dist/src/hidden.d.ts#Hidden',
      ),
      ids.join('\n'),
    );
  });

  it('keeps recorded reasons and adds new findings with the default reason', () => {
    const previous = {
      description: 'd',
      kind: 'gate',
      gate: 'api-untagged',
      entries: [
        { id: 'a x untagged', reason: 'custom', fixedBy: 'KRN-21' },
        { id: 'gone y untagged', reason: 'r', fixedBy: 'KRN-21' },
      ],
    };
    const next = recordFindings(
      [
        { id: 'a x untagged', kind: 'untagged' },
        { id: 'duplicate z a,b', kind: 'duplicate' },
      ],
      previous,
    );
    assert.deepEqual(next.entries, [
      { id: 'a x untagged', reason: 'custom', fixedBy: 'KRN-21' },
      {
        id: 'duplicate z a,b',
        reason:
          'One name bound to different declarations in two entries; KRN-21 gives each symbol one home.',
        fixedBy: 'KRN-21',
      },
    ]);
  });
});

describe('report files', () => {
  it('fails a changed signature until the report is regenerated', async () => {
    const root = fixture();
    assert.equal((await main(['--write'], { root })).status, 0);
    assert.deepEqual(await main(['--check'], { root }), {
      status: 0,
      messages: ['3 report file(s) match dist'],
    });
    write(root, {
      'packages/alpha/dist/src/index.d.ts': readFileSync(
        join(root, 'packages/alpha/dist/src/index.d.ts'),
        'utf8',
      ).replace('rootFn(a: string): number', 'rootFn(a: string, b?: boolean): number'),
    });
    const stale = await main(['--check'], { root });
    assert.equal(stale.status, 1);
    assert.match(stale.messages[0], /^api\/alpha\/index\.api\.md is stale at line \d+/);
    assert.match(stale.messages[0], /b\?: boolean/);
    assert.equal((await main(['--write'], { root })).status, 0);
    assert.equal((await main(['--check'], { root })).status, 0);
  });

  it('refuses value growth past the budget without --allow-growth', async () => {
    const root = fixture();
    await main(['--write'], { root });
    const report = readFileSync(join(root, 'api/alpha/util.api.md'), 'utf8');
    assert.equal(readBudget(report), 2);
    write(root, {
      'packages/alpha/dist/src/util/index.d.ts': readFileSync(
        join(root, 'packages/alpha/dist/src/util/index.d.ts'),
        'utf8',
      ).concat('/** More. @public */\nexport declare function more(): void;\n'),
    });
    const refused = await main(['--write'], { root });
    assert.equal(refused.status, 1);
    // The root entry re-exports `alpha/util`, so both grow.
    assert.deepEqual(refused.messages.slice(1), [
      '  alpha: 7 value exports, budget 6',
      '  alpha/util: 3 value exports, budget 2',
    ]);
    const checked = await main(['--check'], { root });
    assert.match(
      checked.messages[1],
      /^value budget exceeded: alpha\/util: 3 value exports, budget 2$/,
    );
    assert.equal((await main(['--write', '--allow-growth'], { root })).status, 0);
    assert.equal(readBudget(readFileSync(join(root, 'api/alpha/util.api.md'), 'utf8')), 3);
  });

  it('lowers the budget when value exports go away', async () => {
    const root = fixture();
    const model = await buildModel({ root, parseSync });
    const util = model.entries.find((e) => e.specifier === 'alpha/util');
    util.exports = util.exports.filter((item) => item.name !== 'DEFAULTS');
    const current = new Map([['api/alpha/util.api.md', '- value budget: 2\n']]);
    const { files, growth } = renderReport(model, current);
    assert.deepEqual(growth, []);
    assert.equal(readBudget(files.get('api/alpha/util.api.md')), 1);
  });

  it('reports missing, stale and orphaned files', () => {
    const problems = compareReport(
      new Map([
        ['api/a.api.md', 'x\ny\n'],
        ['api/b.api.md', 'b'],
      ]),
      new Map([
        ['api/a.api.md', 'x\nz\n'],
        ['api/c.api.md', 'c'],
      ]),
    );
    assert.equal(problems.length, 3);
    assert.match(
      problems[0],
      /^api\/a\.api\.md is stale at line 2:\n {4}report: z\n {4}dist: {3}y$/,
    );
    assert.equal(problems[1], 'api/b.api.md is missing');
    assert.equal(problems[2], 'api/c.api.md names no entry');
  });

  it('writes re-exports as references to their home', async () => {
    const root = fixture();
    await main(['--write'], { root });
    const text = readFileSync(join(root, 'api/@scope/beta/index.api.md'), 'utf8');
    assert.match(text, /^untagged \| re-export \| untagged \| - \| from alpha\/util$/m);
    assert.match(text, /^- platform: node \(fs\)$/m);
    assert.match(text, /^rootFn \| function \| public \| yes \| function rootFn\(\): void$/m);
  });

  it('rejects a bad command line', async () => {
    assert.equal((await main([], { root: fixture() })).status, 2);
    assert.equal((await main(['--write', '--check'], { root: fixture() })).status, 2);
  });
});
