/**
 * Tests for `jsails credentials`: `edit` creates a key on first use, re-encrypts
 * only changed contents, and never leaves plaintext behind; `show` lists key
 * names without values and fails when the file cannot be read.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  runCredentialsCommand,
  type CredentialsDeps,
} from '../../../src/cli/commands/credentials.js';
import {
  CREDENTIALS_KEY_ENV,
  credentialsPaths,
  encryptCredentials,
  decryptCredentials,
  generateCredentialsKey,
} from '../../../src/credentials.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-credentials-cli-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

interface Harness {
  readonly deps: CredentialsDeps;
  readonly out: string[];
  readonly err: string[];
  readonly drafts: string[];
}

/** A command harness whose editor replaces the draft with `write(previous)`. */
function harness(
  options: {
    dir?: string;
    env?: NodeJS.ProcessEnv;
    write?: (previous: string) => string;
    status?: number;
    ignored?: boolean;
  } = {},
): Harness {
  const dir = options.dir ?? join(root, `case-${seq++}`);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const drafts: string[] = [];
  const deps: CredentialsDeps = {
    rootDir: dir,
    env: options.env ?? {},
    edit(path) {
      drafts.push(path);
      if (options.write !== undefined) {
        writeFileSync(path, options.write(readFileSync(path, 'utf8')));
      }
      return options.status ?? 0;
    },
    isIgnored: () => options.ignored ?? true,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, drafts };
}

