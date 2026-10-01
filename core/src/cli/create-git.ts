/**
 * Initial git commit for a freshly scaffolded project.
 *
 * `jsails create` writes a complete, runnable project; leaving it uncommitted
 * means the user's first edit has no baseline to diff against. This module
 * makes the initial commit, but only when doing so is unambiguously safe:
 *
 * - The target must not already be inside a git work tree. Scaffolding into a
 *   monorepo or an existing repository must never create a nested repo or
 *   commit into the parent's history.
 * - `git` must be on `PATH`.
 * - A commit identity must be resolvable. On a fresh machine `user.name` and
 *   `user.email` are unset and `git commit` fails; that is not a scaffolding
 *   failure, so it is reported as a skip.
 *
 * Every skip is silent from the caller's perspective except for a one-line
 * note, and no skip ever fails the command: the project is already on disk and
 * correct. Only a genuine `git` failure after the preconditions pass is
 * surfaced, and even then the exit code stays 0 — the scaffold succeeded.
 */

import { spawn } from 'node:child_process';

/** The commit message for a scaffolded project. */
export const INITIAL_COMMIT_MESSAGE = 'chore: scaffold with jsails';

/** Outcome of the initial-commit attempt. */
export type InitialCommitResult =
  { readonly status: 'committed' } | { readonly status: 'skipped'; readonly reason: string };

/** The narrow process surface the commit uses, injectable for tests. */
export interface GitRunner {
  /** Run `git <args>` in `cwd`; resolves to the exit code and captured stdout. */
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

/** Spawn `git` with a static argument array and no shell. */
function defaultGitRunner(): GitRunner {
  return {
    run(args, cwd) {
      return new Promise((resolve) => {
        const child = spawn('git', [...args], { cwd, shell: false, stdio: 'pipe' });
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        // stderr is drained but never surfaced: git echoes paths and remote
        // URLs there, and this module's messages stay value-free.
        child.stderr?.resume();
        child.once('error', () => resolve({ code: 1, stdout: '' }));
        child.once('exit', (code) => resolve({ code: code ?? 1, stdout }));
      });
    },
  };
}

/**
 * Create the initial commit for a scaffolded project.
 *
 * Returns `committed` on success and `skipped` with a short, value-free reason
 * otherwise. Never throws: a git failure is a skip, because the scaffold itself
 * already succeeded.
 */
export async function createInitialCommit(
  targetDir: string,
  runner: GitRunner = defaultGitRunner(),
): Promise<InitialCommitResult> {
  const inside = await runner.run(['rev-parse', '--is-inside-work-tree'], targetDir);
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    return { status: 'skipped', reason: 'already inside a git work tree' };
  }
  if (inside.code !== 0) {
    // `rev-parse` also fails when git is absent; distinguish the two so the
    // note tells the user which precondition failed.
    const version = await runner.run(['--version'], targetDir);
    if (version.code !== 0) {
      return { status: 'skipped', reason: 'git is not installed' };
    }
  }

  const identity = await runner.run(['var', 'GIT_AUTHOR_IDENT'], targetDir);
  if (identity.code !== 0) {
    return { status: 'skipped', reason: 'git user.name and user.email are not configured' };
  }

  const init = await runner.run(['init', '--quiet'], targetDir);
  if (init.code !== 0) {
    return { status: 'skipped', reason: 'git init failed' };
  }
  const add = await runner.run(['add', '--all'], targetDir);
  if (add.code !== 0) {
    return { status: 'skipped', reason: 'git add failed' };
  }
  const commit = await runner.run(['commit', '--quiet', '-m', INITIAL_COMMIT_MESSAGE], targetDir);
  if (commit.code !== 0) {
    return { status: 'skipped', reason: 'git commit failed' };
  }
  return { status: 'committed' };
}
