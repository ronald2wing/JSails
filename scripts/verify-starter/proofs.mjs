/**
 * The negative proofs: a failing test is planted in the admin fixture, run,
 * and shown to fail exactly as expected, with every artifact the fixture's
 * tooling promises on failure. Each proof throws on any deviation from the
 * expected failure, so it can never falsely pass, and leaves the fixture as
 * it found it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { npm } from '../subprocess.mjs';
import { BROWSER_PATH } from './browser.mjs';
import { ADMIN_FIXTURE } from './fixtures.mjs';
import {
  collectTestResults,
  nonAuthSpecs,
  reportPath,
  resolveAttachmentPath,
  resolvePlaywrightCli,
} from './playwright.mjs';
import { NPM_TIMEOUT_MS, findFreePort, runCommandResult, tail } from './processes.mjs';

/** The temporary failing spec, relative to the fixture. */
const NEGATIVE_SPEC_PATH = 'test/browser/verify-failure.spec.ts';
/** Sentinel query token the failing spec sends so sanitization can be proven. */
const NEGATIVE_TOKEN = 'fake-secret';
/** Sentinel console text the failing spec emits so capture can be proven. */
const NEGATIVE_CONSOLE_MARKER = 'benign-proof-console-error';
/** The route path the failing spec aborts, carrying the sentinel token. */
const NEGATIVE_ROUTE = '/proof-ping';

/**
 * The temporary failing spec. It imports the real fixtures (`test`, `expect`,
 * `gotoHydrated`), aborts a controlled request whose query string carries a
 * sentinel token, emits a benign console error, and then fails an assertion
 * against the counter (expected 999, actual 0). The abort is deliberate: it
 * exercises the diagnostics collector's failed-request capture without
 * depending on any network.
 */
const NEGATIVE_SPEC_SOURCE = `/**
 * Intentional-failure proof, written at runtime by the verify-starter harness
 * and removed before the green re-run. Never part of the shipped starter.
 */

import { expect, gotoHydrated, test } from './fixtures.js';

test('intentional failure proof (expected to fail)', async ({ page }) => {
  // A controlled request that is aborted, carrying a sentinel token in its
  // query string so the diagnostics collector can prove query strings are
  // stripped from recorded URLs.
  await page.route(/\\/proof-ping\\?/, (route) => route.abort('failed'));

  await gotoHydrated(page);

  // A benign console error the diagnostics collector must capture.
  await page.evaluate(() => {
    console.error('${NEGATIVE_CONSOLE_MARKER}');
  });

  // Trigger the aborted request; the abort rejects the fetch by design.
  await page.evaluate(async () => {
    try {
      await fetch('${NEGATIVE_ROUTE}?__proof_token=${NEGATIVE_TOKEN}');
    } catch {
      // Expected: the route above aborts this request.
    }
  });

  // The assertion that must fail: the counter starts at 0, not 999.
  await expect(page.locator('[data-counter-value]')).toHaveText('999');
});
`;

/** The starter source file the native proof appends to and restores. */
const NATIVE_APP_TEST_PATH = 'test/app.test.ts';
/** Sentinel message the appended failing `node:test` case asserts with. */
const NATIVE_FAILURE_MARKER = 'JSAILS_INTENTIONAL_NODE_FAILURE';
/** The two values whose recorded presence proves the JUnit diff was captured. */
const NATIVE_FAILURE_ACTUAL = 'ACTUAL_TEST_VALUE';
const NATIVE_FAILURE_EXPECTED = 'EXPECTED_TEST_VALUE';
/**
 * The appended failing case. It compiles into the same `dist/test/app.test.js`
 * as the shipped cases (never a separate file), and uses the `assert`/`test`
 * bindings the starter's `test/app.test.ts` already imports.
 */
const NATIVE_FAILURE_SOURCE = `

test('intentional node failure proof (expected to fail)', () => {
  assert.equal('${NATIVE_FAILURE_ACTUAL}', '${NATIVE_FAILURE_EXPECTED}', '${NATIVE_FAILURE_MARKER}');
});
`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The attachment matching `predicate`, resolved to an existing file. */
function requireAttachment(result, predicate, description) {
  const attachment = result.attachments.find(predicate);
  if (attachment === undefined) {
    throw new Error(`no ${description} attachment recorded for the failing test`);
  }
  const path = resolveAttachmentPath(ADMIN_FIXTURE.dir, attachment.path);
  if (path === null || !existsSync(path)) {
    throw new Error(`${description} attachment file missing (${attachment.path})`);
  }
  return path;
}

/**
 * The browser proof: run only the temporary failing spec with tracing on,
 * assert the exit 1 and every recorded failure artifact (source file and
 * line, expected vs actual, screenshot, sanitized diagnostics, trace), copy
 * that evidence out, then remove the spec and re-run the original non-auth
 * specs green without rebuilding. The auth journey is database-gated and
 * exercised by its own stage, never by this proof.
 */
