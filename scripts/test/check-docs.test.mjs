/**
 * Tests for the docs compile gate (`website/scripts/check-docs.mjs`,
 * `website/scripts/docs-extract.mjs`, `scripts/gates/docs.mjs`): fence and
 * marker extraction, the ratchet against the ledger, and real `tsc` and
 * `node --test` runs over a fixture docs tree that compiles against a
 * hand-written `jsails` package, so no build is needed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  NO_CHECK_BUDGET,
  UNDOCUMENTED_SUBPATHS,
  apiReportFile,
  checkDocs,
  extractAll,
  idDiagnostic,
  judge,
  parseDiagnostics,
  publishedEntries,
  readApiReport,
  recordLedger,
  renderedDocument,
  resolveMarkers,
  sampleCompilerOptions,
} from '../../website/scripts/check-docs.mjs';
import {
  extractDocument,
  fenceKey,
  parseFenceAttributes,
  slugify,
} from '../../website/scripts/docs-extract.mjs';
import { fenceSyntax } from '../../website/scripts/docs-syntax.mjs';
import { loadGate } from '../run-gates.mjs';
import { readLedgers, validateLedger } from '../expected-failures.mjs';
import { repoRoot } from '../workspaces.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-test-'));
  roots.push(root);
  return root;
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const FENCE = '```';

describe('parseFenceAttributes', () => {
  it('accepts fragment, run, and no-check with a reason', () => {
    assert.deepEqual([...parseFenceAttributes(' fragment').flags], ['fragment']);
    const noCheck = parseFenceAttributes('no-check reason="needs a live database"');
    assert.deepEqual([...noCheck.flags], ['no-check']);
    assert.equal(noCheck.reason, 'needs a live database');
    assert.deepEqual(noCheck.problems, []);
  });

  it('rejects unknown words, a missing reason, and a stray reason', () => {
    assert.deepEqual(parseFenceAttributes('fragmnet').problems, [
      'unknown fence attribute "fragmnet"',
    ]);
    assert.deepEqual(parseFenceAttributes('no-check').problems, [
      'a no-check fence needs reason="<why it cannot compile>"',
    ]);
    assert.deepEqual(parseFenceAttributes('no-check reason=" "').problems, [
      'a no-check fence needs reason="<why it cannot compile>"',
    ]);
    assert.deepEqual(parseFenceAttributes('run reason="x"').problems, [
      'reason="…" belongs to no-check fences only',
    ]);
    assert.deepEqual(parseFenceAttributes('no-check fragment reason="x"').problems, [
      'no-check cannot be combined with fragment or run',
    ]);
    assert.deepEqual(parseFenceAttributes('run run').problems, ['repeated fence attribute "run"']);
    assert.deepEqual(parseFenceAttributes('fragment run').problems, [
      'run cannot be combined with fragment: a run fence must be a whole module',
    ]);
    assert.deepEqual(parseFenceAttributes('title="x"').problems, [
      'unknown fence attribute "title"',
    ]);
  });
});

describe('slugify', () => {
  it('follows GitHub heading slugs', () => {
    assert.equal(
      slugify('Autoloading: no imports for `project` code'),
      'autoloading-no-imports-for-project-code',
    );
    assert.equal(slugify('[Links](x.md) and <b>tags</b>'), 'links-and-tags');
  });
});

describe('extractDocument', () => {
  const page = [
    '---',
    'title: Page',
    '---',
    '',
    '# Jobs',
    '',
    `${FENCE}sh`,
    'npm test',
    FENCE,
    '',
    `${FENCE}ts`,
    "import { defineJob } from 'jsails';",
    FENCE,
    '',
    'Use `jsails/database#ApplicationRecord` and `defineJob()` and `jsails#nope()`.',
    '',
    '## Options',
    '',
    `${FENCE}js fragment`,
    'export default {};',
    FENCE,
    '',
    '- a list item:',
    '',
    `  ${FENCE}tsx`,
    '  const x = 1;',
    '    const y = 2;',
    `  ${FENCE}`,
    '',
    '## Options',
    '',
    `${FENCE}ts wrong`,
    'x',
    FENCE,
  ].join('\n');
  const { fences, markers, problems } = extractDocument(page, { source: 'docs/jobs.md' });

  it('extracts compiled fences with their opening line, anchor, and ordinal', () => {
    assert.deepEqual(
      fences.map((fence) => [fence.line, fence.language, fence.anchor, fence.ordinal]),
      [
        [11, 'ts', 'jobs', 1],
        [19, 'js', 'options', 1],
        [25, 'tsx', 'options', 2],
      ],
    );
    assert.equal(fences[0].body, "import { defineJob } from 'jsails';");
    assert.deepEqual([...fences[1].flags], ['fragment']);
    assert.equal(fenceKey(fences[2]), 'docs/jobs.md#options[2]');
  });

  it('dedents a fence nested in a list item', () => {
    assert.equal(fences[2].body, 'const x = 1;\n  const y = 2;');
  });

  it('gives a repeated heading a numbered anchor and reports bad attributes', () => {
    assert.deepEqual(problems, [
      {
        source: 'docs/jobs.md',
        line: 32,
        anchor: 'options-1[1]',
        message: 'unknown fence attribute "wrong"',
      },
    ]);
  });

  it('extracts only marked inline code, with line and column', () => {
    assert.deepEqual(
      markers.map((marker) => [
        marker.line,
        marker.column,
        marker.specifier,
        marker.name,
        marker.anchor,
      ]),
      [
        [15, 6, 'jsails/database', 'ApplicationRecord', 'jobs'],
        [15, 64, 'jsails', 'nope', 'jobs'],
      ],
    );
  });

  it('reports a fence that is never closed', () => {
    const unclosed = extractDocument(`# A\n\n${FENCE}ts\nconst x = 1;\n`, { source: 'a.md' });
    assert.deepEqual(unclosed.fences, []);
    assert.equal(unclosed.problems[0].message, 'code fence is never closed');
    assert.equal(unclosed.problems[0].line, 3);
  });
});

describe('extractAll', () => {
  it('keeps a fence or marker repeated across renderings of one source once', () => {
    const text = `# Guide\n\nSee \`jsails#x\`.\n\n${FENCE}ts\nconst a = 1;\n${FENCE}\n`;
    const { fences, markers } = extractAll([
      { source: 'g.ts', text },
      { source: 'g.ts', text },
    ]);
    assert.equal(fences.length, 1);
    assert.equal(markers.length, 1);
  });
});

describe('renderedDocument', () => {
  it('maps a rendered line to the source line holding its text', () => {
    const document = renderedDocument({
      source: 'guides.ts',
      sourceText: "const a = [\n  '# Title',\n  'Use `jsails#x` here.',\n];",
      text: '# Title\nUse `jsails#x` here.\nassembled ${value}',
    });
    assert.equal(document.mapLine(1), 2);
    assert.equal(document.mapLine(2), 3);
    assert.equal(document.mapLine(3), 1);
  });
});

describe('parseDiagnostics', () => {
  it('reads located, global, and continued diagnostics', () => {
    const output = [
      "fences/f0001.ts(2,10): error TS2305: Module '\"jsails\"' has no exported member 'nope'.",
      "fences/f0002.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Types of property 'a' are incompatible.",
      "error TS5083: Cannot read file 'x'.",
    ].join('\n');
    assert.deepEqual(parseDiagnostics(output), [
      {
        file: 'fences/f0001.ts',
        line: 2,
        column: 10,
        code: '2305',
        message: "Module '\"jsails\"' has no exported member 'nope'.",
      },
      {
        file: 'fences/f0002.ts',
        line: 1,
        column: 1,
        code: '2322',
        message:
          "Type 'string' is not assignable to type 'number'.\n  Types of property 'a' are incompatible.",
      },
      { file: undefined, line: 0, column: 0, code: '5083', message: "Cannot read file 'x'." },
    ]);
  });
});

describe('fenceSyntax', () => {
  it('lists the specifiers a fence imports, re-exports, or names in an import type', () => {
    const body = [
      "import { a } from 'jsails';",
      "import type { B } from '@jsails/admin/server';",
      "export { c } from 'jsails/jobs';",
      "import 'jsails/symbols';",
      "const d = await import('jsails/dev');",
      "type E = import('jsails/http').Request;",
      "import f = require('jsails/cache');",
    ].join('\n');
    assert.deepEqual([...fenceSyntax(body).imports].sort(), [
      '@jsails/admin/server',
      'jsails',
      'jsails/cache',
      'jsails/dev',
      'jsails/http',
      'jsails/jobs',
      'jsails/symbols',
    ]);
  });

  it('ignores imports in comments and strings', () => {
    const body = [
      "// see: import { x } from 'jsails/mail'",
      "/* export * from 'jsails/jobs'; */",
      'const text = "import { y } from \'jsails/cache\'";',
      'export {};',
    ].join('\n');
    assert.deepEqual([...fenceSyntax(body).imports], []);
  });

  it('parses js and tsx fences, and a fence with a syntax error', () => {
    assert.deepEqual(
      [...fenceSyntax("import { a } from 'jsails';\nconst = ;", '.ts').imports],
      ['jsails'],
    );
    assert.deepEqual(
      [...fenceSyntax("import { b } from 'jsails/x';\nexport const v = <div />;", '.tsx').imports],
      ['jsails/x'],
    );
    assert.deepEqual(
      [...fenceSyntax("import c from 'jsails/y';\nexport default c;", '.js').imports],
      ['jsails/y'],
    );
  });

  it('finds declarations that reach other files of the program', () => {
    const body = [
      '/// <reference lib="dom" />',
      '/// <reference types="node" />',
      '/// <reference path="./other.d.ts" />',
      'declare global { var leaked: string; }',
      "declare module 'jsails/http' { export const zz: number; }",
      'declare namespace Local { const x: number; }',
      'export {};',
    ].join('\n');
    assert.deepEqual(fenceSyntax(body).shared, [
      'declare global',
      "declare module 'jsails/http'",
      '/// <reference path="./other.d.ts" />',
      '/// <reference types="node" />',
      '/// <reference lib="dom" />',
    ]);
    assert.deepEqual(fenceSyntax('// declare global { var a: 1 }\nexport {};').shared, []);
  });

  it('requires a call to a node:assert binding or to t.assert', () => {
    const asserts = (body) => fenceSyntax(body).asserts;
    assert.equal(asserts("import assert from 'node:assert/strict';\nassert.equal(1, 1);"), true);
    assert.equal(asserts("import { ok } from 'node:assert';\nok(true);"), true);
    assert.equal(asserts("import * as a from 'node:assert';\na.strict.ok(true);"), true);
    assert.equal(asserts("test('x', (t) => { t.assert.ok(true); });"), true);
    assert.equal(asserts('console.log(1);'), false);
    assert.equal(asserts("import assert from 'node:assert';\n// assert.ok(true);"), false);
    assert.equal(asserts("// import assert from 'node:assert'\nassert.ok(true);"), false);
    assert.equal(asserts("import { ok } from 'jsails';\nok(true);"), false);
  });
});

