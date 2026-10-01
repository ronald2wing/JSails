import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { DotenvError, assembleEnvironment, readDotenvFiles } from '../src/dotenv.js';

/**
 * The environment assembly: developer-owned `.env` files become `process.env`
 * at bootstrap, without ever overwriting a real environment variable.
 *
 * Semantics follow the Node consensus (dotenv-flow / Vite / Next / Symfony):
 * a cumulative merge where `.env` is base and `.env.testing` / `.env.local` /
 * `.env.${NODE_ENV}` layer on top, with `.env.local` skipped under test.
 */
describe('assembleEnvironment', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotenv-'));
  let seq = 0;

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh, empty per-test directory so files never leak between cases. */
  function fixture(): string {
    const dir = join(root, `case-${seq++}`);
    mkdirSync(dir);
    return dir;
  }

  function freshEnv(): NodeJS.ProcessEnv {
    return {};
  }

  it('loads .env into an empty env map (non-test)', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_HOST=127.0.0.1\nDATABASE_NAME=app\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env });
    assert.equal(env['DATABASE_HOST'], '127.0.0.1');
    assert.equal(env['DATABASE_NAME'], 'app');
  });

  it('never overwrites an already-set real variable (real env wins)', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=from-file\n');
    const env: NodeJS.ProcessEnv = { DATABASE_NAME: 'from-env' };
    assembleEnvironment({ rootDir: dir, env });
    assert.equal(env['DATABASE_NAME'], 'from-env');
  });

  it('test mode: .env.testing overrides .env (merge, dev keys inherited)', () => {
    const dir = fixture();
    // `.env` sets DATABASE_NAME and a dev-only key, DATABASE_URL.
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\nDATABASE_URL=mysql://dev\n');
    // `.env.testing` re-sets only DATABASE_NAME.
    writeFileSync(join(dir, '.env.testing'), 'DATABASE_NAME=app_test\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });

    assert.equal(env['DATABASE_NAME'], 'app_test');
    // Merge, not substitute: DATABASE_URL lived only in `.env`, and `.env` is
    // still loaded in test mode, so it is inherited.
    assert.equal(env['DATABASE_URL'], 'mysql://dev');
  });

  it('test mode loads .env when .env.testing is absent', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });
    assert.equal(env['DATABASE_NAME'], 'app');
  });

  it('test mode never loads .env.local', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    writeFileSync(join(dir, '.env.testing'), 'DATABASE_NAME=app_test\n');
    writeFileSync(join(dir, '.env.local'), 'DATABASE_NAME=local_dev\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });
    assert.equal(env['DATABASE_NAME'], 'app_test');
  });

  it('non-test mode: .env.local overrides .env', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    writeFileSync(join(dir, '.env.local'), 'DATABASE_NAME=local_dev\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env });
    assert.equal(env['DATABASE_NAME'], 'local_dev');
  });

  it('non-test mode: .env.<nodeEnv> layers over .env', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'A=1\nB=2\n');
    writeFileSync(join(dir, '.env.staging'), 'B=staging\nC=3\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'staging', env });
    assert.equal(env['A'], '1');
    assert.equal(env['B'], 'staging');
    assert.equal(env['C'], '3');
  });

  it('is a silent no-op when no files exist', () => {
    const env = freshEnv();
    assembleEnvironment({ rootDir: join(root, 'missing'), env });
    assert.deepEqual(env, {});
  });
  it('rejects a file that defines a reserved key, before applying anything', () => {
    for (const [file, key] of [
      ['.env', 'NODE_ENV'],
      ['.env.local', 'NODE_ENV'],
      ['.env.development', 'JSAILS_CREDENTIALS_KEY'],
      ['.env', 'JSAILS_CREDENTIALS_LOADED'],
    ] as const) {
      const dir = fixture();
      writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
      writeFileSync(join(dir, file), `DATABASE_NAME=app\n${key}=reserved-value-marker\n`);
      const env = freshEnv();
      assert.throws(
        () => assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env }),
        (error: unknown) =>
          error instanceof DotenvError &&
          error.code === 'invalid_dotenv' &&
          error.message.includes(`${file} defines ${key}`) &&
          !error.message.includes('reserved-value-marker'),
        `${file} ${key}`,
      );
      // A reserved key is refused even when the real environment already sets
      // it, and nothing from the files was applied.
      assert.deepEqual(env, {});
    }
  });

  it('rejects NODE_ENV in a file even when the real environment sets it', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'NODE_ENV=production\n');
    assert.throws(
      () => assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env: { NODE_ENV: 'test' } }),
      DotenvError,
    );
  });

  it('readDotenvFiles merges only the target environment files, never the real environment', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\n');
    writeFileSync(join(dir, '.env.local'), 'B=local\n');
    writeFileSync(join(dir, '.env.production'), 'A=prod\n');
    assert.deepEqual(readDotenvFiles(dir, 'production'), { A: 'prod', B: 'local' });
    assert.deepEqual(readDotenvFiles(dir, 'production', { local: false }), {
      A: 'prod',
      B: 'base',
    });
  });
});
