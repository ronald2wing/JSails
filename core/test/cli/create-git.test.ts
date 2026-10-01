import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialCommit,
  INITIAL_COMMIT_MESSAGE,
  type GitRunner,
} from '../../src/cli/create-git.js';

/**
 * Tests for the scaffold's initial-commit step.
 *
 * Every case drives the injectable {@link GitRunner}, so no real git process is
 * spawned and no repository is created. The runner records the exact argument
 * arrays so the preconditions and their order are asserted directly.
 */

/** A runner that answers each `git` invocation from a scripted table. */
function scriptedRunner(
  answers: Record<string, { code: number; stdout?: string }>,
): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push([...args]);
      const key = args.join(' ');
      const answer = answers[key];
      if (answer === undefined) {
        return { code: 1, stdout: '' };
      }
      return { code: answer.code, stdout: answer.stdout ?? '' };
    },
  };
}

const HAPPY_PATH = {
  'rev-parse --is-inside-work-tree': { code: 128 },
  '--version': { code: 0, stdout: 'git version 2.43.0\n' },
  'var GIT_AUTHOR_IDENT': { code: 0, stdout: 'A U Thor <a@example.com> 0 +0000' },
  'init --quiet': { code: 0 },
  'add --all': { code: 0 },
  [`commit --quiet -m ${INITIAL_COMMIT_MESSAGE}`]: { code: 0 },
};

describe('createInitialCommit', () => {
  it('initializes, stages, and commits a fresh directory', async () => {
    const runner = scriptedRunner(HAPPY_PATH);

    const result = await createInitialCommit('/tmp/app', runner);

    assert.deepEqual(result, { status: 'committed' });
    assert.deepEqual(runner.calls, [
      ['rev-parse', '--is-inside-work-tree'],
      ['--version'],
      ['var', 'GIT_AUTHOR_IDENT'],
      ['init', '--quiet'],
      ['add', '--all'],
      ['commit', '--quiet', '-m', INITIAL_COMMIT_MESSAGE],
    ]);
  });

  it('skips when the target is already inside a work tree', async () => {
    const runner = scriptedRunner({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    });

    const result = await createInitialCommit('/tmp/monorepo/app', runner);

    assert.deepEqual(result, { status: 'skipped', reason: 'already inside a git work tree' });
    assert.deepEqual(runner.calls, [['rev-parse', '--is-inside-work-tree']]);
  });

  it('skips when git is not installed', async () => {
    const runner = scriptedRunner({
      'rev-parse --is-inside-work-tree': { code: 1 },
      '--version': { code: 1 },
    });

    const result = await createInitialCommit('/tmp/app', runner);

    assert.deepEqual(result, { status: 'skipped', reason: 'git is not installed' });
  });

  it('skips when no commit identity is configured', async () => {
    const runner = scriptedRunner({
      'rev-parse --is-inside-work-tree': { code: 128 },
      '--version': { code: 0, stdout: 'git version 2.43.0\n' },
      'var GIT_AUTHOR_IDENT': { code: 128 },
    });

    const result = await createInitialCommit('/tmp/app', runner);

    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'git user.name and user.email are not configured',
    });
    assert.equal(
      runner.calls.some((args) => args[0] === 'init'),
      false,
      'no repository is created when the identity is missing',
    );
  });

  it('skips without throwing when git init fails', async () => {
    const runner = scriptedRunner({
      ...HAPPY_PATH,
      'init --quiet': { code: 1 },
    });

    const result = await createInitialCommit('/tmp/app', runner);

    assert.deepEqual(result, { status: 'skipped', reason: 'git init failed' });
  });

  it('skips without throwing when the commit fails', async () => {
    const runner = scriptedRunner({
      ...HAPPY_PATH,
      [`commit --quiet -m ${INITIAL_COMMIT_MESSAGE}`]: { code: 1 },
    });

    const result = await createInitialCommit('/tmp/app', runner);

    assert.deepEqual(result, { status: 'skipped', reason: 'git commit failed' });
  });
});
