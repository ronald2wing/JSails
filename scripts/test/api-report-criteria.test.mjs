/**
 * Tests for `scripts/api-report-criteria.mjs` and the `inclusion-criterion`
 * gate: classification checks against the manifests, each piece of the 1.0
 * inclusion criterion on a fixture repository, the generated stability table,
 * and the ratchet; plus the repository's own classification.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { buildModel, listWorkspaces, loadParser } from '../api-report.mjs';
import {
  TABLE_END,
  TABLE_START,
  evaluate,
  exportIndex,
  gatherEvidence,
  readCriteria,
  recordMissing,
  renderTable,
  structuralProblems,
  validateCriteria,
  withTable,
} from '../api-report-criteria.mjs';
import { judge } from '../gates/inclusion-criterion.mjs';

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
const PAGE = `---\ntitle: V\n---\n\n# V\n\n${TABLE_START}\n${TABLE_END}\n`;

const CRITERIA = {
  description: 'fixture',
  packages: {
    kit: {
      publish: true,
      entries: {
        '.': { tier: 'public', versioning: 'Semver covers `run`.' },
        './extra': { tier: 'public' },
        './old': { tier: 'public', fate: { action: 'delete', by: 'KRN-06', note: 'Removed.' } },
      },
    },
    '@x/lonely': { publish: true, entries: { '.': { tier: 'public' } } },
    hidden: { publish: false, entries: { '.': { tier: 'internal' } } },
  },
};

/**
 * `kit` meets everything for `.` (starter, guide, test, an owner-written
 * versioning line, integration test, verify:starter); `./extra` is tested only
 * through a module that declares its export and has no versioning line;
 * `@x/lonely` meets nothing.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jsails-criteria-'));
  roots.push(root);
  write(root, {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/kit/package.json': JSON.stringify({
      name: 'kit',
      exports: {
        '.': entry('index'),
        './extra': entry('extra/index'),
        './old': entry('old/index'),
      },
    }),
    'packages/kit/dist/src/index.d.ts':
      '/** h */\n/** Run. @public */\nexport declare function run(): void;\n',
    'packages/kit/dist/src/extra/index.d.ts':
      "/** h */\nexport { extra } from '../shared/extra.js';\n",
    'packages/kit/dist/src/shared/extra.d.ts':
      '/** h */\n/** E. @public */\nexport declare const extra: 1;\n',
    'packages/kit/dist/src/old/index.d.ts': '/** h */\nexport declare const old: 1;\n',
    'packages/kit/test/run.test.ts': "import { run } from '../src/index.js';\n",
    'packages/kit/test/shared.test.ts': "import { extra } from '../src/shared/extra.js';\n",
    'packages/kit/test/integration/app.test.ts': "import 'kit';\n",
    'packages/lonely/package.json': JSON.stringify({
      name: '@x/lonely',
      exports: { '.': entry('index') },
    }),
    'packages/lonely/dist/src/index.d.ts': '/** h */\nexport declare const lonely: 1;\n',
    'packages/hidden/package.json': JSON.stringify({
      name: 'hidden',
      private: true,
      exports: { '.': entry('index') },
    }),
    'core/templates/starter/app.js.template': "import { run } from 'kit';\n",
    'core/src/app/starter/presets.ts': "export const deps = { 'kit': '^1' };\n",
    'website/content/docs/kit.md': "# Kit\n\n```ts\nimport { run } from 'kit';\n```\n",
    'website/content/docs/versioning.md': PAGE,
    'api/criteria.json': JSON.stringify(CRITERIA),
  });
  return root;
}

async function missingIn(root) {
  const workspaces = listWorkspaces(root);
  const model = await buildModel({ root, parseSync });
  return evaluate(readCriteria(root), workspaces, gatherEvidence(root), exportIndex(model)).missing;
}

describe('validateCriteria', () => {
  it('accepts a complete classification', () => {
    assert.deepEqual(validateCriteria(CRITERIA, listWorkspaces(fixture())), []);
  });

  it('reports unclassified, extra and malformed records', () => {
    const workspaces = listWorkspaces(fixture());
    const broken = {
      description: 'x',
      packages: {
        kit: {
          publish: false,
          entries: {
            '.': { tier: 'stable' },
            './gone': { tier: 'public' },
            './extra': { tier: 'experimental' },
            './old': {
              tier: 'public',
              fate: { action: 'drop', by: 'later', note: 'Gone in KRN-06.' },
              versioning: 'Kept until KRN-06.',
            },
          },
        },
        stray: { publish: true, entries: {} },
        hidden: { publish: false, entries: { '.': { tier: 'internal' } } },
      },
    };
    assert.deepEqual(validateCriteria(broken, workspaces), [
      'stray: classified but not a workspace',
      'kit: "publish" must be true (the manifest\'s "private" is false)',
      'kit ./gone: classified but not in exports',
      'kit .: "tier" is public, experimental or internal',
      'kit ./extra: an experimental entry is an /experimental subpath',
      'kit ./old: fate.action is delete or move',
      'kit ./old: fate.by names the work package',
      'kit ./old: fate.note is shown to users; name no work package',
      'kit ./old: "versioning" is shown to users; name no work package',
      'kit ./old: only an entry that ships in 1.0 carries a "versioning" line',
      '@x/lonely: not classified in api/criteria.json',
    ]);
  });
});

