/**
 * Structural tests for `.github/workflows/` and the local actions in
 * `.github/actions/`. In `ci.yml`, the aggregate `gate` job needs every job
 * but the advisory ones (so a new job is required the moment it is added), the
 * jobs that split `npm run check` run each of its parts once, after a clean
 * build, the jobs that wait wait for `build` only, the platform legs exist and
 * upload their reconcile verdicts, the database matrix is MariaDB and
 * PostgreSQL with no MySQL leg and lets the MariaDB user create matrix
 * databases, the bench check runs alone, the jobs that run the bench gate (and
 * the coverage half of `npm run check`) use the Node version its budgets
 * record, and every install goes through the cached install action, which
 * saves the tree right after `npm ci`. Every workflow and local action pins
 * each action to a commit SHA of a Node 24 release, one release per action,
 * and the publishing job restores no dependency cache. The files are read as
 * text: the repo has no YAML dependency, and these facts sit at fixed
 * indentation.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  it('runs each part of npm run check once across its jobs, each after a clean build', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const [, parts] =
      /^npm run build:clean && node scripts\/run-parallel\.mjs (.+)$/.exec(
        manifest.scripts.check,
      ) ?? [];
    assert.ok(parts, 'the check script is a clean build, then its parts in parallel');
    const ran = [];
    for (const id of ['check', 'coverage']) {
      const text = jobText(id);
      const build = text.indexOf('run: npm run build:clean\n');
      assert.notEqual(build, -1, `${id} builds from clean`);
      for (const match of text.matchAll(
        /^ {8}run: (?:node scripts\/run-parallel\.mjs (.+)|npm run ([\w:-]+))$/gm,
      )) {
        if (match[2] === 'build:clean') continue;
        assert.ok(match.index > build, `${id} runs ${match[0].trim()} after the clean build`);
        ran.push(...(match[1]?.split(' ') ?? [match[2]]));
      }
    }
    assert.deepEqual([...ran].sort(), parts.split(' ').sort());
  });

  it('lets the downstream jobs wait for build only, and starts the rest at once', () => {
    for (const id of jobIds().filter((job) => job !== 'gate')) {
      const needs = /^ {4}needs: (.+)$/m.exec(jobText(id))?.[1];
      if (needs !== undefined) assert.equal(needs, 'build', `${id} waits for build only`);
    }
    for (const id of ['build', 'check', 'coverage', 'audit', 'test-macos', 'test-windows']) {
      assert.doesNotMatch(jobText(id), /^ {4}needs:/m, `${id} starts at once`);
    }
  });

  it('installs through the cached install action, with setup-node caching nothing', () => {
    for (const id of jobIds()) {
      const text = jobText(id);
      assert.doesNotMatch(
        text,
        /^(?! *#).*\bnpm (?:--prefix \S+ )?ci\b/m,
        `${id} installs through the action`,
      );
      if (!text.includes('actions/setup-node@')) continue;
      assert.match(text, /uses: \.\/(?:head\/)?\.github\/actions\/install-dependencies$/m, id);
      assert.doesNotMatch(text, /^ {10}cache:/m, `${id} sets up no npm cache`);
      assert.match(
        text,
        /^ {10}package-manager-cache: false$/m,
        `${id} opts out of the automatic one`,
      );
    }
  });

  it('runs the bench gate on the Node version its budgets record and every other job on .nvmrc', () => {
    const benchJobs = ['check', 'coverage', 'bench'];
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

describe('the install action', () => {
  const action = readFileSync(
    join(repoRoot, '.github', 'actions', 'install-dependencies', 'action.yml'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('restores an exact key only, and saves right after npm ci rather than in a post step', () => {
    assert.doesNotMatch(action, /uses: actions\/cache@/, 'no post-step save');
    assert.doesNotMatch(action, /^ +restore-keys:/m);
    const restore = action.indexOf('uses: actions/cache/restore@');
    const check = action.indexOf('ci-dependencies.mjs" verify');
    const install = action.indexOf('npm ci --ignore-scripts');
    const save = action.indexOf('uses: actions/cache/save@');
    assert.ok(restore !== -1 && restore < check && check < install && install < save);
    assert.match(action, /^ {8}key: npm-ci-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-/m);
    assert.match(
      action,
      /^ {6}if: steps\.restore\.outputs\.cache-hit != 'true'\n {6}uses: actions\/cache\/save@/m,
    );
  });
});

describe('action pins', () => {
  const workflows = [
    ...['ci.yml', 'release.yml'].map((file) => join('workflows', file)),
    ...readdirSync(join(repoRoot, '.github', 'actions')).map((name) =>
      join('actions', name, 'action.yml'),
    ),
  ].map((file) => ({
    file,
    text: readFileSync(join(repoRoot, '.github', file), 'utf8').replace(/\r\n/g, '\n'),
  }));
  const allUses = workflows.flatMap(({ file, text }) =>
    [...text.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((match) => ({ file, line: match[1] })),
  );
  const local = allUses.filter(({ line }) => line.startsWith('./'));
  const uses = allUses.filter(({ line }) => !line.startsWith('./'));

  it('pins every action to a full commit SHA with its release tag in a trailing comment', () => {
    assert.ok(uses.length > 0);
    for (const { file, line } of uses) {
      assert.match(
        line,
        /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${file}: ${line}`,
      );
    }
  });

  it('uses only local actions that exist in this repository', () => {
    assert.ok(local.length > 0);
    for (const { file, line } of local) {
      const path = line.replace(/^\.\/(?:head\/)?/, '');
      assert.ok(existsSync(join(repoRoot, path, 'action.yml')), `${file}: ${line}`);
    }
  });

  it('runs one release of each action everywhere, on a Node 24 major', () => {
    // The Node 20 majors (checkout, setup-node and upload-artifact v4) are
    // forced onto Node 24 by the runner with a deprecation warning; the first
    // major of each that declares node24 is the floor.
    const node24Major = {
      'actions/cache': 5,
      'actions/checkout': 5,
      'actions/setup-node': 5,
      'actions/upload-artifact': 6,
    };
    const pins = new Map();
    for (const { file, line } of uses) {
      // `actions/cache/restore` and `actions/cache/save` are one action's release.
      const [, action, pin, major] =
        /^([\w.-]+\/[\w.-]+)(?:\/[\w.-]+)*@(\S+ # v(\d+)\.\S+)$/.exec(line) ?? [];
      assert.ok(action && pin && major, `${file}: ${line}`);
      pins.set(action, [...(pins.get(action) ?? []), pin]);
      const floor = node24Major[action];
      assert.ok(floor !== undefined, `${file}: ${action} has a recorded Node 24 major`);
      assert.ok(Number(major) >= floor, `${file}: ${action} is on a Node 24 major`);
    }
    for (const [action, list] of pins) {
      assert.equal(new Set(list).size, 1, `${action} is pinned to one release`);
    }
  });

  it('restores no dependency cache in the publishing job', () => {
    const release = workflows.find(({ file }) => file === join('workflows', 'release.yml')).text;
    assert.match(release, /^ {10}package-manager-cache: false$/m);
    assert.doesNotMatch(release, /^ {10}cache:/m);
  });
});
