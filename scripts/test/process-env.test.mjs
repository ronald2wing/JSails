/**
 * Tests for the `process-env` gate (`scripts/gates/process-env.mjs`): which
 * source text reads the process environment (through `process` or the
 * `process` module), and how the allow-list matches paths (one file per
 * entry, never a directory). The gate run against the real repository is
 * `npm run gates -- process-env`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALLOWED, allowedEntry, readsProcessEnv } from '../gates/process-env.mjs';

describe('readsProcessEnv', () => {
  it('finds property access, bracket access and destructuring', () => {
    for (const source of [
      'const a = process.env.A;',
      'const a = process\n  .env[NAME];',
      'const a = process?.env;',
      "const a = process['env'];",
      'const { env } = process;',
      'const { argv, env: vars } = globalThis.process;',
      'const child = { ...process.env, PWD: dir };',
    ]) {
      assert.equal(readsProcessEnv(source), true, source);
    }
  });

  it('finds reads through the process module', () => {
    for (const source of [
      "import { env } from 'node:process';\nconst key = env.STRIPE_KEY;",
      "import { argv, env as vars } from 'process';",
      "import * as proc from 'node:process';\nproc.env.X;",
      "import proc from 'process';\nconst a = proc['env'];",
      "import proc, * as ns from 'node:process';\nconst { env } = ns;",
      "import $p from 'node:process';\n$p.env.X;",
      "const { env } = require('node:process');",
      "const vars = require('process').env;",
      "const vars = (await import('node:process')).env;",
      "const { env } = await import('node:process');",
    ]) {
      assert.equal(readsProcessEnv(source), true, source);
    }
  });

  it('ignores the process module when nothing reads env from it', () => {
    for (const source of [
      "import { cwd } from 'node:process';\ncwd();",
      "import { environment } from 'node:process';",
      "import * as proc from 'node:process';\nproc.cwd();\nconst e = other.env;",
      "const { argv } = require('node:process');",
    ]) {
      assert.equal(readsProcessEnv(source), false, source);
    }
  });

  it('ignores comments and other names', () => {
    for (const source of [
      '// process.env.A\nconst a = 1;',
      '/** Defaults to `process.env`. */\nexport const x = 1;',
      'const environment = options.env;',
      'const { env } = options;',
      'subprocess.envelope();',
    ]) {
      assert.equal(readsProcessEnv(source), false, source);
    }
  });
});

describe('allowedEntry', () => {
  it('matches a file entry exactly, and nothing else under its directory', () => {
    assert.equal(
      allowedEntry('core/src/plugins/contract/env-variables.ts')?.path,
      'core/src/plugins/contract/env-variables.ts',
    );
    assert.equal(allowedEntry('core/src/cli/dispatch.ts')?.path, 'core/src/cli/dispatch.ts');
    for (const file of [
      'core/src/plugins/contract/env-variables.test.ts',
      'core/src/cli/commands/build.ts',
      'core/src/testing/anything-new.ts',
      'packages/jamal/src/new-verb.ts',
      'core/src/environment/new-reader.ts',
    ]) {
      assert.equal(allowedEntry(file), undefined, file);
    }
  });

  it('lists files only, each with a reason', () => {
    for (const entry of ALLOWED) {
      assert.ok(!entry.path.endsWith('/'), entry.path);
      assert.match(entry.path, /\.(?:ts|tsx|mts|js|mjs)$/, entry.path);
      assert.ok(entry.reason.length > 0, entry.path);
    }
  });
});
