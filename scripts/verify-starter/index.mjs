/**
 * Opt-in end-to-end starter verification: `npm run verify:starter`.
 *
 * Builds every workspace, packs the framework and the plugins the presets
 * install, generates one fixture per server-rendered preset with the real
 * `jsails create --install`, and proves each generated app end to end. The
 * stages, in pipeline order:
 *
 *  - `build-root`, `pack`: the framework builds and `npm pack` produces a
 *    tarball per workspace the fixtures install.
 *  - `generate-fixture`, `generate-blog-fixture`, `generate-saas-fixture`:
 *    `jsails create <dir> --name … --jsails-dependency file:<tarball>
 *    --package-dependency @jsails/<plugin>=file:<tarball> … <preset> --install`
 *    scaffolds each fixture and runs a real, hook-free `npm install`. The
 *    chains run concurrently; each checks its fixture (`npm run check`:
 *    typecheck and build, static export included) as soon as it is installed.
 *  - `write-editor-fixture`: a test-only page and spec join the admin fixture.
 *  - `packaged-import`: the installed `jsails` module's `createStarterFiles`
 *    reads its own bundled templates and `AGENTS.md` and produces the expected
 *    admin, static, and blog file sets (`starter-files.mjs`).
 *  - `static-export`: the `out/` the fixture check produced is validated in
 *    place rather than rebuilt.
 *  - `native-test`: `npm run test:report` runs the generated server-only
 *    `node:test` suite with `JSAILS_BROWSER_PATH` pointing at a nonexistent
 *    binary, proving the default test path never probes a browser; the case
 *    count is derived from the shipped sources, and the JUnit report is kept.
 *  - `native-test-fail-proof`: a failing case is appended to `test/app.test.ts`,
 *    shown to fail with a source-mapped JUnit failure, and the source restored
 *    byte-for-byte (`proofs.mjs`).
 *  - `auth-migrate`, `user-create`, `browser-auth`: run only with a live
 *    MariaDB (`database.mjs`); otherwise each is an explicit skip.
 *  - `browser-test-pass`, `browser-test-fail-proof`, `browser-serve`,
 *    `browser-static`, `dev-server`: the generated Playwright journeys, the
 *    browser negative proof with its failure artifacts, browser QA against
 *    `jsails serve` and a pure static serve of `out/`, and a real `jsails dev`
 *    run (`browser.mjs`, `dev-server.mjs`). All need Chromium.
 *
 * `--skip-browser` records every browser stage as a skip without launching or
 * probing a browser; the pack/install/check/native-test pipeline still runs in
 * full, and the database gate is still evaluated. Unknown flags are rejected.
 *
 * Temporary work lives under the OS temp directory and is removed on exit;
 * nothing is installed into the framework workspace. The run's structured
 * summary and copied artifacts persist under `test-results/verify-starter/`
 * (`evidence.mjs`). No browser is ever downloaded and no external page is read.
 *
 * Environment:
 *   JSAILS_BROWSER_PATH — the Chromium/Chrome binary (default /usr/bin/chromium).
 *                         The browser stages fail explicitly when it is absent
 *                         rather than claiming a pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { npm } from '../subprocess.mjs';
import { repoRoot } from '../workspaces.mjs';
import {
  BROWSER_PATH,
  browserLaunches,
  closeBrowser,
  runBrowserQa,
  runNavigationQa,
  runServerComponentQa,
  runStaticTasksQa,
} from './browser.mjs';
import {
  AUTH_TEST_EMAIL,
  AUTH_TEST_PASSWORD,
  BETTER_AUTH_SECRET,
  hasDatabase,
  missingDatabaseVariables,
} from './database.mjs';
import { runDevServerStage } from './dev-server.mjs';
import { writeEditorSmoke } from './editor-smoke.mjs';
import { createEvidence } from './evidence.mjs';
import {
  ADMIN_FIXTURE,
  BLOG_FIXTURE,
  SAAS_FIXTURE,
  checkFixture,
  createFixture,
  installedCli,
  packWorkspaces,
  removeTempRoot,
} from './fixtures.mjs';
import {
  BROWSER_AUTH_SPEC,
  assertGreenReport,
  countDeclaredTests,
  nonAuthSpecs,
  reportPath,
  resolvePlaywrightCli,
} from './playwright.mjs';
import {
  NPM_TIMEOUT_MS,
  findFreePort,
  runCommand,
  spawnServer,
  stopOwnedChildren,
} from './processes.mjs';
import { runBrowserNegativeProof, runNativeNegativeProof } from './proofs.mjs';
import { createStageLedger, log } from './stages.mjs';
import { packagedStarterScript } from './starter-files.mjs';
import { collectVersions } from './versions.mjs';

/**
 * Only `--skip-browser` is recognized; any other flag or positional argument
 * is rejected so a typo cannot silently change the verification scope.
 */