describe('evaluate', () => {
  it('lists every missing piece and nothing for an entry that meets the criterion', async () => {
    const root = fixture();
    write(root, {
      'website/content/docs/versioning.md': withTable(
        PAGE,
        renderTable(CRITERIA, listWorkspaces(root)),
      ),
    });
    assert.deepEqual(await missingIn(root), [
      '@x/lonely guide-sample',
      '@x/lonely integration-test',
      '@x/lonely starter-or-guide',
      '@x/lonely test',
      '@x/lonely verify-starter',
      '@x/lonely versioning',
      'kit/extra starter-or-guide',
      'kit/extra versioning',
    ]);
  });

  it('meets the versioning piece only with an owner-written line the page carries', async () => {
    const root = fixture();
    const current = () =>
      write(root, {
        'website/content/docs/versioning.md': withTable(
          PAGE,
          renderTable(readCriteria(root), listWorkspaces(root)),
        ),
      });
    // A table row generated from the classification alone is not an approval.
    current();
    assert.ok((await missingIn(root)).includes('kit/extra versioning'));
    // The written line counts once the page carries it, not before.
    const criteria = structuredClone(CRITERIA);
    criteria.packages.kit.entries['./extra'].versioning = 'Semver covers `extra`.';
    write(root, { 'api/criteria.json': JSON.stringify(criteria) });
    assert.ok((await missingIn(root)).includes('kit/extra versioning'));
    current();
    const missing = await missingIn(root);
    assert.ok(!missing.includes('kit/extra versioning'));
    assert.ok(!missing.includes('kit versioning'));
    assert.ok(
      !missing.some((id) => id.startsWith('kit/old')),
      'an entry with a fate is not judged',
    );
    assert.ok(!missing.some((id) => id.startsWith('hidden')), 'a private package is not judged');
  });

  it('rejects an empty versioning line', () => {
    const criteria = structuredClone(CRITERIA);
    criteria.packages.kit.entries['./extra'].versioning = ' ';
    assert.deepEqual(validateCriteria(criteria, listWorkspaces(fixture())), [
      'kit ./extra: "versioning" is the owner-approved sentence',
    ]);
  });
});

describe('stability table', () => {
  it('renders tiers and fates and replaces the marked block', () => {
    const root = fixture();
    const table = renderTable(CRITERIA, listWorkspaces(root));
    assert.equal(
      table,
      [
        '| Entry | At 1.0 | Notes |',
        '| --- | --- | --- |',
        '| `kit` | Stable | Semver covers `run`. |',
        '| `kit/extra` | Stable | |',
        '| `kit/old` | Removed | Removed. |',
        '| `@x/lonely` | Stable | |',
      ].join('\n'),
    );
    assert.equal(
      withTable(PAGE, 'T'),
      `---\ntitle: V\n---\n\n# V\n\n${TABLE_START}\n\nT\n\n${TABLE_END}\n`,
    );
    assert.throws(() => withTable('# no markers', 'T'), /no stability-table markers/);
  });

  it('reports a stale table as a structural problem', () => {
    const root = fixture();
    assert.deepEqual(structuralProblems(root).problems, [
      'website/content/docs/versioning.md: the stability table is stale; run node scripts/api-report-criteria.mjs --write',
    ]);
    write(root, {
      'website/content/docs/versioning.md': withTable(
        PAGE,
        renderTable(CRITERIA, listWorkspaces(root)),
      ),
    });
    assert.deepEqual(structuralProblems(root).problems, []);
  });
});

describe('inclusion-criterion gate', () => {
  const ledger = (ids) => ({
    kind: 'gate',
    entries: ids.map((id) => ({ id, reason: 'r', fixedBy: 'KRN-24' })),
  });

  it('passes when the misses equal the ledger', () => {
    assert.deepEqual(judge(['a test'], ledger(['a test'])), []);
  });

  it('fails on a new miss and on a met piece still listed', () => {
    assert.deepEqual(judge(['a test', 'b versioning'], ledger(['a test', 'c guide-sample'])), [
      'newly missing: b versioning (see the criterion in scripts/api-report-criteria.mjs)',
      'now met: "c guide-sample"; remove it from inclusion-criterion.json',
    ]);
  });
});

describe('recordMissing', () => {
  it('keeps listed reasons, drops met pieces, and routes new misses by package', () => {
    const previous = {
      description: 'd',
      kind: 'gate',
      gate: 'inclusion-criterion',
      entries: [
        { id: 'kit test', reason: 'custom', fixedBy: 'KRN-24' },
        { id: 'kit versioning', reason: 'r', fixedBy: 'KRN-24' },
      ],
    };
    const next = recordMissing(
      ['kit test', '@jsails/mcp/server integration-test', 'jsails/semver guide-sample'],
      previous,
    );
    assert.equal(next.description, 'd');
    assert.deepEqual(
      next.entries.map((e) => [e.id, e.fixedBy]),
      [
        ['kit test', 'KRN-24'],
        ['@jsails/mcp/server integration-test', 'KRN-26'],
        ['jsails/semver guide-sample', 'KRN-24'],
      ],
    );
    assert.equal(next.entries[0].reason, 'custom');
    assert.match(
      next.entries[1].reason,
      /^Ships in 1\.0 \(owner decision 9\)\. No integration test/,
    );
  });
});

describe('the repository classification', () => {
  it('classifies every workspace and entry, with a current versioning table', () => {
    assert.deepEqual(structuralProblems().problems, []);
  });

  it('keeps the four packages owner decision 9 ships in 1.0 public and published', () => {
    const criteria = readCriteria();
    for (const name of ['@jsails/inertia', '@jsails/ai', '@jsails/tenancy', '@jsails/mcp']) {
      const record = criteria.packages[name];
      assert.equal(record.publish, true, name);
      assert.equal(record.fate, undefined, name);
      for (const [subpath, classification] of Object.entries(record.entries)) {
        assert.equal(classification.tier, 'public', `${name} ${subpath}`);
        assert.equal(classification.fate, undefined, `${name} ${subpath}`);
      }
    }
  });
});
