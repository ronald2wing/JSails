/**
 * Tests for the remote file writer: the integrity header, modes, the lock
 * fence, the hasher fallbacks, and the refusal to move an incomplete payload
 * into place, run through a real local `sh`; and the value-free errors.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RemoteFileErrors,
  remoteWriteFileArgv,
  remoteWriteFileStdin,
  sha256Hex,
  writeRemoteFile,
  type RemoteWriteOptions,
} from '../../src/production/remote-file.js';
import { remoteCommandLine, type RemoteRunner } from '../../src/production/transport.js';

/**
 * A remote runner that runs the command line in a real local `sh` inside
 * `home`. `mangle` rewrites the stdin before it reaches the shell, standing in
 * for a connection that drops mid-transfer; `path` replaces `PATH`.
 */
function localShellRemote(
  home: string,
  options: { mangle?: (stdin: Buffer) => Buffer; path?: string } = {},
): RemoteRunner {
  return {
    async run(_server, remoteArgv, runOptions) {
      const given = typeof runOptions === 'string' ? runOptions : runOptions?.stdin;
      const stdin = typeof given === 'string' ? Buffer.from(given) : Buffer.from(given ?? '');
      const input = options.mangle === undefined ? stdin : options.mangle(stdin);
      const result = spawnSync('/bin/sh', ['-c', remoteCommandLine(remoteArgv)], {
        cwd: home,
        input,
        encoding: 'utf8',
        env: { ...process.env, ...(options.path === undefined ? {} : { PATH: options.path }) },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

/** The absolute path of a command on this machine's `PATH`. */
function which(command: string): string {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  const found = result.stdout.trim();
  assert.ok(found.startsWith('/'), `${command} must be installed for this test`);
  return found;
}

/** A directory holding only the commands the write script needs besides a digest tool. */
function bareToolDir(root: string): string {
  const dir = join(root, 'bin');
  mkdirSync(dir);
  for (const tool of [
    'sh',
    'mkdir',
    'dirname',
    'cat',
    'rm',
    'wc',
    'tr',
    'mv',
    'chmod',
    'mktemp',
    'sync',
  ]) {
    symlinkSync(which(tool), join(dir, tool));
  }
  return dir;
}

const root = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A new, empty directory standing in for the ssh user's home. */
function freshHome(): string {
  return mkdtempSync(join(root, 'home-'));
}

const PATH_ON_SERVER = 'conf/app/secrets.json';
const SECRET = 'pässwörd\\with=signs#';
const CONTENTS = Buffer.from(`{"v":1,"values":{"SECRET":"${SECRET}\\nline two"}}\n`, 'utf8');
const SECRETS: RemoteWriteOptions = { mode: 0o444, directoryMode: 0o755 };

function isRemoteFileError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(RemoteFileErrors.is(error));
    assert.equal(error.code, `jamal_remote_file.${code}`);
    assert.ok(!error.message.includes('pässwörd'), 'contents must not leak');
    assert.ok(!error.message.includes(PATH_ON_SERVER), 'the path must not leak');
    return true;
  };
}

/** The entries of the destination's directory, temporary files included. */
function entries(home: string): readonly string[] {
  const dir = join(home, 'conf', 'app');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// The remote end is a POSIX server, stood in for by a local /bin/sh with POSIX
// tools and file modes; Windows has neither, and jamal deploy refuses there
// (cli/platform-guard.ts). The argv and stdin tests below run everywhere.
describe(
  'writeRemoteFile through a real shell',
  { skip: process.platform === 'win32' && 'the remote end is a POSIX shell' },
  () => {
    it('writes the exact bytes with the file and directory modes, and leaves no temporary file', async () => {
      const home = freshHome();
      await writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, CONTENTS, SECRETS);

      const file = join(home, PATH_ON_SERVER);
      assert.ok(readFileSync(file).equals(CONTENTS));
      assert.equal(statSync(file).mode & 0o777, 0o444);
      assert.equal(statSync(join(home, 'conf', 'app')).mode & 0o777, 0o755);
      // The parents it created are private: no other user reaches the file.
      assert.equal(statSync(join(home, 'conf')).mode & 0o777, 0o700);
      assert.deepEqual(entries(home), ['secrets.json']);
    });

    it('replaces a read-only file, so a second release write lands', async () => {
      const home = freshHome();
      await writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, CONTENTS, SECRETS);
      const next = Buffer.from('{"v":1,"values":{}}\n');
      await writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, next, SECRETS);
      assert.ok(readFileSync(join(home, PATH_ON_SERVER)).equals(next));
      assert.deepEqual(entries(home), ['secrets.json']);
    });

    it('refuses a payload cut short in transit and keeps the previous file', async () => {
      const home = freshHome();
      mkdirSync(join(home, 'conf', 'app'), { recursive: true });
      writeFileSync(join(home, PATH_ON_SERVER), 'PREVIOUS=1\n');
      const truncate = (stdin: Buffer): Buffer => stdin.subarray(0, stdin.length - 8);

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { mangle: truncate }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
            SECRETS,
          ),
        isRemoteFileError('checksum_mismatch'),
      );
      assert.equal(readFileSync(join(home, PATH_ON_SERVER), 'utf8'), 'PREVIOUS=1\n');
      assert.deepEqual(entries(home), ['secrets.json']);
    });

    it('refuses a payload of the right length whose bytes changed', async () => {
      const home = freshHome();
      const alter = (stdin: Buffer): Buffer =>
        Buffer.from(stdin.toString('utf8').replace('line two', 'line 2!!'));

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { mangle: alter }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
            SECRETS,
          ),
        isRemoteFileError('checksum_mismatch'),
      );
      assert.deepEqual(entries(home), []);
    });

    it('refuses a stream cut inside the header line', async () => {
      const home = freshHome();
      const cutHeader = (stdin: Buffer): Buffer => stdin.subarray(0, 10);

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { mangle: cutHeader }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
            SECRETS,
          ),
        isRemoteFileError('checksum_mismatch'),
      );
      assert.ok(!existsSync(join(home, PATH_ON_SERVER)));
    });

    it('writes under a lock that holds its token, and refuses once it does not', async () => {
      const home = freshHome();
      const lock = join(home, 'lock');
      mkdirSync(lock);
      writeFileSync(join(lock, 'token'), `${'a'.repeat(32)}\n`);
      const fence = { dir: 'lock', token: 'a'.repeat(32) };

      await writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, CONTENTS, {
        ...SECRETS,
        fence,
      });
      assert.ok(readFileSync(join(home, PATH_ON_SERVER)).equals(CONTENTS));

      writeFileSync(join(lock, 'token'), `${'b'.repeat(32)}\n`);
      await assert.rejects(
        () =>
          writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, Buffer.from('{}\n'), {
            ...SECRETS,
            fence,
          }),
        isRemoteFileError('lock_lost'),
      );
      assert.ok(readFileSync(join(home, PATH_ON_SERVER)).equals(CONTENTS));
      assert.deepEqual(entries(home), ['secrets.json']);
    });

    it('falls back to shasum -a 256, then openssl, when sha256sum is absent', async () => {
      const home = freshHome();
      const bin = bareToolDir(home);
      const shasum = join(bin, 'shasum');
      writeFileSync(
        shasum,
        `#!/bin/sh\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 9\nexec ${which('sha256sum')}\n`,
      );
      chmodSync(shasum, 0o755);
      await writeRemoteFile(
        localShellRemote(home, { path: bin }),
        's',
        PATH_ON_SERVER,
        CONTENTS,
        SECRETS,
      );
      assert.ok(readFileSync(join(home, PATH_ON_SERVER)).equals(CONTENTS));

      // openssl's `-r` output has sha256sum's shape: `<hex> *stdin`.
      const opensslHome = freshHome();
      const opensslBin = bareToolDir(opensslHome);
      const openssl = join(opensslBin, 'openssl');
      writeFileSync(
        openssl,
        `#!/bin/sh\n[ "$1 $2 $3" = "dgst -sha256 -r" ] || exit 9\nh=$(${which('sha256sum')})\nprintf '%s *stdin\\n' "\${h%% *}"\n`,
      );
      chmodSync(openssl, 0o755);
      await writeRemoteFile(
        localShellRemote(opensslHome, { path: opensslBin }),
        's',
        PATH_ON_SERVER,
        CONTENTS,
        SECRETS,
      );
      assert.ok(readFileSync(join(opensslHome, PATH_ON_SERVER)).equals(CONTENTS));
    });

    it('refuses to write unverified when the server has no hasher', async () => {
      const home = freshHome();
      const bin = bareToolDir(home);

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { path: bin }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
            SECRETS,
          ),
        isRemoteFileError('no_hasher'),
      );
      assert.ok(!existsSync(join(home, PATH_ON_SERVER)));
      assert.deepEqual(entries(home), []);
    });
  },
);

