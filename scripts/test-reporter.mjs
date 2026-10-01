/**
 * The node:test reporter `scripts/run-tests.mjs` attaches beside the human
 * `spec` output. It writes one JSON object per line: every test outcome with
 * its full name path (`result`), the coverage totals when coverage is on
 * (`coverage`), and a closing `end` record, so the runner can reconcile the run
 * with the expected-failure ledgers instead of trusting node's exit code, and
 * can tell a truncated run from a finished one.
 *
 * A result is credited to the test file whose process ran it (node's
 * `entryFile`), not to the module that declared it (`file`): a suite declared
 * in a shared module or in a package's `src/` (a conformance suite a test file
 * calls) is then reported, and listed in a ledger, under the test file that
 * ran it. node's own result for a whole file carries no `entryFile`; its
 * `file` is that test file.
 */
import { resolve } from 'node:path';

/**
 * Whether a result is node's own result for a whole file (an import error, a
 * late rejection in a file whose tests all passed). node names that test after
 * the file path exactly as it was passed on its command line, which is absolute
 * when `run-tests.mjs` starts it and relative to the working directory
 * otherwise.
 */
export function isFileLevel(data) {
  return (
    data.nesting === 0 &&
    typeof data.file === 'string' &&
    typeof data.name === 'string' &&
    resolve(data.name) === resolve(data.file)
  );
}

/** The test file whose process produced an event. */
export function testFileOf(data) {
  return typeof data.entryFile === 'string' ? data.entryFile : data.file;
}

/** The JSON-line records for a stream of node:test events. */
export default async function* jsonResults(source) {
  // Per test file, the names of the tests currently open at each nesting
  // level: node reports a file's events in definition order, `test:start`
  // before the test's own outcome, so the path of an outcome is the open names
  // above it. Keyed by the test file, not the declaring module, because two
  // test files running one shared suite concurrently would share its module.
  const open = new Map();
  for await (const event of source) {
    const { type, data } = event;
    if (type === 'test:start') {
      const file = testFileOf(data);
      const stack = open.get(file) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      open.set(file, stack);
      continue;
    }
    if (type === 'test:pass' || type === 'test:fail') {
      const file = testFileOf(data);
      const stack = open.get(file) ?? [];
      const path = [...stack.slice(0, data.nesting), data.name];
      const error = data.details?.error;
      const failed = type === 'test:fail';
      yield `${JSON.stringify({
        type: 'result',
        file,
        path,
        outcome: data.skip !== undefined ? 'skip' : type === 'test:pass' ? 'pass' : 'fail',
        todo: data.todo !== undefined,
        fileLevel: isFileLevel(data),
        failureType: error?.failureType,
        // The thrown error's class (`AssertionError`, `TypeError`), so a ledger
        // entry can tell a failing assertion from a crash in its fixture.
        errorName: failed && typeof error?.cause?.name === 'string' ? error.cause.name : undefined,
        message: failed ? String(error?.cause?.message ?? error?.message ?? '') : '',
        durationMs: data.details?.duration_ms,
      })}\n`;
      continue;
    }
    if (type === 'test:coverage') {
      const totals = data.summary.totals;
      yield `${JSON.stringify({
        type: 'coverage',
        totals: {
          lines: totals.coveredLinePercent,
          branches: totals.coveredBranchPercent,
          functions: totals.coveredFunctionPercent,
        },
      })}\n`;
    }
  }
  yield `${JSON.stringify({ type: 'end' })}\n`;
}
