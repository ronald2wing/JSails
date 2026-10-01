/**
 * The expected-failure ledgers: one directory (`scripts/expected-failures/`),
 * one JSON shape, and the one reader every runner and gate uses.
 *
 * A ledger records today's known failures so a harness can state correct
 * behaviour before the fix exists. It may only shrink: a listed failure that
 * stops failing fails the run until its entry is removed, and a failure that is
 * not listed fails the run as usual.
 *
 * `scripts/expected-failures/<name>.json` (kebab-case name):
 *
 *   {
 *     "description": "What this ledger covers and which package owns it.",
 *     "kind": "tests" | "gate",
 *     "gate": "<gate name>",            // kind "gate" only: scripts/gates/<gate>.mjs
 *     "entries": [ ... ]
 *   }
 *
 * A `tests` entry names a real node:test test that fails today, and how:
 *
 *   {
 *     "file": "core/test/server/conformance/scope-matrix.test.ts",
 *     "test": ["scope matrix", "mounted app sees the tenant"],  // name path; omit = whole file
 *     "failure": {                     // required with "test"
 *       "message": "tenant",           // regex the failure's message must match
 *       "name": "AssertionError",      // optional: the thrown error's class
 *       "type": "testCodeFailure"      // optional: node's failureType (see below)
 *     },
 *     "reason": "A mounted app runs outside the request scope.",
 *     "fixedBy": "REQ-05",
 *     "platforms": ["win32"],          // optional: process.platform values it applies to
 *     "databases": ["postgres"],       // optional: sqlite | mariadb | postgres
 *     "services": ["valkey"]           // optional: live services the run must declare
 *   }
 *
 * `file` is the source path, from the repo root, of the test file whose process
 * ran the test, even when the `describe`/`test` calls live in a shared module
 * or a package's `src/` (a conformance suite); `test` is the list of names from
 * the outermost `describe`/`test` down to the failing test.
 *
 * `failure` states why the test fails, so a listed test that starts failing
 * for another reason (a `TypeError` in its fixture, a timeout, a failing hook)
 * is an unexpected failure instead of staying green. `type` defaults to
 * `testCodeFailure` (the test body threw or an assertion failed); a timeout
 * (`testTimeoutFailure`) or a failing hook (`hookFailed`) is expected only when
 * named.
 *
 * Without `test`, the entry covers every failure in the file, and the file must
 * fail. That is the entry for a file that cannot load or whose process fails
 * (`processFailure`: an unhandled rejection or uncaught exception anywhere in
 * it, `process.exit()` from test code, an unexpected exit status; see
 * `scripts/test-preload.mjs`). Its `failure` is optional; without one it
 * matches every failure type except a timeout.
 *
 * The database of a run is `sqlite` for the default suite and `DATABASE_TYPE`
 * for the `database` suite (`scripts/run-tests.mjs --suite=database`), which
 * runs only `*.database.test.ts(x)` files; an entry scoped to `mariadb` or
 * `postgres` must therefore name such a file.
 *
 * A run declares the live services it was given in `JSAILS_TEST_SERVICES`
 * (comma-separated, from `SERVICES`); `scripts/verify-integrations.mjs` sets
 * it for the suites it runs against a real service. An entry with `services`
 * applies only to a run that declares every one of them, so a test that is
 * skipped without its service (an opt-in live test) can list how it fails
 * with it without failing the default suite, where it is skipped.
 *
 * A `gate` entry is one violation a ratcheting gate tolerates today:
 * `{ "id": "<gate-specific key>", "reason": "...", "fixedBy": "KRN-22" }`. The
 * gate computes its current violations and calls `ratchet()`. A gate ledger's
 * file is named after its gate (`<gate>.json`), so a gate has one ledger.
 *
 * Canonical ledgers (one per cluster or gate; never a ledger beside a test):
 * tests ledgers `request` (REQ-01), `data` (DAT-01), `security` (SEC-01),
 * `marketplace` (MKT-01), `jobs` (JOB-01), `jamal` (JOB-10), `content` (CNT-01), and the platform
 * legs `windows` (KRN-02) and `macos`, whose entries must be scoped to that
 * platform; gate ledgers are named after their gate (`import-direction`,
 * `api-untagged`, `docs`, `data-specs`, ...).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { repoRoot } from './workspaces.mjs';

export const LEDGER_DIR = join(repoRoot, 'scripts', 'expected-failures');

const LEDGER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const FIXED_BY = /^[A-Z]+-\d+[a-z]?$/;
const TEST_FILE = /^(?:core|packages\/[a-z0-9-]+)\/test\/.+\.test\.tsx?$/;
const DATABASE_TEST_FILE = /\.database\.test\.tsx?$/;
const ERROR_NAME = /^[A-Za-z_$][\w$]*$/;
export const PLATFORMS = Object.freeze(['linux', 'darwin', 'win32']);
export const DATABASES = Object.freeze(['sqlite', 'mariadb', 'postgres']);
/** The live services a run can declare (`JSAILS_TEST_SERVICES`) and an entry can need. */
export const SERVICES = Object.freeze(['valkey']);
const SERVER_DATABASES = new Set(['mariadb', 'postgres']);
/**
 * The failure types an entry can name: node:test's own, plus `processFailure`,
 * which `scripts/run-tests.mjs` reports for a file whose process failed.
 */
