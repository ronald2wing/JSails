/**
 * The fixture's own Playwright: its CLI entry, the generated spec files, the
 * JSON report it writes, and the case counts derived from spec sources so no
 * expected number is ever hardcoded.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/** The generated auth journey: gated on a live MariaDB, unlike every other generated spec. */
export const BROWSER_AUTH_SPEC = 'test/browser/auth.spec.ts';

/** Where the fixture's Playwright JSON reporter writes. */
export function reportPath(fixtureDir) {
  return join(fixtureDir, 'test-results', 'results.json');
}

/**
 * The fixture's `@playwright/test` CLI entry (never `npx`, never the PATH),
 * so the tests run with the installed devDependency.
 */
export function resolvePlaywrightCli(fixtureDir) {
  const manifestPath = join(fixtureDir, 'node_modules', '@playwright', 'test', 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'the fixture is missing @playwright/test; did create --install skip devDependencies?',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.playwright;
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('the installed @playwright/test declares no "playwright" bin');
  }
  return join(dirname(manifestPath), bin);
}

/** A reporter attachment path (absolute, or relative to the fixture), or `null`. */
export function resolveAttachmentPath(fixtureDir, path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  return isAbsolute(path) ? path : join(fixtureDir, path);
}

/** Every test result in a Playwright JSON report, flattened. */
export function collectTestResults(report) {
  const results = [];
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          results.push({
            specFile: spec.file,
            specLine: spec.line,
            specTitle: spec.title,
            testTitle: test.title,
            status: result.status,
            errors: result.errors ?? [],
            attachments: result.attachments ?? [],
          });
        }
      }
    }
  }
  return results;
}

/** The `*.spec.ts` files under `dir`, as absolute paths, sorted. */
function collectSpecFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSpecFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files.sort();
}

/** The generated specs other than the auth journey, relative to the fixture. */
export function nonAuthSpecs(fixtureDir) {
  return collectSpecFiles(join(fixtureDir, 'test', 'browser'))
    .filter((file) => basename(file) !== basename(BROWSER_AUTH_SPEC))
    .map((file) => relative(fixtureDir, file));
}

/**
 * The number of top-level `test(` declarations across `filePaths`. Both the
 * native `node:test` suite and the Playwright specs indent every
 * `test.step(...)`, so a line-anchored `^test\(` counts only the cases that
 * become real test results, never a step, a string, or a comment.
 */
export function countDeclaredTests(filePaths) {
  let total = 0;
  for (const filePath of filePaths) {
    total += (readFileSync(filePath, 'utf8').match(/^test\(/gm) ?? []).length;
  }
  return total;
}

/**
 * The passing case count a green Playwright JSON report records, checked
 * against the cases its specs declare; throws on any unexpected failure or a
 * mismatch. `label` names the run in the error.
 */
export function assertGreenReport(report, declaredCount, label) {
  if ((report.stats?.unexpected ?? 0) !== 0) {
    throw new Error(`${label} reported ${report.stats.unexpected} unexpected failure(s)`);
  }
  const expected = report.stats?.expected ?? 0;
  if (expected !== declaredCount) {
    throw new Error(`${label} expected ${declaredCount} passing journey(s), reported ${expected}`);
  }
  return expected;
}
