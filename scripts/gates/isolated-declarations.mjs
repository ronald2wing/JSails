/**
 * Every workspace's shipped source compiles under `isolatedDeclarations`: each
 * exported declaration carries the type its `.d.ts` line needs, so declaration
 * output is stable text that `scripts/api-report.mjs` can read without a type
 * checker, and a change of inferred type cannot silently change the public API.
 *
 * The check compiles `src/` only. The option is not set in `tsconfig.base.json`
 * because that program also holds `test/` and whatever tests import (the
 * `starter-web` templates through `core/test/starter`); neither ships a
 * declaration, and starter code is written for apps, not for this rule. Each
 * workspace is compiled through a temporary tsconfig that extends its own and
 * narrows `include` to `src/`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { exitStatus, run as runProcess } from '../subprocess.mjs';
import { listWorkspaces } from '../api-report.mjs';
import { jobShare } from '../machine-budget.mjs';
import { repoRoot as toolingRoot } from '../workspaces.mjs';

export const name = 'isolated-declarations';
export const description = 'every workspace src/ compiles under isolatedDeclarations';
// Packages resolve `jsails` through core's built declarations.
export const needsBuild = true;
/**
 * CPU slots: two concurrent tsc checks. Each is a full native check of a
 * workspace's `src/` (core's alone holds about 0.7 GiB); four at once peaked
 * at 1.36 GiB for about 5 s less wall time.
 */
export const jobs = Object.freeze({ need: 1, want: 2 });

/** The JavaScript entry of the TypeScript 7 compiler this repository builds with. */
export function tscEntry() {
  const require = createRequire(join(toolingRoot, 'package.json'));
  return join(dirname(require.resolve('@typescript/native/package.json')), 'bin', 'tsc');
}

/**
 * The tsconfig that compiles `workspaceDir/src` alone under
 * `isolatedDeclarations`. `${configDir}` in the base resolves to the temporary
 * file's directory, so every path-valued option the base derives from it is
 * restated against the workspace.
 */
export function isolatedConfig(workspaceDir, repoRoot) {
  const posix = (path) => path.split(sep).join('/');
  return {
    extends: posix(join(workspaceDir, 'tsconfig.json')),
    compilerOptions: {
      isolatedDeclarations: true,
      noEmit: true,
      incremental: false,
      rootDir: posix(workspaceDir),
      typeRoots: [
        ...new Set([
          posix(join(workspaceDir, 'node_modules', '@types')),
          posix(join(repoRoot, 'node_modules', '@types')),
          posix(join(toolingRoot, 'node_modules', '@types')),
        ]),
      ],
    },
    include: [
      posix(join(workspaceDir, 'src', '**', '*.ts')),
      posix(join(workspaceDir, 'src', '**', '*.tsx')),
    ],
  };
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * tsc diagnostics as `{ file, line, column, code, message }`, with `file`
 * relative to `repoRoot`. Lines that are not a located error (summaries,
 * continuation text) are dropped; an error without a location is kept with
 * `file` null so it is never lost.
 */
export function parseDiagnostics(output, cwd, repoRoot) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const located = DIAGNOSTIC.exec(line);
    if (located) {
      const [, file, lineNo, column, code, message] = located;
      diagnostics.push({
        file: relative(repoRoot, join(cwd, file)).split(sep).join('/'),
        line: Number(lineNo),
        column: Number(column),
        code,
        message,
      });
    } else if (/^error TS\d+:/.test(line)) {
      diagnostics.push({
        file: null,
        line: 0,
        column: 0,
        code: line.slice(6, line.indexOf(':')),
        message: line,
      });
    }
  }
  return diagnostics;
}

/** Compiles one workspace's `src/`; resolves with its diagnostics and exit status. */
export async function checkWorkspace(workspaceDir, repoRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-isolated-'));
  try {
    const config = join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify(isolatedConfig(workspaceDir, repoRoot), null, 2));
    const outcome = await runProcess(process.execPath, [tscEntry(), '-p', config], {
      cwd: repoRoot,
      capture: true,
    });
    return {
      status: exitStatus(outcome),
      diagnostics: parseDiagnostics(outcome.stdout, repoRoot, repoRoot),
      output: outcome.output,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function run({ repoRoot }) {
  const queue = listWorkspaces(repoRoot);
  const results = new Map();
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.set(next.name, await checkWorkspace(next.dir, repoRoot));
    }
  };
  await Promise.all(Array.from({ length: jobShare(jobs.want) }, worker));
  const failures = [];
  for (const [packageName, { status, diagnostics, output }] of [...results].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    for (const d of diagnostics) {
      failures.push(
        d.file === null
          ? `${packageName}: ${d.message}`
          : `${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`,
      );
    }
    // A failed compile with no parsed error (a crash, a config error) still fails.
    if (status !== 0 && diagnostics.length === 0) {
      failures.push(`${packageName}: tsc exited with ${status}\n${output.trim()}`);
    }
  }
  return failures;
}