export async function runBrowserNegativeProof(evidence) {
  const fixtureDir = ADMIN_FIXTURE.dir;
  const cli = resolvePlaywrightCli(fixtureDir);
  const port = await findFreePort();
  const specPath = join(fixtureDir, NEGATIVE_SPEC_PATH);
  const report = reportPath(fixtureDir);
  writeFileSync(specPath, NEGATIVE_SPEC_SOURCE);
  try {
    const failRun = await runCommandResult(process.execPath, [cli, 'test', NEGATIVE_SPEC_PATH], {
      cwd: fixtureDir,
      env: {
        JSAILS_BROWSER_PATH: BROWSER_PATH,
        JSAILS_TEST_PORT: String(port),
        JSAILS_TRACE: '1',
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'playwright test (intentional failure, trace on)',
    });
    if (failRun.code !== 1) {
      throw new Error(
        `expected the failing spec to exit 1, got ${failRun.code}\n` +
          `--- stdout (tail) ---\n${tail(failRun.stdout)}\n--- stderr (tail) ---\n${tail(failRun.stderr)}`,
      );
    }

    const failed = collectTestResults(JSON.parse(readFileSync(report, 'utf8'))).filter(
      (result) => result.status === 'failed',
    );
    if (failed.length !== 1) {
      throw new Error(`expected exactly one failed result, got ${failed.length}`);
    }
    const result = failed[0];

    // The JSON reporter records `spec.file` relative to the testDir, so it is
    // the bare filename here rather than the fixture path.
    if (basename(result.specFile) !== basename(NEGATIVE_SPEC_PATH)) {
      throw new Error(
        `failed spec file ${JSON.stringify(result.specFile)} != ${NEGATIVE_SPEC_PATH}`,
      );
    }
    if (typeof result.specLine !== 'number' || result.specLine <= 0) {
      throw new Error(
        `failed spec has no usable source line (got ${JSON.stringify(result.specLine)})`,
      );
    }

    const errorText = result.errors
      .map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`)
      .join('\n');
    // Quoted so the check cannot be satisfied by incidental digits (such as the
    // 5000ms timeout): Playwright records `Expected: "999"` / `Received: "0"`.
    if (!errorText.includes('"999"')) {
      throw new Error('failure message does not record the expected counter value "999"');
    }
    if (!errorText.includes('"0"')) {
      throw new Error('failure message does not record the actual counter value "0"');
    }

    const screenshotPath = requireAttachment(
      result,
      (attachment) => attachment.contentType === 'image/png' || attachment.name === 'screenshot',
      'screenshot',
    );
    if (!readFileSync(screenshotPath).subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error('screenshot attachment is not a valid PNG');
    }

    const diagnosticsPath = requireAttachment(
      result,
      (attachment) => attachment.name === 'browser-diagnostics',
      'browser-diagnostics',
    );
    const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
    const failedRequest = (diagnostics.failedRequests ?? []).find(
      (request) => typeof request.url === 'string' && request.url.includes(NEGATIVE_ROUTE),
    );
    if (failedRequest === undefined) {
      throw new Error('diagnostics did not record the aborted proof-ping request');
    }
    if (failedRequest.url.includes(NEGATIVE_TOKEN) || failedRequest.url.includes('__proof_token')) {
      throw new Error('diagnostics retained the query token in a recorded URL');
    }
    const capturedConsole = (diagnostics.consoleErrors ?? []).some(
      (text) => typeof text === 'string' && text.includes(NEGATIVE_CONSOLE_MARKER),
    );
    if (!capturedConsole) {
      throw new Error('diagnostics did not capture the benign console error');
    }

    const tracePath = requireAttachment(
      result,
      (attachment) => attachment.name === 'trace' || attachment.contentType === 'application/zip',
      'trace',
    );

    // Copy the failure evidence out before the green re-run overwrites the report.
    evidence.copyArtifact(
      report,
      'negative-results.json',
      'JSON report for the intentional failure',
    );
    evidence.copyArtifact(
      screenshotPath,
      `negative-${basename(screenshotPath)}`,
      'failure screenshot (PNG)',
    );
    evidence.copyArtifact(
      diagnosticsPath,
      'negative-browser-diagnostics.json',
      'sanitized browser diagnostics',
    );
    evidence.copyArtifact(tracePath, 'negative-trace.zip', 'Playwright trace (opt-in)');

    rmSync(specPath, { force: true });
    const greenRun = await runCommandResult(
      process.execPath,
      [cli, 'test', ...nonAuthSpecs(fixtureDir)],
      {
        cwd: fixtureDir,
        env: {
          JSAILS_BROWSER_PATH: BROWSER_PATH,
          JSAILS_TEST_PORT: String(port),
        },
        timeoutMs: NPM_TIMEOUT_MS,
        label: 'playwright test (green after removal)',
      },
    );
    if (greenRun.code !== 0) {
      throw new Error(
        `original tests not green after removing the failing spec: exit ${greenRun.code}\n` +
          `--- stdout (tail) ---\n${tail(greenRun.stdout)}\n--- stderr (tail) ---\n${tail(greenRun.stderr)}`,
      );
    }
    const greenReport = JSON.parse(readFileSync(report, 'utf8'));
    if ((greenReport.stats?.unexpected ?? 0) !== 0) {
      throw new Error(
        `green re-run reported ${greenReport.stats.unexpected} unexpected failure(s)`,
      );
    }
    const greenCount = greenReport.stats?.expected ?? 0;
    evidence.copyArtifact(
      report,
      'green-results.json',
      'JSON report for the green re-run after removal',
    );

    return (
      `expected exit 1 proven (${result.specFile}:${result.specLine}, expected 999 vs actual 0); ` +
      `screenshot + diagnostics + trace captured; original ${greenCount} test(s) green after removal`
    );
  } finally {
    rmSync(specPath, { force: true });
  }
}

/**
 * The native proof: append a failing `node:test` case to the existing
 * `test/app.test.ts`, recompile, and run `npm run test:report`. Assert the
 * exit 1 plus the JUnit failure, the recorded expected vs actual values, and
 * the source-mapped `test/app.test.ts` location (`--enable-source-maps` maps
 * the compiled stack back to the original TS). Then restore the original
 * source and verify the restore byte-for-byte. There is deliberately no green
 * re-run after the restore: `native-test` already proved the suite passes on
 * the untouched source, and a second compile+run would re-prove that at ~6 s
 * for no new evidence; the restore is what needs guaranteeing, and a
 * byte-equality read-back guarantees it at near-zero cost.
 */
export async function runNativeNegativeProof(evidence) {
  const fixtureDir = ADMIN_FIXTURE.dir;
  const appTestPath = join(fixtureDir, NATIVE_APP_TEST_PATH);
  const junitPath = join(fixtureDir, 'test-results', 'junit.xml');
  // Deliberately nonexistent browser binary, so any accidental browser probe
  // in the native path fails loudly instead of silently passing.
  const env = { JSAILS_BROWSER_PATH: join(fixtureDir, 'no-such-browser-binary') };

  const original = readFileSync(appTestPath, 'utf8');
  writeFileSync(appTestPath, original + NATIVE_FAILURE_SOURCE);
  try {
    const failRun = await runCommandResult(npm, ['run', 'test:report'], {
      cwd: fixtureDir,
      env,
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'npm run test:report (intentional node failure)',
    });
    if (failRun.code !== 1) {
      throw new Error(
        `expected the failing native test to exit 1, got ${failRun.code}\n` +
          `--- stdout (tail) ---\n${tail(failRun.stdout)}\n--- stderr (tail) ---\n${tail(failRun.stderr)}`,
      );
    }

    const junit = readFileSync(junitPath, 'utf8');
    if (!junit.includes('<failure')) {
      throw new Error('JUnit report does not record a <failure> for the intentional native test');
    }
    for (const needle of [NATIVE_FAILURE_ACTUAL, NATIVE_FAILURE_EXPECTED, NATIVE_FAILURE_MARKER]) {
      if (!junit.includes(needle)) {
        throw new Error(`JUnit failure does not record ${JSON.stringify(needle)}`);
      }
    }
    // Node's built-in JUnit reporter emits `<testcase classname name time>` and
    // records the stack inside the `<failure>` child; it never writes a `file=`
    // attribute. The proof is therefore the source-mapped stack frame
    // `app.test.ts:<line>:<col>` in the failure body.
    if (!/app\.test\.ts:\d+:\d+/.test(junit)) {
      throw new Error('JUnit failure stack does not record a source-mapped app.test.ts:line:col');
    }

    evidence.copyArtifact(
      junitPath,
      'native-failure.xml',
      'JUnit report for the intentional native node failure',
    );

    writeFileSync(appTestPath, original);
    if (readFileSync(appTestPath, 'utf8') !== original) {
      throw new Error('restore did not reproduce the original native test source byte-for-byte');
    }

    return (
      `expected exit 1 proven (app.test.ts source location, ${NATIVE_FAILURE_ACTUAL} vs ` +
      `${NATIVE_FAILURE_EXPECTED}); original source restored byte-for-byte`
    );
  } finally {
    // Always restore the original source, whatever the proof observed.
    writeFileSync(appTestPath, original);
  }
}