describe('remote write argv and stdin', () => {
  it('keeps the contents, their digest and the lock token out of the argv', () => {
    const fence = { dir: '.jamal/apps/myapp/lock', token: 'f'.repeat(32) };
    const argv = remoteWriteFileArgv(PATH_ON_SERVER, { ...SECRETS, fence });
    const stdin = remoteWriteFileStdin(CONTENTS, fence);
    const header = stdin.subarray(0, stdin.indexOf(0x0a)).toString('ascii');
    assert.match(header, /^\d+ [0-9a-f]{64} f{32}$/);
    assert.equal(header.split(' ')[0], String(CONTENTS.length));
    assert.ok(stdin.subarray(header.length + 1).equals(CONTENTS));
    const joined = argv.join(' ');
    assert.ok(!joined.includes(header.split(' ')[1] ?? ''));
    assert.ok(!joined.includes(fence.token));
    assert.ok(!joined.includes(SECRET));
    assert.deepEqual(argv.slice(-5), [PATH_ON_SERVER, '444', '755', fence.dir, '']);
  });

  it('carries a precondition as the last argument: absent, or the SHA-256 the file must hold', () => {
    const sum = sha256Hex(Buffer.from('old\n'));
    assert.equal(
      remoteWriteFileArgv(PATH_ON_SERVER, { ...SECRETS, expect: 'absent' }).at(-1),
      'absent',
    );
    assert.equal(remoteWriteFileArgv(PATH_ON_SERVER, { ...SECRETS, expect: sum }).at(-1), sum);
    assert.equal(sum, createHash('sha256').update('old\n').digest('hex'));
    for (const expect of ['', 'present', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`]) {
      assert.throws(
        () => remoteWriteFileArgv(PATH_ON_SERVER, { ...SECRETS, expect }),
        (error: unknown) =>
          isRemoteFileError('invalid_expect')(error) &&
          (expect === '' || !String(error).includes(expect)),
      );
    }
  });

  it('refuses a path, a mode or a fence it cannot pass safely', () => {
    assert.throws(() => remoteWriteFileArgv('-rf', SECRETS), isRemoteFileError('invalid_path'));
    assert.throws(() => remoteWriteFileArgv('a\nb', SECRETS), isRemoteFileError('invalid_path'));
    for (const mode of [0o1777, -1, 1.5]) {
      assert.throws(
        () => remoteWriteFileArgv(PATH_ON_SERVER, { mode }),
        isRemoteFileError('invalid_mode'),
      );
    }
    assert.throws(
      () => remoteWriteFileArgv(PATH_ON_SERVER, { mode: 0o600, fence: { dir: 'l', token: 'a b' } }),
      isRemoteFileError('invalid_lock'),
    );
  });

  it('maps every failure exit to its value-free code', async () => {
    const answering = (exitCode: number): RemoteRunner => ({
      async run() {
        return { exitCode, stdout: '', stderr: SECRET };
      },
    });
    const cases: ReadonlyArray<readonly [number, string]> = [
      [3, 'write_failed'],
      [4, 'checksum_mismatch'],
      [5, 'lock_lost'],
      [6, 'no_hasher'],
      [7, 'precondition_failed'],
      [255, 'write_failed'],
    ];
    for (const [exitCode, code] of cases) {
      await assert.rejects(
        () => writeRemoteFile(answering(exitCode), 's', PATH_ON_SERVER, CONTENTS, SECRETS),
        isRemoteFileError(code),
      );
    }
  });
});