export const FAILURE_TYPES = Object.freeze([
  'testCodeFailure',
  'hookFailed',
  'testTimeoutFailure',
  'processFailure',
]);
const FAILURE_KEYS = new Set(['message', 'name', 'type']);
/** Platform-leg ledgers: every entry must be scoped to exactly that platform. */
export const PLATFORM_LEDGERS = Object.freeze({ 'windows.json': 'win32', 'macos.json': 'darwin' });
const LEDGER_KEYS = new Set(['description', 'kind', 'gate', 'entries']);
const TEST_ENTRY_KEYS = new Set([
  'file',
  'test',
  'failure',
  'reason',
  'fixedBy',
  'platforms',
  'databases',
  'services',
]);
const GATE_ENTRY_KEYS = new Set(['id', 'reason', 'fixedBy']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkSubset(where, field, value, allowed, errors) {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    !value.every((item) => allowed.includes(item))
  ) {
    errors.push(`${where}: "${field}" must be a non-empty list of distinct ${allowed.join('|')}`);
  }
}

/** Problems with a tests entry's `failure` (required, with a message, per test). */
function checkFailure(where, entry, errors) {
  const { failure } = entry;
  if (failure === undefined) {
    if (entry.test !== undefined) {
      errors.push(
        `${where}: "failure" is required: { "message": "<regex the failure's message matches>" }`,
      );
    }
    return;
  }
  if (failure === null || typeof failure !== 'object' || Array.isArray(failure)) {
    errors.push(`${where}: "failure" must be an object`);
    return;
  }
  const keys = Object.keys(failure);
  for (const key of keys) {
    if (!FAILURE_KEYS.has(key)) errors.push(`${where}: unknown "failure" key "${key}"`);
  }
  if (keys.length === 0) errors.push(`${where}: "failure" names at least one of message|name|type`);
  if (failure.message !== undefined || entry.test !== undefined) {
    if (!isNonEmptyString(failure.message)) {
      errors.push(`${where}: "failure.message" is a non-empty regular expression`);
    } else {
      try {
        new RegExp(failure.message);
      } catch {
        errors.push(`${where}: "failure.message" is not a valid regular expression`);
      }
    }
  }
  if (
    failure.name !== undefined &&
    !(typeof failure.name === 'string' && ERROR_NAME.test(failure.name))
  ) {
    errors.push(`${where}: "failure.name" is an error class name such as AssertionError`);
  }
  if (failure.type !== undefined) {
    if (!FAILURE_TYPES.includes(failure.type)) {
      errors.push(`${where}: "failure.type" must be one of ${FAILURE_TYPES.join('|')}`);
    } else if (failure.type === 'processFailure' && entry.test !== undefined) {
      errors.push(`${where}: a processFailure belongs to the whole file; omit "test"`);
    }
  }
}