function parseFlags(argv) {
  let skipBrowser = false;
  for (const arg of argv) {
    if (arg === '--skip-browser') {
      skipBrowser = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg} (only --skip-browser is accepted)`);
    } else {
      throw new Error(`unexpected argument: ${arg} (only --skip-browser is accepted)`);
    }
  }
  return skipBrowser;
}

/** Runs the fixture's Playwright CLI directly on `specs` and returns its green report. */
async function runPlaywright(specs, env, label) {
  const fixtureDir = ADMIN_FIXTURE.dir;
  // The CLI is invoked directly, never `npm run test:browser`: that script
  // re-runs the full `tsc` + `vite` build that `check-fixture` already
  // produced, while the Playwright `webServer` block serves the built output.
  const port = await findFreePort();
  await runCommand(process.execPath, [resolvePlaywrightCli(fixtureDir), 'test', ...specs], {
    cwd: fixtureDir,
    env: { JSAILS_BROWSER_PATH: BROWSER_PATH, JSAILS_TEST_PORT: String(port), ...env },
    timeoutMs: NPM_TIMEOUT_MS,
    label,
  });
  const report = JSON.parse(readFileSync(reportPath(fixtureDir), 'utf8'));
  const declared = countDeclaredTests(specs.map((file) => join(fixtureDir, file)));
  return { port, passed: assertGreenReport(report, declared, label) };
}

async function runPipeline({ skipBrowser, evidence }) {
  const ledger = createStageLedger({ skipBrowser });
  const { run } = ledger;
  const fixtureDir = ADMIN_FIXTURE.dir;
  let tarballs = null;

  await run('build-root', {}, async () => {
    await runCommand(npm, ['run', 'build'], { cwd: repoRoot, label: 'build root' });
  });

  await run('pack', { after: ['build-root'] }, async () => {
    tarballs = await packWorkspaces();
    return tarballs.files.join(', ');
  });

  // Three independent fixture chains. Each owns its own directory and
  // allocates its own ports, so they are dispatched concurrently. Native and
  // browser stages stay behind the join so they do not compete with these
  // builds. The chain wrappers are plain functions, not stages: each inner
  // `run` records its own result.
  const chainAdmin = async () => {
    await run(ADMIN_FIXTURE.stage, { after: ['pack'] }, () =>
      createFixture(ADMIN_FIXTURE, tarballs),
    );
    await run('write-editor-fixture', { after: [ADMIN_FIXTURE.stage] }, () =>
      writeEditorSmoke(fixtureDir),
    );
    await run('packaged-import', { after: [ADMIN_FIXTURE.stage] }, async () => {
      await runCommand(process.execPath, ['--input-type=module', '-e', packagedStarterScript()], {
        cwd: fixtureDir,
        label: 'packaged createStarterFiles',
      });
      return 'packaged module reads its bundled templates + AGENTS.md';
    });
    await run('check-fixture', { after: ['write-editor-fixture'] }, () =>
      checkFixture(ADMIN_FIXTURE),
    );
  };
  const chainPreset = (fixture, checkStage) => async () => {
    await run(fixture.stage, { after: ['pack'] }, () => createFixture(fixture, tarballs));
    await run(checkStage, { after: [fixture.stage] }, () => checkFixture(fixture));
  };
  await ledger.parallel([
    chainAdmin,
    chainPreset(BLOG_FIXTURE, 'check-blog-fixture'),
    chainPreset(SAAS_FIXTURE, 'check-saas-fixture'),
  ]);

  await run('static-export', { after: ['check-fixture'] }, async () => {
    // `/` -> index.html, `/about` -> about/index.html, `/tasks` ->
    // tasks/index.html, and the two fixed assets land under assets/.
    for (const rel of [
      'index.html',
      'about/index.html',
      'tasks/index.html',
      'assets/app.js',
      'assets/app.css',
    ]) {
      if (!existsSync(join(fixtureDir, 'out', rel))) {
        throw new Error(`static export is missing out/${rel}`);
      }
    }
    return 'out/ index + about/tasks pages + assets/app.js + assets/app.css validated in place';
  });

  await run('native-test', { after: ['check-fixture'] }, async () => {
    // `npm run test:report` compiles the backend and runs the compiled
    // `node:test` suite in-process with a spec reporter on stdout plus a JUnit
    // report at `test-results/junit.xml`.
    const junitPath = join(fixtureDir, 'test-results', 'junit.xml');
    await runCommand(npm, ['run', 'test:report'], {
      cwd: fixtureDir,
      env: { JSAILS_BROWSER_PATH: join(fixtureDir, 'no-such-browser-binary') },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run test:report',
    });
    if (!existsSync(junitPath)) {
      throw new Error('test:report did not produce test-results/junit.xml');
    }
    const junit = readFileSync(junitPath, 'utf8');
    const testCount = (junit.match(/<testcase\b/g) ?? []).length;
    const failCount = (junit.match(/<failure\b/g) ?? []).length;
    const skippedCount = (junit.match(/<skipped\b/g) ?? []).length;
    // The native suite is two files: `app.test.ts` (server behavior, always
    // runs) and `auth.test.ts` (database-backed, which skips itself when no
    // MariaDB is configured).
    const appTestPath = join(fixtureDir, 'test', 'app.test.ts');
    const authTestPath = join(fixtureDir, 'test', 'auth.test.ts');
    const expectedCount = countDeclaredTests([appTestPath, authTestPath]);
    if (testCount !== expectedCount) {
      throw new Error(
        `expected ${expectedCount} native node:test cases, JUnit recorded ${testCount}`,
      );
    }
    if (failCount !== 0) {
      throw new Error(`native node:test suite recorded ${failCount} failure(s)`);
    }
    // Without a database every auth case must be an explicit skip; with one
    // none may be skipped. This proves the auth suite never silently passes.
    const expectedAuthSkips = hasDatabase ? 0 : countDeclaredTests([authTestPath]);
    if (skippedCount !== expectedAuthSkips) {
      throw new Error(
        `expected ${expectedAuthSkips} skipped node:test case(s), JUnit recorded ${skippedCount}`,
      );
    }
    evidence.copyArtifact(
      junitPath,
      'native-pass.xml',
      'JUnit report for the passing native node:test suite',
    );
    return (
      `${expectedCount} native node:test cases via npm run test:report ` +
      `(${expectedCount - skippedCount} ran, ${skippedCount} skipped${
        hasDatabase ? '' : ' — auth suite skipped, no database'
      }; browser-independent, JSAILS_BROWSER_PATH nonexistent)`
    );
  });

  await run('native-test-fail-proof', { after: ['native-test'], proof: true }, () =>
    runNativeNegativeProof(evidence),
  );

  await run('auth-migrate', { after: ['check-fixture'], needs: ['database'] }, async () => {
    // The script imports `createAuth` from the `jsails/auth` plugin directly
    // (no compiled app module is required), so it is gated only on
    // `check-fixture`. The secret is passed explicitly so the
    // migrate/create/serve/browser chain shares one value.
    await runCommand(npm, ['run', 'auth:migrate'], {
      cwd: fixtureDir,
      env: { BETTER_AUTH_SECRET },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run auth:migrate',
    });
    return 'Better Auth tables migrated in the configured MariaDB';
  });

  await run('user-create', { after: ['auth-migrate'], needs: ['database'] }, async () => {
    // The password is passed to the script but never echoed.
    await runCommand(
      npm,
      ['run', 'user:create', '--', AUTH_TEST_EMAIL, AUTH_TEST_PASSWORD, 'Verify User'],
      {
        cwd: fixtureDir,
        env: { BETTER_AUTH_SECRET },
        timeoutMs: NPM_TIMEOUT_MS,
        label: 'fixture npm run user:create',
      },
    );
    return `seeded auth account ${AUTH_TEST_EMAIL}`;
  });

  await run(
    'browser-test-pass',
    { after: ['static-export', 'check-fixture'], needs: ['browser'] },
    async () => {
      // The generated non-auth journeys: soft navigation, the signed
      // server-component actions, and the in-flight morph. The auth journey is
      // database-gated and runs in its own stage.
      const { port, passed } = await runPlaywright(
        nonAuthSpecs(fixtureDir),
        {},
        'playwright test (non-auth journeys)',
      );
      evidence.copyArtifact(
        reportPath(fixtureDir),
        'pass-results.json',
        'JSON report for the passing generated journeys',
      );
      return `${passed} non-auth generated journey(s) passed via Playwright (system Chromium, isolated port ${port})`;
    },
  );

  await run(
    'browser-auth',
    { after: ['user-create', 'static-export', 'check-fixture'], needs: ['database', 'browser'] },
    async () => {
      // Signs the seeded account in and out in a real browser.
      const { port, passed } = await runPlaywright(
        [BROWSER_AUTH_SPEC],
        { BETTER_AUTH_SECRET, AUTH_TEST_EMAIL, AUTH_TEST_PASSWORD },
        'playwright test (auth journey)',
      );
      evidence.copyArtifact(
        reportPath(fixtureDir),
        'auth-pass-results.json',
        'JSON report for the passing auth browser journey',
      );
      return `${passed} auth browser journey(s) passed for ${AUTH_TEST_EMAIL} (system Chromium, isolated port ${port})`;
    },
  );

  await run(
    'browser-test-fail-proof',
    { after: ['browser-test-pass'], needs: ['browser'], proof: true },
    () => runBrowserNegativeProof(evidence),
  );

  // The two read-only QA stages share the admin fixture but own distinct
  // PORT=0 servers and isolated browser contexts. dev-server mutates the
  // fixture, so it stays serialized after both.
  await ledger.parallel([
    () =>
      run('browser-serve', { after: ['static-export'], needs: ['browser'] }, async () => {
        // `NODE_ENV=test` lets the server-components extension mint its
        // ephemeral signing key (a plain `jsails serve` outside
        // development/test fails a live render closed), so `/tasks` renders.
        const served = await spawnServer({
          cmd: process.execPath,
          args: [installedCli(fixtureDir), 'serve', '--config', 'jsails.app.js'],
          cwd: fixtureDir,
          env: { PORT: '0', NODE_ENV: 'test' },
          match: /Serving at (https?:\/\/\S+)/,
          label: 'jsails serve',
        });
        try {
          const observed = await runBrowserQa(served.url);
          const nav = await runNavigationQa(served.url);
          const tasks = await runServerComponentQa(served.url);
          return (
            `hydration/counter/dialog OK at ${served.url} (bg ${observed.styles.backgroundColor}); ` +
            `soft navigation preserved the window (${nav.heading}); ` +
            `server component add/clear/422 OK (${tasks.items} task)`
          );
        } finally {
          await served.stop();
        }
      }),
    () =>
      run('browser-static', { after: ['static-export'], needs: ['browser'] }, async () => {
        // Pure static proof: serve the exported out/ with Hono + serve-static,
        // no jsails backend, and confirm hydration and the counter still work.
        const staticScript = `
      import { serve } from '@hono/node-server';
      import { serveStatic } from '@hono/node-server/serve-static';
      import { Hono } from 'hono';
      const app = new Hono();
      app.use('*', serveStatic({ root: './out' }));
      serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        console.log('STATIC_AT http://127.0.0.1:' + info.port + '/');
      });
    `;
        const served = await spawnServer({
          cmd: process.execPath,
          args: ['--input-type=module', '-e', staticScript],
          cwd: fixtureDir,
          match: /STATIC_AT (https?:\/\/\S+)/,
          label: 'static serve of out/',
        });
        try {
          const observed = await runBrowserQa(served.url);
          await runNavigationQa(served.url);
          const tasks = await runStaticTasksQa(served.url);
          return (
            `pure static out/ OK at ${served.url} (bg ${observed.styles.backgroundColor}); ` +
            `soft navigation preserved the window; ` +
            `static tasks read-only fallback OK (counter ${tasks.counter})`
          );
        } finally {
          await served.stop();
        }
      }),
  ]);

  await run('dev-server', { after: ['static-export'], needs: ['browser'] }, runDevServerStage);

  return ledger.outcomes();
}

let outcomes;
let versions;
let skipBrowser = false;
let evidence = null;
try {
  skipBrowser = parseFlags(process.argv.slice(2));
  evidence = createEvidence();
  outcomes = await runPipeline({ skipBrowser, evidence });
} catch (error) {
  outcomes = [
    {
      name: 'verify-starter',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    },
  ];
} finally {
  // Capture versions before teardown removes the fixture's node_modules.
  try {
    versions = collectVersions(ADMIN_FIXTURE.dir, { skipBrowser });
  } catch {
    versions = {};
  }
  await stopOwnedChildren();
  await closeBrowser();
  removeTempRoot();
}

const byStatus = (status) => outcomes.filter((entry) => entry.status === status);
const succeeded = byStatus('ok');
const failed = byStatus('failed');
const skipped = byStatus('skipped');
const expectedFailures = byStatus('expected-failure');
const describe = (entry) => `  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`;

log('');
log('=== verify:starter summary ===');
log(`succeeded: ${succeeded.length}`);
for (const entry of succeeded) log(describe(entry));
log(`expected failures (negative proof, not counted as passes): ${expectedFailures.length}`);
for (const entry of expectedFailures) log(describe(entry));
log(`failed: ${failed.length}`);
for (const entry of failed) log(describe(entry));
log(`skipped: ${skipped.length}`);
for (const entry of skipped) log(describe(entry));
log(
  `database: ${
    hasDatabase
      ? 'configured — auth stages enabled'
      : `absent — auth stages skipped (missing ${missingDatabaseVariables.join(', ')})`
  }`,
);
log(`browser launched: ${browserLaunches()}`);
log('dependency versions:');
for (const [name, version] of Object.entries(versions)) {
  log(`  - ${name}: ${version ?? 'unknown'}`);
}

if (evidence !== null) {
  try {
    evidence.writeSummary({
      schemaVersion: 1,
      runId: evidence.runId,
      status: failed.length === 0 ? 'passed' : 'failed',
      startedAt: evidence.startedAt,
      durationMs: Date.now() - evidence.startedAtMs,
      stages: outcomes,
      errors: failed.map((entry) => entry.detail),
      artifacts: evidence.artifacts,
      skipBrowser,
      database: { detected: hasDatabase, missing: [...missingDatabaseVariables] },
      browserLaunches: browserLaunches(),
    });
    log(`structured summary + evidence: ${evidence.location}`);
    log(
      'note: dev-process leak detection is limited to /proc process metadata on Linux — no global leak proof is claimed on platforms without it',
    );
  } catch (writeError) {
    log(`warning: could not persist the structured summary — ${writeError.message}`);
  }
}

process.exitCode = failed.length === 0 ? 0 : 1;
