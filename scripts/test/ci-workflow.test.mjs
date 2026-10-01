/**
 * Structural tests for `.github/workflows/ci.yml`: the aggregate `gate` job
 * needs every job but the advisory ones (so a new job is required the moment
 * it is added), the platform legs exist and upload their reconcile verdicts,
 * the database matrix is MariaDB and PostgreSQL with no MySQL leg and lets the
 * MariaDB user create matrix databases, the bench check runs alone, and the
 * jobs that run the bench gate use the Node version its budgets record. The
 * workflow is read as text: the repo has no YAML dependency, and these facts
 * sit at fixed indentation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { repoRoot } from '../workspaces.mjs';

const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));

/** The job ids: two-space-indented keys under `jobs:`. */
function jobIds() {
  return [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);
}

/** The text of one job, up to the next job. */
function jobText(id) {
  const start = jobsSection.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job ${id} exists`);
  const rest = jobsSection.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Whether a job is advisory: `continue-on-error: true` at job level. */
function advisory(id) {
  return /^ {4}continue-on-error: true$/m.test(jobText(id));
}

describe('ci.yml', () => {
  it('the gate job needs every job but the advisory ones and runs even when one failed', () => {
    const gate = jobText('gate');
    const needs = [...gate.matchAll(/^ {6}- ([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1]);
    const required = jobIds().filter((id) => id !== 'gate' && !advisory(id));
    assert.deepEqual([...needs].sort(), [...required].sort());
    assert.match(gate, /^ {4}if: always\(\)$/m);
    assert.match(gate, /all\(\.\[\]; \.result == "success"\)/);
  });

  it('keeps only the timing comparison advisory', () => {
    assert.deepEqual(jobIds().filter(advisory), ['perf-compare']);
    const compare = jobText('perf-compare');
    assert.match(compare, /node scripts\/bench\/index\.mjs --compare/);
    assert.doesNotMatch(compare, /--strict/);
  });

  it('runs the bench check alone on Linux, after a build, and not advisory', () => {
    const bench = jobText('bench');
    assert.match(bench, /runs-on: ubuntu-latest/);
    assert.match(bench, /run: npm run build/);
    assert.match(bench, /run: node scripts\/bench\/index\.mjs --check$/m);
    assert.equal(advisory('bench'), false);
  });

  it('runs the workspace tests on macOS and Windows and uploads their verdicts', () => {
    assert.match(jobText('test-macos'), /runs-on: macos-latest/);
    assert.match(jobText('test-macos'), /npm run test:workspaces/);
    assert.match(jobText('test-windows'), /runs-on: windows-latest/);
    assert.match(jobText('test-windows'), /npm run test:workspaces/);
    for (const [job, name] of [
      ['test-macos', 'reconcile-macos'],
      ['test-windows', 'reconcile-windows'],
    ]) {
      const text = jobText(job);
      assert.match(text, new RegExp(`name: ${name}\\n {10}path: test-results/reconcile/`));
    }
  });

  it('needs no symlink or line-ending git configuration on Windows', () => {
    // The root copies are regular files and .gitattributes gives every checkout LF.
    assert.doesNotMatch(workflow, /core\.(symlinks|autocrlf)/);
  });

  it('has a MariaDB and a PostgreSQL leg and no MySQL leg', () => {
    const database = jobText('database');
    const legs = [...database.matchAll(/^ {10}- database: ([a-z]+)$/gm)].map((match) => match[1]);
    assert.deepEqual(legs, ['mariadb', 'postgres']);
    assert.match(database, /npm run verify:integrations -- --require database/);
    assert.match(database, /npm run test:database/);
    assert.doesNotMatch(workflow, /image: mysql/);
  });

  it('lets the MariaDB leg user create the per-source matrix databases before the tests', () => {
    const database = jobText('database');
    const grant = database.indexOf('GRANT ALL PRIVILEGES ON `jsails\\_m\\_%`.*');
    assert.notEqual(grant, -1);
    assert.match(database, /if: matrix\.database == 'mariadb'/);
    assert.ok(grant < database.indexOf('npm run test:database'));
    assert.match(
      database,
      /^ {6}DATABASE_USER: jsails$/m,
      'the leg connects as the unprivileged user',
    );
  });

  it('runs the full gate in the check job', () => {
    assert.match(jobText('check'), /run: npm run check/);
  });

  it('runs the bench gate on the Node version its budgets record and every other job on .nvmrc', () => {
    const benchJobs = ['check', 'bench'];
    for (const id of benchJobs) {
      const text = jobText(id);
      const read = text.indexOf(
        `id: bench-node\n        run: echo "version=$(jq -er '.node | ltrimstr("v")' perf/budgets.json)" >> "$GITHUB_OUTPUT"`,
      );
      assert.notEqual(read, -1, `${id} reads the version from perf/budgets.json`);
      const setup = text.indexOf('node-version: ${{ steps.bench-node.outputs.version }}');
      assert.ok(read !== -1 && read < setup, `${id} sets up the version it read`);
      assert.doesNotMatch(text, /node-version-file/);
    }
    for (const id of jobIds().filter((job) => !benchJobs.includes(job))) {
      const text = jobText(id);
      if (!text.includes('actions/setup-node@')) continue;
      assert.match(text, /node-version-file: (head\/)?\.nvmrc$/m, `${id} uses .nvmrc`);
    }
    const line = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
    const recorded = JSON.parse(readFileSync(join(repoRoot, 'perf', 'budgets.json'), 'utf8')).node;
    assert.match(recorded, /^v\d+\.\d+\.\d+$/, 'perf/budgets.json records an exact version');
    assert.equal(
      recorded.slice(1).split('.')[0],
      line,
      'the recorded version is on the .nvmrc line',
    );
  });
});