describe('jsails credentials', () => {
  it('creates a private key and an encrypted file on the first edit', async () => {
    const h = harness({ write: () => 'API_TOKEN=abc\nOTHER=2\n' });
    const status = await runCredentialsCommand(['edit', '--env', 'production'], h.deps);

    assert.equal(status, 0);
    const paths = credentialsPaths(h.deps.rootDir, 'production');
    assert.equal(statSync(paths.keyFile).mode & 0o777, 0o600);
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    const sealed = readFileSync(paths.file, 'utf8');
    assert.ok(!sealed.includes('abc'));
    assert.equal(decryptCredentials(sealed, key, 'production'), 'API_TOKEN=abc\nOTHER=2\n');
    assert.ok(h.out.some((line) => line.includes('(2 keys)')));
    // The plaintext draft is removed along with its directory.
    assert.equal(existsSync(dirname(h.drafts[0]!)), false);
  });

  it('ignores a development key variable when editing another environment', async () => {
    const devKey = generateCredentialsKey();
    const h = harness({ env: { [CREDENTIALS_KEY_ENV]: devKey }, write: () => 'A=1\n' });
    assert.equal(await runCredentialsCommand(['edit', '--env', 'production'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'production');
    const productionKey = readFileSync(paths.keyFile, 'utf8').trim();
    assert.notEqual(productionKey, devKey);
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), productionKey, 'production'),
      'A=1\n',
    );
  });

  it('leaves the file untouched when the edit changes nothing', async () => {
    const first = harness({ write: () => 'A=1\n' });
    await runCredentialsCommand(['edit'], first.deps);
    const paths = credentialsPaths(first.deps.rootDir, 'development');
    const before = readFileSync(paths.file, 'utf8');

    const second = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['edit'], second.deps), 0);
    assert.equal(readFileSync(paths.file, 'utf8'), before);
    assert.deepEqual(second.out, ['No changes.']);
  });

  it('saves nothing when the editor fails', async () => {
    const h = harness({ write: () => 'A=1\n', status: 1 });
    assert.equal(await runCredentialsCommand(['edit'], h.deps), 1);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
  });

  it('refuses to edit an existing file without its key', async () => {
    const first = harness({ write: () => 'A=1\n' });
    await runCredentialsCommand(['edit'], first.deps);
    rmSync(credentialsPaths(first.deps.rootDir, 'development').keyFile);

    const second = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['edit'], second.deps), 1);
    assert.equal(second.drafts.length, 0);
    assert.match(second.err.join('\n'), /no key/);
  });

  it('warns when git does not ignore the key file', async () => {
    const h = harness({ write: () => 'A=1\n', ignored: false });
    await runCredentialsCommand(['edit'], h.deps);
    assert.match(h.err.join('\n'), /config\/credentials\/\*\.key/);
  });

  it('shows key names only, marking keys the environment overrides', async () => {
    const first = harness({ write: () => 'API_TOKEN=very-secret\nDATABASE_HOST=db\n' });
    await runCredentialsCommand(['edit'], first.deps);

    const h = harness({ dir: first.deps.rootDir, env: { DATABASE_HOST: 'local' } });
    assert.equal(await runCredentialsCommand(['show'], h.deps), 0);
    const text = h.out.join('\n');
    assert.match(text, /API_TOKEN/);
    assert.match(text, /DATABASE_HOST {2}\(overridden by the environment\)/);
    assert.doesNotMatch(text, /very-secret/);
  });

  it('fails show for a missing file or a wrong key, value-free', async () => {
    const missing = harness();
    assert.equal(await runCredentialsCommand(['show'], missing.deps), 1);

    const first = harness({ write: () => 'A=1\n' });
    await runCredentialsCommand(['edit'], first.deps);
    const wrongKey = generateCredentialsKey();
    const h = harness({
      dir: first.deps.rootDir,
      env: { [CREDENTIALS_KEY_ENV]: wrongKey },
    });
    assert.equal(await runCredentialsCommand(['show'], h.deps), 1);
    assert.doesNotMatch(h.err.join('\n'), new RegExp(wrongKey));
  });

  it('regenerates from the assembled environment into a new key and file', async () => {
    const first = harness({ write: () => 'API_TOKEN=old\nOTHER=2\n' });
    await runCredentialsCommand(['edit'], first.deps);
    const paths = credentialsPaths(first.deps.rootDir, 'development');
    const oldKey = readFileSync(paths.keyFile, 'utf8').trim();
    const oldSealed = readFileSync(paths.file, 'utf8');

    const h = harness({ dir: first.deps.rootDir, env: { API_TOKEN: 'new', OTHER: '2' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const newKey = readFileSync(paths.keyFile, 'utf8').trim();
    assert.notEqual(newKey, oldKey);
    assert.equal(statSync(paths.keyFile).mode & 0o777, 0o600);
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), newKey, 'development'),
      'API_TOKEN=new\nOTHER=2\n',
    );
    // The old pair is not what the new one replaced in place: the ciphertext differs.
    assert.notEqual(readFileSync(paths.file, 'utf8'), oldSealed);
    assert.match(h.out.join('\n'), /\(2 keys\)/);
    assert.match(h.out.join('\n'), /left in place/);
  });

  it('regenerates from the .env files, not only process.env', async () => {
    const h = harness({ env: { FROM_PROCESS: 'p' } });
    writeFileSync(join(h.deps.rootDir, '.env'), 'FROM_FILE=file\n');
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'FROM_FILE=file\nFROM_PROCESS=p\n',
    );
  });

  it('refuses to regenerate without --yes', async () => {
    const h = harness({ env: { A: '1' } });
    assert.equal(await runCredentialsCommand(['regenerate'], h.deps), 2);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
    assert.match(h.err.join('\n'), /--yes/);
  });

  it('reorders the existing keys with --order and keeps their values', async () => {
    const first = harness({ write: () => 'A=1\nB=2\nC=3\n' });
    await runCredentialsCommand(['edit'], first.deps);

    const orderFile = join(first.deps.rootDir, 'order.txt');
    writeFileSync(orderFile, '# preferred order\nC\nA\n');
    const h = harness({
      dir: first.deps.rootDir,
      env: { A: '1', B: '2', C: '3' },
    });
    assert.equal(
      await runCredentialsCommand(['regenerate', '--yes', '--order', orderFile], h.deps),
      0,
    );

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'C=3\nA=1\nB=2\n',
    );
  });

  it('keeps the existing document order when --order is absent', async () => {
    const first = harness({ write: () => 'Z=1\nA=2\nM=3\n' });
    await runCredentialsCommand(['edit'], first.deps);

    const h = harness({ dir: first.deps.rootDir, env: { Z: '1', A: '2', M: '3' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'Z=1\nA=2\nM=3\n',
    );
  });

  it('reports keys the environment no longer holds, and writes the ones it gained', async () => {
    const first = harness({ write: () => 'KEPT=1\nGONE=2\n' });
    await runCredentialsCommand(['edit'], first.deps);

    const h = harness({ dir: first.deps.rootDir, env: { KEPT: '1', ADDED: '3' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);
    const text = h.out.join('\n');
    assert.match(text, /Not in the environment, so not written: GONE/);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'KEPT=1\nADDED=3\n',
    );
  });

  it('regenerates a file that no longer decrypts, without reading it', async () => {
    const dir = join(root, `regenerate-broken-${seq++}`);
    const paths = credentialsPaths(dir, 'development');
    mkdirSync(dirname(paths.file), { recursive: true });
    writeFileSync(paths.file, encryptCredentials('A=1\n', generateCredentialsKey(), 'development'));
    writeFileSync(paths.keyFile, `${generateCredentialsKey()}\n`);

    const h = harness({ dir, env: { A: 'fresh' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'A=fresh\n',
    );
  });

  it('writes nothing when the environment holds no value', async () => {
    const h = harness();
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 1);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
    assert.match(h.err.join('\n'), /holds no value/);
  });

  it('quotes a value dotenv would otherwise misread', async () => {
    const h = harness({ env: { PLAIN: 'abc', SPACED: 'a b', HASH: 'a#b', EMPTY: '' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    const plaintext = decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development');
    assert.match(plaintext, /^PLAIN=abc$/m);
    assert.match(plaintext, /^SPACED="a b"$/m);
    assert.match(plaintext, /^HASH="a#b"$/m);
    assert.match(plaintext, /^EMPTY=""$/m);
  });

  it('fails a regenerate whose order file is missing or names an invalid key, value-free', async () => {
    const missing = harness({ env: { A: '1' } });
    assert.equal(
      await runCredentialsCommand(
        ['regenerate', '--yes', '--order', join(root, 'nope.txt')],
        missing.deps,
      ),
      1,
    );
    assert.match(missing.err.join('\n'), /cannot read the order file/);

    const invalid = harness({ env: { A: '1' } });
    const orderFile = join(invalid.deps.rootDir, 'order.txt');
    writeFileSync(orderFile, 'not a key\n');
    assert.equal(
      await runCredentialsCommand(['regenerate', '--yes', '--order', orderFile], invalid.deps),
      1,
    );
    assert.match(invalid.err.join('\n'), /invalid key/);
    assert.equal(existsSync(credentialsPaths(invalid.deps.rootDir, 'development').file), false);
  });

  it('rejects --order and --yes on edit and show', async () => {
    for (const args of [
      ['edit', '--yes'],
      ['show', '--yes'],
      ['edit', '--order', 'x.txt'],
      ['show', '--order', 'x.txt'],
    ]) {
      const h = harness();
      assert.equal(
        await runCredentialsCommand(args, h.deps),
        2,
        `expected 2 for ${args.join(' ')}`,
      );
    }
  });

  it('rejects usage errors with exit code 2', async () => {
    for (const args of [
      [],
      ['rotate'],
      ['edit', 'show'],
      ['edit', '--env'],
      ['edit', '--env', '../x'],
      ['edit', '--bogus'],
    ]) {
      const h = harness();
      assert.equal(
        await runCredentialsCommand(args, h.deps),
        2,
        `expected 2 for ${args.join(' ')}`,
      );
    }
  });
});

describe('the CLI bootstrap with a credentials file', () => {
  const cliPath = fileURLToPath(new URL('../../../src/cli/index.js', import.meta.url));

  /** A project whose development credentials were encrypted with a key it no longer has. */
  function brokenProject(): string {
    const dir = join(root, `cli-${seq++}`);
    const paths = credentialsPaths(dir, 'development');
    mkdirSync(dirname(paths.file), { recursive: true });
    writeFileSync(paths.file, encryptCredentials('A=1\n', generateCredentialsKey(), 'development'));
    writeFileSync(paths.keyFile, `${generateCredentialsKey()}\n`);
    return dir;
  }

  function run(args: string[], cwd: string) {
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env[CREDENTIALS_KEY_ENV];
    return spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' });
  }

  it('stops a command when the file does not decrypt, without echoing the key', () => {
    const dir = brokenProject();
    const result = run(['inspect'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be decrypted/);
    const key = readFileSync(credentialsPaths(dir, 'development').keyFile, 'utf8').trim();
    assert.doesNotMatch(result.stderr, new RegExp(key));
  });

  it('still runs help and the credentials command', () => {
    const dir = brokenProject();
    assert.equal(run(['--help'], dir).status, 0);
    // A bare invocation is a usage error, but never a credentials failure.
    const bare = run([], dir);
    assert.notEqual(bare.status, 1);
    assert.doesNotMatch(bare.stderr, /decrypted/);
    const show = run(['credentials', 'show'], dir);
    assert.equal(show.status, 1);
    assert.match(show.stderr, /could not be decrypted/);
  });
});