/** The identity of a tests entry or result: file plus name path (`*` = whole file). */
export function testKey(file, path) {
  return path === undefined ? `${file} :: *` : `${file} :: ${JSON.stringify(path)}`;
}

/**
 * Structural problems in one parsed ledger, as messages (empty when valid).
 * `root` resolves `file` paths and gate modules.
 */
export function validateLedger(name, ledger, { root = repoRoot } = {}) {
  const errors = [];
  if (!LEDGER_NAME.test(name)) errors.push(`${name}: ledger file names are kebab-case .json`);
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return [...errors, `${name}: must be a JSON object`];
  }
  for (const key of Object.keys(ledger)) {
    if (!LEDGER_KEYS.has(key)) errors.push(`${name}: unknown key "${key}"`);
  }
  if (!isNonEmptyString(ledger.description)) errors.push(`${name}: "description" is required`);
  if (ledger.kind !== 'tests' && ledger.kind !== 'gate') {
    errors.push(`${name}: "kind" must be "tests" or "gate"`);
  }
  if (ledger.kind === 'gate') {
    if (!isNonEmptyString(ledger.gate)) {
      errors.push(`${name}: a gate ledger names its "gate"`);
    } else if (!existsSync(join(root, 'scripts', 'gates', `${ledger.gate}.mjs`))) {
      errors.push(`${name}: gate "${ledger.gate}" has no scripts/gates/${ledger.gate}.mjs`);
    } else if (name !== `${ledger.gate}.json`) {
      // One file per gate: two ledgers naming one gate would leave one unread.
      errors.push(`${name}: the ledger of gate "${ledger.gate}" is ${ledger.gate}.json`);
    }
  } else if (ledger.gate !== undefined) {
    errors.push(`${name}: "gate" belongs to gate ledgers only`);
  }
  if (!Array.isArray(ledger.entries)) return [...errors, `${name}: "entries" must be an array`];

  const seen = new Set();
  const wholeFiles = new Set();
  const testedFiles = new Set();
  ledger.entries.forEach((entry, index) => {
    const where = `${name} entry ${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const allowed = ledger.kind === 'gate' ? GATE_ENTRY_KEYS : TEST_ENTRY_KEYS;
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) errors.push(`${where}: unknown key "${key}"`);
    }
    if (!isNonEmptyString(entry.reason)) errors.push(`${where}: "reason" is required`);
    if (typeof entry.fixedBy !== 'string' || !FIXED_BY.test(entry.fixedBy)) {
      errors.push(`${where}: "fixedBy" names the closing work package (for example REQ-05)`);
    }
    if (ledger.kind === 'gate') {
      if (!isNonEmptyString(entry.id)) errors.push(`${where}: "id" is required`);
      else if (seen.has(entry.id)) errors.push(`${where}: duplicate id ${entry.id}`);
      else seen.add(entry.id);
      return;
    }
    if (typeof entry.file !== 'string' || !TEST_FILE.test(entry.file)) {
      errors.push(`${where}: "file" is a test source path such as core/test/x.test.ts`);
      return;
    }
    if (!existsSync(join(root, entry.file))) errors.push(`${where}: ${entry.file} does not exist`);
    if (entry.test !== undefined) {
      if (
        !Array.isArray(entry.test) ||
        entry.test.length === 0 ||
        !entry.test.every((part) => isNonEmptyString(part))
      ) {
        errors.push(`${where}: "test" is the non-empty list of names down to the test`);
        return;
      }
      testedFiles.add(entry.file);
    } else {
      wholeFiles.add(entry.file);
    }
    checkFailure(where, entry, errors);
    checkSubset(where, 'platforms', entry.platforms, PLATFORMS, errors);
    const legPlatform = PLATFORM_LEDGERS[name];
    if (
      legPlatform !== undefined &&
      (entry.platforms?.length !== 1 || entry.platforms[0] !== legPlatform)
    ) {
      errors.push(`${where}: entries in ${name} are scoped with "platforms": ["${legPlatform}"]`);
    }
    checkSubset(where, 'databases', entry.databases, DATABASES, errors);
    checkSubset(where, 'services', entry.services, SERVICES, errors);
    if (
      Array.isArray(entry.databases) &&
      entry.databases.some((database) => SERVER_DATABASES.has(database)) &&
      !DATABASE_TEST_FILE.test(entry.file)
    ) {
      errors.push(
        `${where}: only a *.database.test.ts(x) file runs against mariadb or postgres, so this entry could never apply`,
      );
    }
    const key = testKey(entry.file, entry.test);
    if (seen.has(key)) errors.push(`${where}: duplicate entry ${key}`);
    seen.add(key);
  });
  for (const file of wholeFiles) {
    if (testedFiles.has(file)) {
      errors.push(`${name}: ${file} is listed both as a whole file and per test`);
    }
  }
  return errors;
}

/**
 * Every ledger in `dir`, validated, as `[{ name, ...ledger }]` in name order.
 * Throws with every problem listed when any ledger is invalid, and when the
 * same test is listed by two ledgers.
 */
export function readLedgers({ dir = LEDGER_DIR, root = repoRoot } = {}) {
  if (!existsSync(dir)) return [];
  const ledgers = [];
  const errors = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let ledger;
    try {
      ledger = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      errors.push(`${file}: not valid JSON (${error.message})`);
      continue;
    }
    const problems = validateLedger(file, ledger, { root });
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    ledgers.push({ name: basename(file, '.json'), ...ledger });
  }
  // A test (or a whole file) belongs to one ledger, so removing it from one
  // ledger cannot leave it silently expected by another.
  const owners = new Map();
  const fileLedgers = new Map();
  for (const ledger of ledgers) {
    if (ledger.kind !== 'tests') continue;
    for (const entry of ledger.entries) {
      const key = testKey(entry.file, entry.test);
      const owner = owners.get(key);
      if (owner !== undefined) errors.push(`${ledger.name}: ${key} is also listed in ${owner}`);
      owners.set(key, ledger.name);
      if (!fileLedgers.has(entry.file)) fileLedgers.set(entry.file, new Set());
      fileLedgers.get(entry.file).add(ledger.name);
    }
  }
  for (const [key, owner] of owners) {
    if (!key.endsWith(' :: *')) continue;
    const file = key.slice(0, -' :: *'.length);
    for (const other of fileLedgers.get(file)) {
      if (other !== owner) errors.push(`${other}: ${file} is listed as a whole file in ${owner}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid expected-failure ledgers:\n  ${errors.join('\n  ')}`);
  }
  return ledgers;
}

/** One gate ledger by gate name; an absent ledger is an empty one. */
export function readGateLedger(gate, options) {
  const ledger = readLedgers(options).find((entry) => entry.kind === 'gate' && entry.gate === gate);
  return ledger ?? { name: gate, kind: 'gate', gate, description: '', entries: [] };
}

/**
 * Compares a ratcheting gate's current violation ids with its ledger: `unlisted`
 * are new violations (fail), `fixed` are listed ids that no longer occur (fail
 * until removed, so the ledger only shrinks).
 */
export function ratchet(ledger, currentIds) {
  const current = new Set(currentIds);
  const listed = new Set(ledger.entries.map((entry) => entry.id));
  return {
    unlisted: [...current].filter((id) => !listed.has(id)).sort(),
    fixed: [...listed].filter((id) => !current.has(id)).sort(),
  };
}

/**
 * Whether a tests entry applies to a run on `platform` against `database`
 * that declared the live `services`.
 */
export function applies(entry, { platform, database, services = [] }) {
  if (entry.platforms !== undefined && !entry.platforms.includes(platform)) return false;
  if (entry.databases !== undefined && !entry.databases.includes(database)) return false;
  if (entry.services !== undefined && !entry.services.every((name) => services.includes(name))) {
    return false;
  }
  return true;
}

/**
 * The services a run declares in `JSAILS_TEST_SERVICES` (comma-separated),
 * sorted; an unknown name throws, so a misspelt declaration cannot leave
 * every service-scoped entry silently out of scope.
 */
export function declaredServices(raw = '') {
  const names = [
    ...new Set(
      raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ].sort();
  const unknown = names.filter((name) => !SERVICES.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `JSAILS_TEST_SERVICES names unknown service(s) ${unknown.join(', ')}; known: ${SERVICES.join(', ')}`,
    );
  }
  return names;
}

/** Failure types node:test derives from another failure that is reported itself. */
const DERIVED_FAILURES = new Set(['subtestsFailed', 'cancelledByParent']);

/** Whether a failing result fails the way `entry` says it does. */
export function failureMatches(entry, result) {
  const spec = entry.failure ?? {};
  if (spec.type !== undefined) {
    if (result.failureType !== spec.type) return false;
  } else if (entry.test !== undefined) {
    if (result.failureType !== 'testCodeFailure') return false;
  } else if (result.failureType === 'testTimeoutFailure') {
    return false;
  }
  if (spec.name !== undefined && result.errorName !== spec.name) return false;
  if (spec.message !== undefined && !new RegExp(spec.message).test(result.message ?? '')) {
    return false;
  }
  return true;
}

/**
 * Reconciles one run's test results with the applicable ledger entries.
 *
 * `results` are `{ file, path, outcome: 'pass' | 'fail' | 'skip', fileLevel,
 * failureType, errorName, message }`. File-level failures are node's result
 * for a whole file (an import error) and the runner's `processFailure`s; only
 * a whole-file entry matches them. `files` is the set of test files this run
 * executed; entries for other files are out of scope. With `filtered` (a name
 * pattern or `--test-only`), a listed test that did not run is not stale.
 *
 * A listed test that fails, but not the way its entry's `failure` says, is
 * `mismatched`. A `todo` marker does not excuse a failure: the ledger is the
 * one expected-failure mechanism, so a failing todo test is a failure.
 */
export function reconcile({ results, entries, files, context, filtered = false }) {
  const scoped = entries.filter((entry) => files.has(entry.file) && applies(entry, context));
  const byKey = new Map(scoped.map((entry) => [testKey(entry.file, entry.test), entry]));
  const hits = new Set();
  const expected = [];
  const unexpectedFailures = [];
  const mismatched = [];
  for (const result of results) {
    if (result.outcome !== 'fail' || DERIVED_FAILURES.has(result.failureType)) continue;
    const testEntry = result.fileLevel ? undefined : byKey.get(testKey(result.file, result.path));
    const entry = testEntry ?? byKey.get(testKey(result.file, undefined));
    if (entry === undefined) {
      unexpectedFailures.push(result);
    } else if (!failureMatches(entry, result)) {
      mismatched.push({ result, entry });
    } else {
      hits.add(entry);
      expected.push({ result, entry });
    }
  }

  const unexpectedPasses = [];
  const stale = [];
  for (const entry of scoped) {
    if (hits.has(entry) || mismatched.some((item) => item.entry === entry)) continue;
    if (entry.test === undefined) {
      unexpectedPasses.push({ entry, outcome: 'pass' });
      continue;
    }
    const key = testKey(entry.file, entry.test);
    const ran = results.find((result) => testKey(result.file, result.path) === key);
    if (ran === undefined) {
      if (!filtered) stale.push(entry);
    } else if (ran.outcome === 'skip') {
      if (!filtered) unexpectedPasses.push({ entry, outcome: 'skip' });
    } else if (ran.outcome === 'fail') {
      // Failed only as a consequence of something else (a cancelled subtest
      // after its parent's hook failed): it never ran its own body.
      mismatched.push({ result: ran, entry });
    } else {
      unexpectedPasses.push({ entry, outcome: 'pass' });
    }
  }
  return {
    expected,
    unexpectedFailures,
    mismatched,
    unexpectedPasses,
    stale,
    ok:
      unexpectedFailures.length === 0 &&
      mismatched.length === 0 &&
      unexpectedPasses.length === 0 &&
      stale.length === 0,
  };
}
