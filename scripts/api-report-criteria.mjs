/**
 * The 1.0 inclusion criterion as checked data. `api/criteria.json` classifies
 * every workspace and every entry of its `exports` map: the target tier
 * (`public`, `experimental` or `internal`) and, for an entry or package that
 * leaves before 1.0, its `fate` (`delete` or `move`, the closing work package,
 * and a user-facing note). This module checks that classification against the
 * manifests, evaluates the criterion against the repository, and renders the
 * stability table of `website/content/docs/versioning.md` from it.
 *
 * The criterion, for a published entry that stays (tier `public` or
 * `experimental`, no fate):
 *   - `starter-or-guide`: a starter uses it (its specifier appears quoted in
 *     `core/templates/` or `core/src/app/starter/`), or a docs page has a code
 *     fence importing it (`website/content/docs/*.md`);
 *   - `test`: a test in its workspace imports the specifier, a module under the
 *     entry's source directory, or a source module that exports one of the
 *     entry's declarations (read through the API report model), or
 *     `scripts/verify-integrations.mjs` names it;
 *   - `versioning`: an owner-approved line, the entry's hand-written `versioning`
 *     sentence in `api/criteria.json` (what 1.0 commits to for it), which the
 *     versioning page's stability table carries. Nothing derives it: the
 *     classification alone (tier, fate) does not meet this piece, and adding
 *     the sentence is the reviewed approval.
 * And for a published package that stays:
 *   - `guide-sample`: a docs code fence imports one of its entries;
 *   - `integration-test`: a test under `test/integration/`, a
 *     `*.integration.test.ts(x)` or `*.database.test.ts(x)` file, or
 *     `scripts/verify-integrations.mjs` naming the package;
 *   - `verify-starter`: a starter preset or a verify:starter stage installs it
 *     (the package name appears quoted in `core/src/app/starter/`,
 *     `core/templates/` or `scripts/verify-starter/`).
 * Missing pieces are ids `<specifier> <piece>`, which
 * `scripts/gates/inclusion-criterion.mjs` ratchets against
 * `scripts/expected-failures/inclusion-criterion.json`.
 *
 * Usage: node scripts/api-report-criteria.mjs --write           regenerate the versioning table
 *        node scripts/api-report-criteria.mjs --report          print each entry's evidence
 *        node scripts/api-report-criteria.mjs --record-missing  rewrite the inclusion-criterion ledger
 *
 * `--record-missing` keeps the reason of every listed miss that still occurs,
 * drops the ones now met, and adds new ones with the default reason (closed by
 * KRN-26 for the four packages owner decision 9 keeps in 1.0, KRN-24 for the
 * rest); like any ledger change its diff is reviewed.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { buildModel, entriesOf, formatJson, identity, listWorkspaces } from './api-report.mjs';
import { repoRoot as defaultRoot } from './workspaces.mjs';

export const CRITERIA_FILE = 'api/criteria.json';
export const VERSIONING_PAGE = 'website/content/docs/versioning.md';
export const TABLE_START =
  '<!-- stability-table:start (generated from api/criteria.json by scripts/api-report-criteria.mjs --write) -->';
export const TABLE_END = '<!-- stability-table:end -->';
const TIERS = new Set(['public', 'experimental', 'internal']);
const FATES = new Set(['delete', 'move']);
const WORK_PACKAGE = /^[A-Z]+-\d+[a-z]?$/;
const FATE_KEYS = new Set(['action', 'to', 'by', 'note']);
const ENTRY_KEYS = new Set(['tier', 'fate', 'note', 'versioning']);
const PACKAGE_KEYS = new Set(['publish', 'fate', 'note', 'entries']);

const posix = (path) => path.split(sep).join('/');

function problemsOfFate(where, fate) {
  const problems = [];
  if (fate === null || typeof fate !== 'object' || Array.isArray(fate))
    return [`${where}: "fate" must be an object`];
  for (const key of Object.keys(fate))
    if (!FATE_KEYS.has(key)) problems.push(`${where}: unknown fate key "${key}"`);
  if (!FATES.has(fate.action)) problems.push(`${where}: fate.action is delete or move`);
  if (fate.action === 'move' && (typeof fate.to !== 'string' || fate.to === '')) {
    problems.push(`${where}: a move names its destination in fate.to`);
  }
  if (typeof fate.by !== 'string' || !WORK_PACKAGE.test(fate.by))
    problems.push(`${where}: fate.by names the work package`);
  if (typeof fate.note !== 'string' || fate.note.trim() === '')
    problems.push(`${where}: fate.note is the user-facing sentence`);
  if (/\b[A-Z]+-\d+[a-z]?\b/.test(fate.note ?? ''))
    problems.push(`${where}: fate.note is shown to users; name no work package`);
  return problems;
}

/** Whether a classified entry of a package record ships in 1.0: published, kept, not internal. */
function shipsInRelease(record, entry) {
  return (
    record.publish === true &&
    record.fate === undefined &&
    entry.tier !== 'internal' &&
    entry.fate === undefined
  );
}