describe('idDiagnostic', () => {
  const paths = { projectDir: tmpdir(), root: repoRoot };
  const id = (code, message) => idDiagnostic({ code, message }, paths);

  it('drops spelling suggestions and reports the code TypeScript uses without one', () => {
    assert.deepEqual(id('2552', "Cannot find name 'input'. Did you mean 'oninput'?"), {
      code: '2304',
      message: "Cannot find name 'input'.",
    });
    assert.deepEqual(
      id('2551', "Property 'nme' does not exist on type 'User'. Did you mean 'name'?"),
      { code: '2339', message: "Property 'nme' does not exist on type 'User'." },
    );
    assert.deepEqual(
      id('2724', `'"jsails"' has no exported member named 'defineJb'. Did you mean 'defineJob'?`),
      { code: '2305', message: `Module '"jsails"' has no exported member 'defineJb'.` },
    );
    assert.deepEqual(
      id(
        '2614',
        `Module '"jsails"' has no exported member 'x'. Did you mean to use 'import x from "jsails"' instead?`,
      ),
      { code: '2305', message: `Module '"jsails"' has no exported member 'x'.` },
    );
    assert.deepEqual(
      id(
        '2561',
        "Object literal may only specify known properties, but 'retry' does not exist in type 'JobOptions'. Did you mean to write 'retries'?",
      ),
      {
        code: '2353',
        message:
          "Object literal may only specify known properties, and 'retry' does not exist in type 'JobOptions'.",
      },
    );
    assert.deepEqual(id('2833', "Cannot find namespace 'Jsx'. Did you mean 'JSX'?"), {
      code: '2503',
      message: "Cannot find namespace 'Jsx'.",
    });
  });

  it('names a checkout inside the temporary directory by its own placeholder', () => {
    const outer = mkdtempSync(join(tmpdir(), 'jsails-docs-nest-'));
    try {
      const checkout = join(outer, 'checkout');
      mkdirSync(checkout);
      const nested = { projectDir: outer, root: checkout };
      assert.deepEqual(
        idDiagnostic(
          { code: '2307', message: `Cannot find module '${join(checkout, 'x')}'.` },
          nested,
        ),
        { code: '2307', message: "Cannot find module '<repo>/x'." },
      );
      assert.deepEqual(
        idDiagnostic(
          { code: '2307', message: `Cannot find module '${join(outer, 'f0001.ts')}'.` },
          nested,
        ),
        { code: '2307', message: "Cannot find module '<project>/f0001.ts'." },
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('writes the rest of a placeholder path with forward slashes', () => {
    assert.deepEqual(id('2307', `Cannot find module '${repoRoot}\\sub\\x.js'.`), {
      code: '2307',
      message: "Cannot find module '<repo>/sub/x.js'.",
    });
  });

  it('keeps the first line of other diagnostics, with paths as placeholders', () => {
    assert.deepEqual(
      id('2307', `Cannot find module '${join(repoRoot, 'x')}' or its type declarations.\n  more`),
      { code: '2307', message: "Cannot find module '<repo>/x' or its type declarations." },
    );
    assert.deepEqual(
      id(
        '2774',
        'This condition will always return true since this function is always defined. Did you mean to call it instead?',
      ),
      {
        code: '2774',
        message: 'This condition will always return true since this function is always defined.',
      },
    );
  });
});

describe('sample helpers', () => {
  it('makes the starter options check-only, module-per-file, and JS-checking', () => {
    const options = sampleCompilerOptions({ strict: true, outDir: 'dist', sourceMap: true });
    assert.deepEqual(options, {
      strict: true,
      rootDir: '.',
      noEmit: true,
      moduleDetection: 'force',
      allowJs: true,
      checkJs: true,
    });
  });

  it('lists published entries: { types, default } pairs of public workspaces', () => {
    const root = scratch();
    write(root, {
      'a/package.json': JSON.stringify({
        name: 'jsails',
        exports: {
          '.': { types: './i.d.ts', default: './i.js' },
          './jobs': { types: './j.d.ts', default: './j.js' },
          './package.json': './package.json',
        },
      }),
      'b/package.json': JSON.stringify({
        name: '@jsails/b',
        exports: { '.': { types: './i.d.ts', default: './i.js' } },
      }),
      'c/package.json': JSON.stringify({
        name: '@jsails/c',
        private: true,
        exports: { '.': { types: './i.d.ts', default: './i.js' } },
      }),
    });
    assert.deepEqual(publishedEntries([join(root, 'a'), join(root, 'b'), join(root, 'c')]), [
      '@jsails/b',
      'jsails',
      'jsails/jobs',
    ]);
  });

  it('gives every coverage exemption a reason, and each is published', () => {
    const published = publishedEntries();
    for (const [entry, reason] of UNDOCUMENTED_SUBPATHS) {
      assert.ok(reason.length > 0, entry);
      assert.ok(published.includes(entry), entry);
    }
  });
});

describe('marked references', () => {
  const report = (title, rows) =>
    `# ${title}\n\nEach line: …\n\n${FENCE}text\n${rows.join('\n')}\n${FENCE}\n`;

  it('finds the report file of an entry', () => {
    assert.equal(apiReportFile('/api', 'jsails'), join('/api', 'jsails', 'index.api.md'));
    assert.equal(
      apiReportFile('/api', 'jsails/i18n/server'),
      join('/api', 'jsails', 'i18n', 'server.api.md'),
    );
    assert.equal(
      apiReportFile('/api', '@jsails/admin'),
      join('/api', '@jsails', 'admin', 'index.api.md'),
    );
    assert.equal(
      apiReportFile('/api', '@jsails/admin/server'),
      join('/api', '@jsails', 'admin', 'server.api.md'),
    );
  });

  it('resolves names against the report and rejects unknown, missing, and internal ones', () => {
    const api = scratch();
    write(api, {
      'jsails/database.api.md': report('jsails/database', [
        'ApplicationRecord | class | untagged | yes | abstract class ApplicationRecord {}',
        'hidden | function | internal | yes | function hidden(): void',
      ]),
    });
    assert.deepEqual(
      [...readApiReport(join(api, 'jsails', 'database.api.md'))],
      [
        ['ApplicationRecord', 'untagged'],
        ['hidden', 'internal'],
      ],
    );
    const marker = (token, specifier, name) => ({
      source: 'core/AGENTS.md',
      line: 4,
      column: 9,
      anchor: 'models',
      token,
      specifier,
      name,
    });
    assert.deepEqual(
      resolveMarkers(
        [
          marker('jsails/database#ApplicationRecord', 'jsails/database', 'ApplicationRecord'),
          marker('jsails/database#Missing', 'jsails/database', 'Missing'),
          marker('jsails/database#hidden()', 'jsails/database', 'hidden'),
          marker('jsails/nowhere#X', 'jsails/nowhere', 'X'),
        ],
        api,
      ).map((finding) => [finding.where, finding.id]),
      [
        [
          'core/AGENTS.md:4:9',
          'core/AGENTS.md#models marker jsails/database#Missing: "jsails/database" does not export Missing',
        ],
        [
          'core/AGENTS.md:4:9',
          'core/AGENTS.md#models marker jsails/database#hidden(): hidden is @internal',
        ],
        [
          'core/AGENTS.md:4:9',
          'core/AGENTS.md#models marker jsails/nowhere#X: "jsails/nowhere" is not a published entry',
        ],
      ],
    );
  });
});

describe('judge and recordLedger', () => {
  const findings = [
    { id: 'a TS2305: x', where: 'a.md:3:1', message: 'TS2305: x' },
    { id: 'b TS2554: y', where: 'b.md:9:4', message: 'TS2554: y' },
  ];
  const ledger = (ids) => ({
    entries: ids.map((id) => ({ id, reason: `why ${id}`, fixedBy: 'KRN-24' })),
  });

  it('passes when every finding is listed', () => {
    assert.deepEqual(judge({ findings, errors: [] }, ledger(['a TS2305: x', 'b TS2554: y'])), []);
  });

  it('fails on a new finding, with its location, and on a listed one that is gone', () => {
    assert.deepEqual(judge({ findings, errors: [] }, ledger(['a TS2305: x', 'gone'])), [
      'b.md:9:4: TS2554: y\n    ledger id: b TS2554: y',
      'fixed: "gone" no longer occurs; remove it from docs.json',
    ]);
  });

  it('always fails on an error', () => {
    assert.deepEqual(judge({ findings: [], errors: ['bad'] }, ledger([])), ['bad']);
  });

  it("records today's findings, keeping the reason of a listed id", () => {
    const recorded = recordLedger({ findings }, ledger(['a TS2305: x', 'gone']));
    assert.equal(recorded.kind, 'gate');
    assert.equal(recorded.gate, 'docs');
    assert.deepEqual(recorded.entries, [
      { id: 'a TS2305: x', reason: 'why a TS2305: x', fixedBy: 'KRN-24' },
      {
        id: 'b TS2554: y',
        reason: 'The sample calls a function with the wrong number of arguments.',
        fixedBy: 'KRN-24',
      },
    ]);
    assert.deepEqual(validateLedger('docs.json', recorded), []);
  });
});

describe('checkDocs on a fixture docs tree', () => {
  let fixture;
  before(() => {
    fixture = scratch();
    write(fixture, {
      'node_modules/jsails/package.json': JSON.stringify({
        name: 'jsails',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'node_modules/jsails/index.d.ts': [
        'export interface JobOptions { readonly queue?: string; readonly retries?: number }',
        'export declare function defineJob(name: string, options: JobOptions): { name: string };',
      ].join('\n'),
      'node_modules/jsails/index.js': 'export function defineJob(name) { return { name }; }\n',
      'api/jsails/index.api.md': [
        '# jsails',
        '',
        `${FENCE}text`,
        'JobOptions | interface | untagged | yes | interface JobOptions {}',
        'defineJob | function | untagged | yes | function defineJob(): void',
        FENCE,
        '',
      ].join('\n'),
      'fixtures.d.ts': [
        'export {};',
        'declare global {',
        '  const queueName: string;',
        '}',
        '',
      ].join('\n'),
    });
    symlinkSync(
      join(repoRoot, 'node_modules', '@types'),
      join(fixture, 'node_modules', '@types'),
      'junction',
    );
  });

  const options = (documents, extra = {}) => ({
    repoRoot,
    documents,
    modulesDir: join(fixture, 'node_modules'),
    apiDir: join(fixture, 'api'),
    fixturesFile: join(fixture, 'fixtures.d.ts'),
    generateMeta: false,
    entries: ['jsails'],
    exemptions: new Map(),
    ...extra,
  });

  const page = [
    '# Jobs',
    '',
    `${FENCE}ts`,
    "import { defineJob, undefinedThing } from 'jsails';",
    FENCE,
    '',
    `${FENCE}ts`,
    "import { defineJob } from 'jsails';",
    "defineJob('mail');",
    FENCE,
    '',
    `${FENCE}ts`,
    "import { defineJob } from 'jsails';",
    "defineJob('mail', { queue: 'default', retry: 3 });",
    FENCE,
    '',
    '## Valid',
    '',
    `${FENCE}ts`,
    "import { defineJob } from 'jsails';",
    "export const job = defineJob('mail', { queue: 'default' });",
    FENCE,
    '',
    `${FENCE}ts`,
    'const broken = ;',
    FENCE,
    '',
    `${FENCE}ts fragment`,
    "import { defineJob } from 'jsails';",
    'defineJob(queueName, {});',
    FENCE,
    '',
    `${FENCE}ts`,
    'defineJob(queueName, {});',
    FENCE,
  ].join('\n');
  const guide = [
    '# Starter guide',
    '',
    'Models extend `jsails#ApplicationRecord`; jobs use `jsails#defineJob()`.',
  ].join('\n');

  it('reports each broken sample class with its file and line', async () => {
    const { findings, errors } = await checkDocs(
      options([
        { source: 'website/content/docs/jobs.md', text: page, page: true },
        { source: 'core/src/app/starter/guides.ts', text: guide },
      ]),
    );
    assert.deepEqual(errors, []);
    const byWhere = findings.map((finding) => [finding.where, finding.id]);
    assert.deepEqual(
      byWhere,
      [
        [
          'core/src/app/starter/guides.ts:3:16',
          'core/src/app/starter/guides.ts#starter-guide marker jsails#ApplicationRecord: "jsails" does not export ApplicationRecord',
        ],
        [
          'website/content/docs/jobs.md:25:16',
          'website/content/docs/jobs.md#valid[2] TS1109: Expression expected.',
        ],
        [
          'website/content/docs/jobs.md:34:1',
          "website/content/docs/jobs.md#valid[4] TS2304: Cannot find name 'defineJob'.",
        ],
        [
          'website/content/docs/jobs.md:34:11',
          "website/content/docs/jobs.md#valid[4] TS2304: Cannot find name 'queueName'.",
        ],
        [
          'website/content/docs/jobs.md:4:21',
          "website/content/docs/jobs.md#jobs[1] TS2305: Module '\"jsails\"' has no exported member 'undefinedThing'.",
        ],
        [
          'website/content/docs/jobs.md:9:1',
          'website/content/docs/jobs.md#jobs[2] TS2554: Expected 2 arguments, but got 1.',
        ],
        [
          'website/content/docs/jobs.md:14:39',
          "website/content/docs/jobs.md#jobs[3] TS2353: Object literal may only specify known properties, and 'retry' does not exist in type 'JobOptions'.",
        ],
      ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    );
  });

  it('fails a new broken fence that the ledger does not list', async () => {
    const result = await checkDocs(
      options([
        { source: 'website/content/docs/jobs.md', text: page.split('## Valid')[0], page: true },
      ]),
    );
    const listed = result.findings.filter((finding) => !finding.id.includes('TS2353'));
    const ledger = { entries: listed.map(({ id }) => ({ id, reason: 'r', fixedBy: 'KRN-24' })) };
    const failures = judge(result, ledger);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^website\/content\/docs\/jobs\.md:14:39: TS2353: /);
  });

  it('counts an entry as documented only through a docs-page fence that compiles cleanly', async () => {
    const broken = await checkDocs(
      options([
        { source: 'website/content/docs/jobs.md', text: page.split('## Valid')[0], page: true },
      ]),
    );
    assert.ok(
      broken.findings.some(
        (finding) => finding.id === 'entry jsails: no compiled docs sample imports it',
      ),
    );
    const clean = await checkDocs(
      options([{ source: 'website/content/docs/jobs.md', text: page, page: true }]),
    );
    assert.ok(!clean.findings.some((finding) => finding.id.startsWith('entry ')));
    const guideOnly = await checkDocs(
      options([{ source: 'core/AGENTS.md', text: page.split('# Jobs')[1].split('## Valid')[1] }]),
    );
    assert.ok(guideOnly.findings.some((finding) => finding.id.startsWith('entry jsails')));
  });

  it('runs a run fence under node --test and requires an assertion', async () => {
    const runs = [
      '# Runs',
      '',
      `${FENCE}ts run`,
      "import assert from 'node:assert/strict';",
      "import { defineJob } from 'jsails';",
      "assert.equal(defineJob('mail', {}).name, 'mail');",
      FENCE,
      '',
      `${FENCE}ts run`,
      "import assert from 'node:assert/strict';",
      "import { defineJob } from 'jsails';",
      "assert.equal(defineJob('mail', {}).name, 'post');",
      FENCE,
      '',
      `${FENCE}ts run`,
      "import { defineJob } from 'jsails';",
      "defineJob('mail', {});",
      FENCE,
    ].join('\n');
    const { findings, errors, stats } = await checkDocs(
      options([{ source: 'docs/runs.md', text: runs, page: true }]),
    );
    assert.deepEqual(errors, []);
    assert.equal(stats.runs, 3);
    assert.deepEqual(
      findings.map((finding) => [finding.where, finding.id]),
      [
        ['docs/runs.md:9', 'docs/runs.md#runs[2] run: fails under node --test'],
        ['docs/runs.md:15', 'docs/runs.md#runs[3] run: no assertion'],
      ],
    );
  });

  it('enforces the no-check budget and skips no-check fences', async () => {
    const fence = (index) =>
      `${FENCE}ts no-check reason="needs a server ${index}"\nconst = ;\n${FENCE}`;
    const within = Array.from({ length: NO_CHECK_BUDGET }, (_, index) => fence(index));
    const ok = await checkDocs(
      options([{ source: 'd.md', text: `# A\n\n${within.join('\n\n')}` }]),
    );
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(
      ok.findings.map((finding) => finding.id),
      ['entry jsails: no compiled docs sample imports it'],
    );
    const over = await checkDocs(
      options([{ source: 'd.md', text: `# A\n\n${[...within, fence(99)].join('\n\n')}` }]),
    );
    assert.equal(over.errors.length, 1);
    assert.match(
      over.errors[0],
      new RegExp(
        `^${NO_CHECK_BUDGET + 1} no-check fences exceed the budget of ${NO_CHECK_BUDGET}: d\\.md:3,`,
      ),
    );
  });

  it('fails on an invalid fence attribute, whatever the ledger says', async () => {
    const { errors } = await checkDocs(
      options([{ source: 'd.md', text: `# A\n\n${FENCE}ts fragmnet\nconst a = 1;\n${FENCE}` }]),
    );
    assert.deepEqual(errors, ['d.md:3: unknown fence attribute "fragmnet"']);
  });

  it('fails when the fixtures preamble itself does not compile', async () => {
    const broken = join(scratch(), 'fixtures.d.ts');
    writeFileSync(broken, 'export {};\ndeclare global {\n  const x: NoSuchType;\n}\n');
    const { errors } = await checkDocs(options([], { fixturesFile: broken, entries: [] }));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /^the sample project does not compile outside the samples: fixtures\/fixtures\.ts\(3,12\): TS2304: Cannot find name 'NoSuchType'\./,
    );
  });
  it('fails a run fragment, whatever the ledger says', async () => {
    const { errors } = await checkDocs(
      options([{ source: 'd.md', text: `# A\n\n${FENCE}ts fragment run\nqueueName;\n${FENCE}` }]),
    );
    assert.deepEqual(errors, [
      'd.md:3: run cannot be combined with fragment: a run fence must be a whole module',
    ]);
  });

  it(
    'ends when the fixtures preamble has a syntax error and fragments need passes',
    { timeout: 60_000 },
    async () => {
      const broken = join(scratch(), 'fixtures.d.ts');
      writeFileSync(broken, 'export {};\ndeclare global {\n  const x: ;\n}\n');
      const text = [
        '# A',
        '',
        `${FENCE}ts fragment`,
        'export const a = 1;',
        FENCE,
        '',
        `${FENCE}ts fragment`,
        'const b = ;',
        FENCE,
      ].join('\n');
      const { findings, errors } = await checkDocs(
        options([{ source: 'd.md', text }], { fixturesFile: broken, entries: [] }),
      );
      assert.deepEqual(errors, [
        'the sample project does not compile outside the samples: fixtures/fixtures.ts(3,12): TS1110: Type expected.',
      ]);
      assert.deepEqual(
        findings.map((finding) => finding.id),
        ['d.md#a[2] TS1109: Expression expected.'],
      );
    },
  );

  it('ends when a support declaration has a syntax error', { timeout: 60_000 }, async () => {
    const text = [
      '# A',
      '',
      `${FENCE}ts`,
      "import { defineJob } from 'jsails';",
      "export const job = defineJob('mail', {});",
      FENCE,
      '',
      `${FENCE}ts`,
      'const b = ;',
      FENCE,
      '',
      `${FENCE}ts fragment`,
      'export const c = queueName;',
      FENCE,
    ].join('\n');
    const { errors } = await checkDocs(
      options([{ source: 'd.md', text }], { metaStub: 'export declare const x: ;\n', entries: [] }),
    );
    assert.ok(errors.length > 0);
    for (const error of errors) {
      assert.match(
        error,
        /^the sample project does not compile outside the samples: \.jsails\/[\w.-]+\.d\.ts\(1,25\): TS1110: Type expected\.$/,
      );
    }
  });

  it('keeps a fence that declares into the shared scope out of every other fence', async () => {
    const text = [
      '# Leaks',
      '',
      `${FENCE}ts`,
      'declare global { var leakedGlobal: string; }',
      'export {};',
      FENCE,
      '',
      `${FENCE}ts`,
      'console.log(leakedGlobal.length);',
      FENCE,
      '',
      `${FENCE}ts`,
      "import 'jsails';",
      "declare module 'jsails' { export const zzLeak: number; }",
      FENCE,
      '',
      `${FENCE}ts`,
      "import { zzLeak } from 'jsails';",
      'console.log(zzLeak);',
      FENCE,
      '',
      `${FENCE}ts fragment`,
      'declare global { var leakedFragment: string; }',
      'export const own = queueName + leakedFragment;',
      FENCE,
      '',
      `${FENCE}ts fragment`,
      'export const other = leakedFragment;',
      FENCE,
    ].join('\n');
    const { findings, errors } = await checkDocs(
      options([{ source: 'd.md', text, page: true }], { entries: [] }),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      findings.map((finding) => finding.id),
      [
        "d.md#leaks[2] TS2304: Cannot find name 'leakedGlobal'.",
        `d.md#leaks[4] TS2305: Module '"jsails"' has no exported member 'zzLeak'.`,
        "d.md#leaks[6] TS2304: Cannot find name 'leakedFragment'.",
      ],
    );
  });

  it('does not count an import in a comment as documenting an entry', async () => {
    const text = `# A\n\n${FENCE}ts\n// see: import { defineJob } from 'jsails'\nexport {};\n${FENCE}`;
    const { findings } = await checkDocs(options([{ source: 'd.md', text, page: true }]));
    assert.deepEqual(
      findings.map((finding) => finding.id),
      ['entry jsails: no compiled docs sample imports it'],
    );
  });
});

describe('the committed gate', () => {
  it('meets the gate contract', async () => {
    const gate = await loadGate(join(repoRoot, 'scripts', 'gates', 'docs.mjs'));
    assert.equal(gate.name, 'docs');
    assert.equal(gate.needsBuild, true);
  });

  it('has a valid, non-empty ledger whose entries name the closing package', () => {
    const ledger = readLedgers().find((entry) => entry.name === 'docs');
    assert.ok(ledger !== undefined);
    assert.equal(ledger.kind, 'gate');
    assert.ok(ledger.entries.length > 0);
    for (const entry of ledger.entries) assert.equal(entry.fixedBy, 'KRN-24', entry.id);
  });
});
