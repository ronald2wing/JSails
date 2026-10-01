/**
 * Tests for `jsails credentials`: `edit` creates a key on first use, re-encrypts
 * only changed contents, and never leaves plaintext behind; `show` lists key
 * names without values and fails when the file cannot be read; `regenerate`
 * seals only what the target environment's `.env` files define and never
 * replaces a pair it cannot decrypt. The bootstrap cases cover a missing key
 * outside development and reserved keys in a `.env` file.
 */

import assert from 'node:assert/strict';
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
import { after, describe, it } from 'node:test';

import { CLI_SUITE_CONCURRENCY, runCli } from '../spawn-cli.js';
import {
  runCredentialsCommand,
  type CredentialsDeps,
} from '../../../src/cli/commands/credentials.js';
import {
  CREDENTIALS_KEY_ENV,
  credentialsBackupPaths,
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

/**
 * Asserts the key file is readable by its owner only. Windows has no POSIX
 * file modes (Node reports 0o666 for every writable file), so a key file's
 * privacy there rests on the profile directory's ACL and is not observable
 * through mode bits.
 */
function assertOwnerOnly(file: string): void {
  if (process.platform === 'win32') return;
  assert.equal(statSync(file).mode & 0o777, 0o600);
}

describe('jsails credentials', () => {
  it('creates a private key and an encrypted file on the first edit', async () => {
    const h = harness({ write: () => 'API_TOKEN=abc\nOTHER=2\n' });
    const status = await runCredentialsCommand(['edit', '--env', 'production'], h.deps);

    assert.equal(status, 0);
    const paths = credentialsPaths(h.deps.rootDir, 'production');
    assertOwnerOnly(paths.keyFile);
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

  it('re-seals from the .env files under a new key and keeps the previous pair', async () => {
    const first = harness({ write: () => 'API_TOKEN=old\nOTHER=2\n' });
    await runCredentialsCommand(['edit'], first.deps);
    const paths = credentialsPaths(first.deps.rootDir, 'development');
    const oldKey = readFileSync(paths.keyFile, 'utf8').trim();
    const oldSealed = readFileSync(paths.file, 'utf8');

    writeFileSync(join(first.deps.rootDir, '.env'), 'API_TOKEN=new\nOTHER=2\n');
    const h = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const newKey = readFileSync(paths.keyFile, 'utf8').trim();
    assert.notEqual(newKey, oldKey);
    assertOwnerOnly(paths.keyFile);
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), newKey, 'development'),
      'API_TOKEN=new\nOTHER=2\n',
    );
    // The previous pair is kept, private, and still decrypts. Its names end in
    // .key and .enc, so the existing `config/credentials/*.key` ignore rules
    // (git, and the generated .dockerignore) cover the old key as well.
    const backup = credentialsBackupPaths(first.deps.rootDir, 'development');
    assert.match(backup.keyFile, /development\.previous\.key$/);
    assert.match(backup.file, /development\.previous\.enc$/);
    assertOwnerOnly(backup.keyFile);
    assert.equal(readFileSync(backup.keyFile, 'utf8').trim(), oldKey);
    assert.equal(readFileSync(backup.file, 'utf8'), oldSealed);
    assert.equal(decryptCredentials(oldSealed, oldKey, 'development'), 'API_TOKEN=old\nOTHER=2\n');
    const text = h.out.join('\n');
    assert.match(text, /\(2 keys\)/);
    assert.match(text, /development\.previous\.key and .*development\.previous\.enc/);
    assert.doesNotMatch(text, /left in place/);
    assert.doesNotMatch(h.err.join('\n'), new RegExp(CREDENTIALS_KEY_ENV));
  });

  it('warns that the key variable still holds the previous key, value-free', async () => {
    const dir = join(root, `regenerate-variable-${seq++}`);
    const paths = credentialsPaths(dir, 'production');
    mkdirSync(dirname(paths.file), { recursive: true });
    const oldKey = generateCredentialsKey();
    writeFileSync(paths.file, encryptCredentials('A=1\n', oldKey, 'production'));
    writeFileSync(join(dir, '.env'), 'A=2\n');

    const h = harness({ dir, env: { NODE_ENV: 'production', [CREDENTIALS_KEY_ENV]: oldKey } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    // The new key went to the key file, which the variable still outranks.
    const newKey = readFileSync(paths.keyFile, 'utf8').trim();
    assert.notEqual(newKey, oldKey);
    assert.equal(
      readFileSync(credentialsBackupPaths(dir, 'production').keyFile, 'utf8').trim(),
      oldKey,
    );
    const err = h.err.join('\n');
    assert.match(err, new RegExp(`${CREDENTIALS_KEY_ENV} still holds the previous key`));
    assert.doesNotMatch(err, new RegExp(oldKey));
    assert.doesNotMatch(err, new RegExp(newKey));
  });

  it('never seals a secret that only process.env holds', async () => {
    const h = harness({ env: { SHELL_SECRET: 'from-the-shell', FROM_FILE: 'process-wins' } });
    writeFileSync(join(h.deps.rootDir, '.env'), 'FROM_FILE=file\n');
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    const plaintext = decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development');
    assert.equal(plaintext, 'FROM_FILE=file\n');
    assert.doesNotMatch(plaintext, /SHELL_SECRET|from-the-shell|process-wins/);
  });

  it('seals the target environment files, never .env.local', async () => {
    const h = harness({ env: { NODE_ENV: 'development' } });
    writeFileSync(join(h.deps.rootDir, '.env'), 'BASE=base\nTOKEN=dev\n');
    writeFileSync(join(h.deps.rootDir, '.env.local'), 'TOKEN=machine-local\nLOCAL_ONLY=1\n');
    writeFileSync(join(h.deps.rootDir, '.env.development'), 'DEV_ONLY=dev\n');
    writeFileSync(join(h.deps.rootDir, '.env.production'), 'TOKEN=prod\n');
    assert.equal(
      await runCredentialsCommand(['regenerate', '--env', 'production', '--yes'], h.deps),
      0,
    );

    const paths = credentialsPaths(h.deps.rootDir, 'production');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'production'),
      'BASE=base\nTOKEN=prod\n',
    );
  });

  it('refuses to regenerate without --yes', async () => {
    const h = harness();
    writeFileSync(join(h.deps.rootDir, '.env'), 'A=1\n');
    assert.equal(await runCredentialsCommand(['regenerate'], h.deps), 2);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
    assert.match(h.err.join('\n'), /--yes/);
  });

  it('reorders the existing keys with --order and keeps their values', async () => {
    const first = harness({ write: () => 'A=1\nB=2\nC=3\n' });
    await runCredentialsCommand(['edit'], first.deps);

    const orderFile = join(first.deps.rootDir, 'order.txt');
    writeFileSync(orderFile, '# preferred order\nC\nA\n');
    writeFileSync(join(first.deps.rootDir, '.env'), 'A=1\nB=2\nC=3\n');
    const h = harness({ dir: first.deps.rootDir });
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

    writeFileSync(join(first.deps.rootDir, '.env'), 'A=2\nM=3\nZ=1\n');
    const h = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'Z=1\nA=2\nM=3\n',
    );
  });

  it('reports keys the .env files no longer define, and writes the ones they gained', async () => {
    const first = harness({ write: () => 'KEPT=1\nGONE=2\n' });
    await runCredentialsCommand(['edit'], first.deps);

    writeFileSync(join(first.deps.rootDir, '.env'), 'KEPT=1\nADDED=3\n');
    const h = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 0);
    assert.match(h.out.join('\n'), /Not defined in the \.env files, so not written: GONE/);

    const paths = credentialsPaths(h.deps.rootDir, 'development');
    const key = readFileSync(paths.keyFile, 'utf8').trim();
    assert.equal(
      decryptCredentials(readFileSync(paths.file, 'utf8'), key, 'development'),
      'KEPT=1\nADDED=3\n',
    );
  });

  it('refuses to replace a pair the current key cannot decrypt, value-free', async () => {
    const cases: Array<{ name: string; key: boolean; file: boolean; wrongKey: boolean }> = [
      { name: 'wrong key', key: true, file: true, wrongKey: true },
      { name: 'file without a key', key: false, file: true, wrongKey: false },
      { name: 'key without a file', key: true, file: false, wrongKey: false },
    ];
    for (const entry of cases) {
      const dir = join(root, `regenerate-refused-${seq++}`);
      const paths = credentialsPaths(dir, 'development');
      mkdirSync(dirname(paths.file), { recursive: true });
      const sealedKey = generateCredentialsKey();
      const keyText = `${entry.wrongKey ? generateCredentialsKey() : sealedKey}\n`;
      if (entry.file) {
        writeFileSync(paths.file, encryptCredentials('A=1\n', sealedKey, 'development'));
      }
      if (entry.key) writeFileSync(paths.keyFile, keyText);
      const sealedBefore = entry.file ? readFileSync(paths.file, 'utf8') : undefined;
      writeFileSync(join(dir, '.env'), 'A=fresh\n');

      const h = harness({ dir });
      assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 1, entry.name);
      // Nothing was replaced, and no backup was invented.
      assert.equal(entry.file ? readFileSync(paths.file, 'utf8') : undefined, sealedBefore);
      assert.equal(
        entry.key ? readFileSync(paths.keyFile, 'utf8') : undefined,
        entry.key ? keyText : undefined,
      );
      assert.equal(existsSync(paths.file), entry.file, entry.name);
      const backup = credentialsBackupPaths(dir, 'development');
      assert.equal(existsSync(backup.keyFile), false, entry.name);
      assert.equal(existsSync(backup.file), false, entry.name);
      const err = h.err.join('\n');
      assert.match(err, /move .* aside/, entry.name);
      assert.doesNotMatch(err, new RegExp(keyText.trim()), entry.name);
      assert.doesNotMatch(err, /fresh/, entry.name);
    }
  });

  it('refuses to overwrite an earlier backup', async () => {
    const first = harness({ write: () => 'A=1\n' });
    await runCredentialsCommand(['edit'], first.deps);
    writeFileSync(join(first.deps.rootDir, '.env'), 'A=2\n');
    assert.equal(
      await runCredentialsCommand(
        ['regenerate', '--yes'],
        harness({ dir: first.deps.rootDir }).deps,
      ),
      0,
    );

    const paths = credentialsPaths(first.deps.rootDir, 'development');
    const backup = credentialsBackupPaths(first.deps.rootDir, 'development');
    const backupBefore = readFileSync(backup.file, 'utf8');
    const currentBefore = readFileSync(paths.file, 'utf8');
    const h = harness({ dir: first.deps.rootDir });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 1);
    assert.match(h.err.join('\n'), /already exists/);
    assert.equal(readFileSync(backup.file, 'utf8'), backupBefore);
    assert.equal(readFileSync(paths.file, 'utf8'), currentBefore);
  });

  it('writes nothing when the .env files define no value', async () => {
    const h = harness({ env: { A: '1' } });
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 1);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
    assert.match(h.err.join('\n'), /define no value/);
  });

  it('quotes a value dotenv would otherwise misread', async () => {
    const h = harness();
    writeFileSync(join(h.deps.rootDir, '.env'), 'PLAIN=abc\nSPACED="a b"\nHASH="a#b"\nEMPTY=\n');
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
    const missing = harness();
    writeFileSync(join(missing.deps.rootDir, '.env'), 'A=1\n');
    assert.equal(
      await runCredentialsCommand(
        ['regenerate', '--yes', '--order', join(root, 'nope.txt')],
        missing.deps,
      ),
      1,
    );
    assert.match(missing.err.join('\n'), /cannot read the order file/);

    const invalid = harness();
    writeFileSync(join(invalid.deps.rootDir, '.env'), 'A=1\n');
    const orderFile = join(invalid.deps.rootDir, 'order.txt');
    writeFileSync(orderFile, 'not a key\n');
    assert.equal(
      await runCredentialsCommand(['regenerate', '--yes', '--order', orderFile], invalid.deps),
      1,
    );
    assert.match(invalid.err.join('\n'), /invalid key/);
    assert.equal(existsSync(credentialsPaths(invalid.deps.rootDir, 'development').file), false);
  });

  it('refuses to save a credentials document that defines a reserved key', async () => {
    for (const name of ['NODE_ENV', CREDENTIALS_KEY_ENV]) {
      const h = harness({ write: () => `A=1\n${name}=production\n` });
      assert.equal(await runCredentialsCommand(['edit'], h.deps), 1, name);
      assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
      assert.match(h.err.join('\n'), new RegExp(`defines ${name}`));
      assert.doesNotMatch(h.err.join('\n'), /production/);
    }
  });

  it('refuses to regenerate from a .env file that defines a reserved key', async () => {
    const h = harness();
    writeFileSync(join(h.deps.rootDir, '.env'), 'A=1\nNODE_ENV=production\n');
    assert.equal(await runCredentialsCommand(['regenerate', '--yes'], h.deps), 1);
    assert.match(h.err.join('\n'), /\.env defines NODE_ENV/);
    assert.equal(existsSync(credentialsPaths(h.deps.rootDir, 'development').file), false);
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

describe(
  'the CLI bootstrap with a credentials file',
  { concurrency: CLI_SUITE_CONCURRENCY },
  () => {
    /** A project whose development credentials were encrypted with a key it no longer has. */
    function brokenProject(): string {
      const dir = join(root, `cli-${seq++}`);
      const paths = credentialsPaths(dir, 'development');
      mkdirSync(dirname(paths.file), { recursive: true });
      writeFileSync(
        paths.file,
        encryptCredentials('A=1\n', generateCredentialsKey(), 'development'),
      );
      writeFileSync(paths.keyFile, `${generateCredentialsKey()}\n`);
      return dir;
    }

    function run(args: string[], cwd: string) {
      const env = { ...process.env };
      delete env.NODE_ENV;
      delete env[CREDENTIALS_KEY_ENV];
      return runCli(args, { cwd, env });
    }

    it('stops a command when the file does not decrypt, without echoing the key', async () => {
      const dir = brokenProject();
      const result = await run(['inspect'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /could not be decrypted/);
      const key = readFileSync(credentialsPaths(dir, 'development').keyFile, 'utf8').trim();
      assert.doesNotMatch(result.stderr, new RegExp(key));
    });

    it('still runs help and the credentials command', async () => {
      const dir = brokenProject();
      const [help, bare, show] = await Promise.all([
        run(['--help'], dir),
        run([], dir),
        run(['credentials', 'show'], dir),
      ]);
      assert.equal(help.status, 0);
      // A bare invocation is a usage error, but never a credentials failure.
      assert.notEqual(bare.status, 1);
      assert.doesNotMatch(bare.stderr, /decrypted/);
      assert.equal(show.status, 1);
      assert.match(show.stderr, /could not be decrypted/);
    });
    /** A project with a `production` credentials file and no key for it. */
    function keylessProject(): string {
      const dir = join(root, `cli-keyless-${seq++}`);
      const paths = credentialsPaths(dir, 'production');
      mkdirSync(dirname(paths.file), { recursive: true });
      writeFileSync(
        paths.file,
        encryptCredentials('A=1\n', generateCredentialsKey(), 'production'),
      );
      return dir;
    }

    function runAs(nodeEnv: string, args: string[], cwd: string) {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv };
      delete env[CREDENTIALS_KEY_ENV];
      return runCli(args, { cwd, env });
    }

    it('stops a command outside development and test when the key is missing', async () => {
      const dir = keylessProject();
      const result = await runAs('production', ['inspect'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing_key/);
      assert.match(result.stderr, /production\.enc is present but no key was found/);
      assert.doesNotMatch(result.stderr, /Continuing without credentials/);
    });

    it('lets help, create, credentials, and the build steps run without the key', async () => {
      const dir = keylessProject();
      const exempt = [['build:meta'], ['credentials', 'show']];
      const [help, ...results] = await Promise.all([
        runAs('production', ['--help'], dir),
        ...exempt.map((args) => runAs('production', args, dir)),
      ]);
      assert.equal(help.status, 0);
      exempt.forEach((args, index) => {
        assert.doesNotMatch(results[index]!.stderr, /missing_key: /, args.join(' '));
      });
    });

    it('names the command after leading global flags when exempting a build step', async () => {
      const dir = keylessProject();
      // `--config` comes first, so argv[0] is a flag; the command is still `build`.
      const [build, diff] = await Promise.all([
        runAs('production', ['--config', 'missing.app.js', 'build'], dir),
        runAs('production', ['--config', 'missing.app.js', 'db:diff'], dir),
      ]);
      assert.doesNotMatch(build.stderr, /missing_key: /);
      // A non-exempt command reached the same way still stops.
      assert.equal(diff.status, 1);
      assert.match(diff.stderr, /missing_key: /);
    });

    it('only warns about a reserved key in a .env file for help, create, and credentials', async () => {
      const dir = join(root, `cli-reserved-exempt-${seq++}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'NODE_ENV=reserved-marker\nPLAIN=1\n');
      const [help, create] = await Promise.all([
        run(['--help'], dir),
        run(['create', join(dir, 'app'), '--no-git'], dir),
      ]);
      assert.equal(help.status, 0);
      assert.match(help.stderr, /warning: the \.env files were not loaded: \.env defines NODE_ENV/);
      assert.doesNotMatch(help.stderr, /reserved-marker/);
      assert.equal(create.status, 0, create.stderr);
      assert.match(create.stderr, /were not loaded/);
    });

    it('only warns about a missing key in development', async () => {
      const dir = join(root, `cli-keyless-dev-${seq++}`);
      const paths = credentialsPaths(dir, 'development');
      mkdirSync(dirname(paths.file), { recursive: true });
      writeFileSync(
        paths.file,
        encryptCredentials('A=1\n', generateCredentialsKey(), 'development'),
      );
      // `inspect` is not a build step, so only the environment keeps it running.
      const result = await runAs('development', ['inspect'], dir);
      assert.match(result.stderr, /Continuing without credentials/);
      assert.doesNotMatch(result.stderr, /missing_key: /);
    });

    it('rejects a .env file that sets NODE_ENV, value-free', async () => {
      const dir = join(root, `cli-node-env-${seq++}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'NODE_ENV=production-secret-marker\n');
      const result = await run(['build:meta'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\.env defines NODE_ENV/);
      assert.doesNotMatch(result.stderr, /production-secret-marker/);
    });
  },
);