/**
 * Problems with `criteria` against the workspaces: every workspace and every
 * entry is classified exactly once, `publish` mirrors `private`, and each
 * field is well formed.
 */
export function validateCriteria(criteria, workspaces) {
  const problems = [];
  if (criteria === null || typeof criteria !== 'object') return ['criteria.json must be an object'];
  if (typeof criteria.description !== 'string' || criteria.description.trim() === '') {
    problems.push('criteria.json: "description" is required');
  }
  const packages = criteria.packages ?? {};
  const names = new Set(workspaces.map((workspace) => workspace.name));
  for (const name of Object.keys(packages)) {
    if (!names.has(name)) problems.push(`${name}: classified but not a workspace`);
  }
  for (const workspace of workspaces) {
    const record = packages[workspace.name];
    if (record === undefined) {
      problems.push(`${workspace.name}: not classified in api/criteria.json`);
      continue;
    }
    for (const key of Object.keys(record)) {
      if (!PACKAGE_KEYS.has(key)) problems.push(`${workspace.name}: unknown key "${key}"`);
    }
    if (record.publish !== (workspace.manifest.private !== true)) {
      problems.push(
        `${workspace.name}: "publish" must be ${workspace.manifest.private !== true} (the manifest's "private" is ${workspace.manifest.private === true})`,
      );
    }
    if (record.fate !== undefined) problems.push(...problemsOfFate(workspace.name, record.fate));
    const entries = record.entries ?? {};
    const subpaths = new Set(entriesOf(workspace).map((entry) => entry.subpath));
    for (const subpath of Object.keys(entries)) {
      if (!subpaths.has(subpath))
        problems.push(`${workspace.name} ${subpath}: classified but not in exports`);
    }
    for (const subpath of subpaths) {
      const entry = entries[subpath];
      const where = `${workspace.name} ${subpath}`;
      if (entry === undefined) {
        problems.push(`${where}: not classified in api/criteria.json`);
        continue;
      }
      for (const key of Object.keys(entry))
        if (!ENTRY_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
      if (!TIERS.has(entry.tier))
        problems.push(`${where}: "tier" is public, experimental or internal`);
      if (entry.tier === 'experimental' && !/(^|\/)experimental$/.test(subpath)) {
        problems.push(`${where}: an experimental entry is an /experimental subpath`);
      }
      if (entry.fate !== undefined) problems.push(...problemsOfFate(where, entry.fate));
      if (entry.versioning !== undefined) {
        if (typeof entry.versioning !== 'string' || entry.versioning.trim() === '') {
          problems.push(`${where}: "versioning" is the owner-approved sentence`);
        } else if (/\b[A-Z]+-\d+[a-z]?\b/.test(entry.versioning)) {
          problems.push(`${where}: "versioning" is shown to users; name no work package`);
        }
        if (!shipsInRelease(record, entry)) {
          problems.push(`${where}: only an entry that ships in 1.0 carries a "versioning" line`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function walk(dir, accept, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

const quoted = (name) => new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`);
const FENCE = /^```(?:ts|tsx|js|jsx|mjs|typescript|javascript)\b[^\n]*\n([\s\S]*?)^```/gm;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** The repository facts the criterion reads, gathered once. */
export function gatherEvidence(root = defaultRoot) {
  const read = (path) => readFileSync(path, 'utf8');
  const starterTexts = [
    ...walk(join(root, 'core', 'templates'), () => true),
    ...walk(join(root, 'core', 'src', 'app', 'starter'), (path) => /\.tsx?$/.test(path)),
  ].map(read);
  const verifyStarterTexts = walk(join(root, 'scripts', 'verify-starter'), (path) =>
    path.endsWith('.mjs'),
  ).map(read);
  const integrationsPath = join(root, 'scripts', 'verify-integrations.mjs');
  const integrationsText = existsSync(integrationsPath) ? read(integrationsPath) : '';
  const docsImports = new Set();
  for (const page of walk(join(root, 'website', 'content', 'docs'), (path) =>
    path.endsWith('.md'),
  )) {
    for (const fence of read(page).matchAll(FENCE)) {
      for (const match of fence[1].matchAll(IMPORT_SPECIFIER)) docsImports.add(match[1]);
    }
  }
  const versioningPath = join(root, VERSIONING_PAGE);
  const versioningText = existsSync(versioningPath) ? read(versioningPath) : '';
  return { root, starterTexts, verifyStarterTexts, integrationsText, docsImports, versioningText };
}

const stem = (path) => path.replace(/\.(d\.ts|tsx?|jsx?|mjs)$/, '');

/** Test sources of a workspace with the extension-less files their relative imports resolve to. */
function testImports(dir) {
  return walk(join(dir, 'test'), (path) => /\.test\.tsx?$/.test(path)).map((file) => {
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);
    return {
      file,
      specifiers,
      targets: specifiers
        .filter((s) => s.startsWith('.'))
        .map((s) => stem(resolve(dirname(file), s))),
    };
  });
}

/**
 * What test imports reach, from the API report model: `entries` maps an entry
 * specifier to the identities of its exports, and `module(stem)` gives the
 * identities a source module exports (read from its `dist/src` declaration
 * file, so a barrel counts for what it re-exports).
 */
export function exportIndex(model) {
  const entries = new Map(
    model.entries.map((entry) => [
      entry.specifier,
      new Set(entry.exports.map((item) => item.identity)),
    ]),
  );
  const cache = new Map();
  const module = (sourceStem) => {
    if (cache.has(sourceStem)) return cache.get(sourceStem);
    const declaration = `${sourceStem.replace(`${sep}src${sep}`, `${sep}dist${sep}src${sep}`)}.d.ts`;
    let identities = new Set();
    if (existsSync(declaration)) {
      try {
        identities = new Set(
          [...model.graph.exportsOf(declaration).values()].map((binding) =>
            identity(binding, model.root),
          ),
        );
      } catch {
        // A declaration the report cannot follow proves nothing either way.
        identities = new Set();
      }
    }
    cache.set(sourceStem, identities);
    return identities;
  };
  return { entries, module };
}

/** The source directory an entry's barrel lives in (`src/support/` for `./support`). */
function entrySourceDir(workspaceDir, entry) {
  const dist = posix(relative(workspaceDir, dirname(entry.types)));
  return join(workspaceDir, dist.replace(/^dist\//, '')) + sep;
}

/** Text escaped for a Markdown table cell. */
const tableCell = (text) => text.replace(/\|/g, '\\|');

/** The versioning table row cells for an entry specifier, or null. */
function versioningRow(text, specifier) {
  const block = text.split(TABLE_START)[1]?.split(TABLE_END)[0] ?? '';
  return block.split('\n').find((line) => line.startsWith(`| \`${specifier}\` |`)) ?? null;
}

/**
 * Evaluates the criterion. Returns `{ evidence, missing }`: per-entry and
 * per-package evidence for `--report`, and the ids of missing pieces.
 */
export function evaluate(
  criteria,
  workspaces,
  facts,
  index = { entries: new Map(), module: () => new Set() },
) {
  const evidence = [];
  const missing = [];
  for (const workspace of workspaces) {
    const record = criteria.packages[workspace.name];
    if (record === undefined || record.publish !== true || record.fate !== undefined) continue;
    const tests = testImports(workspace.dir);
    const entries = entriesOf(workspace);
    let kept = 0;
    for (const entry of entries) {
      const classification = record.entries[entry.subpath];
      if (classification === undefined || !shipsInRelease(record, classification)) continue;
      kept += 1;
      const sourceDir = entrySourceDir(workspace.dir, entry);
      const exported = index.entries.get(entry.specifier) ?? new Set();
      const reaches = (target) => [...index.module(target)].some((id) => exported.has(id));
      const starter = facts.starterTexts.some((text) => quoted(entry.specifier).test(text));
      const guide = facts.docsImports.has(entry.specifier);
      const test =
        tests.some(
          (t) =>
            t.specifiers.includes(entry.specifier) ||
            t.targets.some((target) => target.startsWith(sourceDir) || reaches(target)),
        ) || quoted(entry.specifier).test(facts.integrationsText);
      const versioning =
        typeof classification.versioning === 'string' &&
        classification.versioning.trim() !== '' &&
        (versioningRow(facts.versioningText, entry.specifier) ?? '').includes(
          tableCell(classification.versioning),
        );
      evidence.push({ id: entry.specifier, starter, guide, test, versioning });
      if (!starter && !guide) missing.push(`${entry.specifier} starter-or-guide`);
      if (!test) missing.push(`${entry.specifier} test`);
      if (!versioning) missing.push(`${entry.specifier} versioning`);
    }
    if (kept === 0) continue;
    const guideSample = entries.some((entry) => facts.docsImports.has(entry.specifier));
    const integration =
      walk(join(workspace.dir, 'test'), (path) =>
        /(^|[\\/])integration[\\/].+\.test\.tsx?$|\.(integration|database)\.test\.tsx?$/.test(path),
      ).length > 0 || quoted(workspace.name).test(facts.integrationsText);
    const verifyStarter =
      workspace.name === 'jsails' ||
      [...facts.starterTexts, ...facts.verifyStarterTexts].some((text) =>
        quoted(workspace.name).test(text),
      );
    evidence.push({ id: `${workspace.name} (package)`, guideSample, integration, verifyStarter });
    if (!guideSample) missing.push(`${workspace.name} guide-sample`);
    if (!integration) missing.push(`${workspace.name} integration-test`);
    if (!verifyStarter) missing.push(`${workspace.name} verify-starter`);
  }
  return { evidence, missing: missing.sort() };
}

// ---------------------------------------------------------------------------
// The versioning page's stability table
// ---------------------------------------------------------------------------

const AT_RELEASE = { public: 'Stable', experimental: 'Experimental', internal: 'Internal' };

/** The stability table rendered from `criteria`, in workspace and manifest order. */
export function renderTable(criteria, workspaces) {
  const rows = ['| Entry | At 1.0 | Notes |', '| --- | --- | --- |'];
  for (const workspace of workspaces) {
    const record = criteria.packages[workspace.name];
    if (record === undefined || record.publish !== true) continue;
    for (const entry of entriesOf(workspace)) {
      const classification = record.entries?.[entry.subpath];
      if (classification === undefined) continue;
      const fate = classification.fate ?? record.fate;
      const plan =
        fate === undefined
          ? AT_RELEASE[classification.tier]
          : fate.action === 'move'
            ? 'Moves'
            : 'Removed';
      const note = [fate?.note, classification.note, classification.versioning]
        .filter(Boolean)
        .join(' ');
      rows.push(
        `| \`${entry.specifier}\` | ${plan} | ${tableCell(note)} |`.replace(/ {2}\|$/, ' |'),
      );
    }
  }
  return rows.join('\n');
}

/** The versioning page text with its table replaced; throws when the markers are missing. */
export function withTable(pageText, table) {
  const start = pageText.indexOf(TABLE_START);
  const end = pageText.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${VERSIONING_PAGE} has no stability-table markers`);
  }
  return `${pageText.slice(0, start + TABLE_START.length)}\n\n${table}\n\n${pageText.slice(end)}`;
}

/** Reads `api/criteria.json` under `root`. */
export function readCriteria(root = defaultRoot) {
  return JSON.parse(readFileSync(join(root, CRITERIA_FILE), 'utf8'));
}

/**
 * Every structural problem: classification, and a stale versioning table.
 * The criterion's own misses are ratcheted separately.
 */
export function structuralProblems(root = defaultRoot) {
  const workspaces = listWorkspaces(root);
  let criteria;
  try {
    criteria = readCriteria(root);
  } catch (error) {
    return {
      problems: [`${CRITERIA_FILE} cannot be read: ${error.message}`],
      criteria: null,
      workspaces,
    };
  }
  const problems = validateCriteria(criteria, workspaces);
  if (problems.length === 0) {
    const pagePath = join(root, VERSIONING_PAGE);
    if (!existsSync(pagePath)) problems.push(`${VERSIONING_PAGE} is missing`);
    else {
      const page = readFileSync(pagePath, 'utf8');
      try {
        if (withTable(page, renderTable(criteria, workspaces)) !== page) {
          problems.push(
            `${VERSIONING_PAGE}: the stability table is stale; run node scripts/api-report-criteria.mjs --write`,
          );
        }
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  return { problems, criteria, workspaces };
}

export const MISSING_LEDGER = 'scripts/expected-failures/inclusion-criterion.json';

/** Packages owner decision 9 ships in 1.0; KRN-26 makes them meet the criterion. */
export const DECISION_9_PACKAGES = Object.freeze([
  '@jsails/ai',
  '@jsails/inertia',
  '@jsails/mcp',
  '@jsails/tenancy',
]);

const MISSING_REASONS = Object.freeze({
  'integration-test':
    'No integration test: nothing under test/integration/, no *.integration.test.ts or *.database.test.ts, and no verify:integrations stage names the package.',
  'verify-starter': 'No starter preset or verify:starter stage installs the package.',
  'guide-sample': 'No docs page has a code sample that imports the package.',
  'starter-or-guide': 'Neither a starter nor a docs code sample imports this entry.',
  test: 'No test imports this entry or a module that exports its declarations.',
  versioning:
    'No owner-approved versioning line: the entry has no "versioning" sentence in api/criteria.json.',
});

/** The package an id `<specifier> <piece>` belongs to. */
function packageOfId(id) {
  const specifier = id.slice(0, id.lastIndexOf(' '));
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

/** The ledger document for the current misses, keeping existing reasons. */
export function recordMissing(missing, previous) {
  const kept = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const entries = missing.map((id) => {
    const existing = kept.get(id);
    if (existing !== undefined) return existing;
    const piece = id.slice(id.lastIndexOf(' ') + 1);
    const decision9 = DECISION_9_PACKAGES.includes(packageOfId(id));
    return {
      id,
      reason: decision9
        ? `Ships in 1.0 (owner decision 9). ${MISSING_REASONS[piece]}`
        : MISSING_REASONS[piece],
      fixedBy: decision9 ? 'KRN-26' : 'KRN-24',
    };
  });
  return {
    description:
      previous?.description ??
      'Pieces of the 1.0 inclusion criterion (scripts/api-report-criteria.mjs) that published entries and packages miss today, ratcheted by scripts/gates/inclusion-criterion.mjs.',
    kind: 'gate',
    gate: 'inclusion-criterion',
    entries,
  };
}

async function main(argv) {
  const root = defaultRoot;
  if (argv[0] === '--record-missing') {
    const { problems, criteria, workspaces } = structuralProblems(root);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      return 1;
    }
    const model = await buildModel({ root });
    const { missing } = evaluate(criteria, workspaces, gatherEvidence(root), exportIndex(model));
    const path = join(root, MISSING_LEDGER);
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const document = recordMissing(missing, previous);
    writeFileSync(path, await formatJson(root, MISSING_LEDGER, document));
    console.log(`recorded ${document.entries.length} miss(es) in ${MISSING_LEDGER}`);
    return 0;
  }
  if (argv[0] === '--write') {
    const workspaces = listWorkspaces(root);
    const criteria = readCriteria(root);
    const problems = validateCriteria(criteria, workspaces);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      return 1;
    }
    const pagePath = join(root, VERSIONING_PAGE);
    writeFileSync(
      pagePath,
      withTable(readFileSync(pagePath, 'utf8'), renderTable(criteria, workspaces)),
    );
    console.log(`updated the stability table in ${VERSIONING_PAGE}`);
    return 0;
  }
  if (argv[0] === '--report') {
    const { problems, criteria, workspaces } = structuralProblems(root);
    for (const problem of problems) console.error(problem);
    if (criteria === null) return 1;
    const model = await buildModel({ root });
    const { evidence, missing } = evaluate(
      criteria,
      workspaces,
      gatherEvidence(root),
      exportIndex(model),
    );
    for (const item of evidence) console.log(JSON.stringify(item));
    console.log(`missing: ${missing.length}`);
    for (const id of missing) console.log(`  ${id}`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error(
    'usage: node scripts/api-report-criteria.mjs --write | --report | --record-missing',
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
