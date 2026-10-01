/**
 * Tests for the remote file writer: the integrity header, and the refusal to
 * move an incomplete payload into place, run through a real local `sh`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RemoteFileError,
  remoteWriteFileArgv,
  remoteWriteFileStdin,
  writeRemoteFile,
} from '../../src/production/remote-file.js';
import { remoteCommandLine, type RemoteRunner } from '../../src/production/transport.js';

/**
 * A remote runner that runs the command line in a real local `sh` inside
 * `home`. `mangle` rewrites the stdin before it reaches the shell, standing in
 * for a connection that drops mid-transfer; `path` replaces `PATH`.
 */
function localShellRemote(
  home: string,
  options: { mangle?: (stdin: string) => string; path?: string } = {},
): RemoteRunner {
  return {
    async run(_server, remoteArgv, runOptions) {
      const stdin = typeof runOptions === 'string' ? runOptions : runOptions?.stdin;
      const input = options.mangle === undefined ? (stdin ?? '') : options.mangle(stdin ?? '');
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
  for (const tool of ['sh', 'mkdir', 'dirname', 'cat', 'rm', 'wc', 'tr', 'mv']) {
    symlinkSync(which(tool), join(dir, tool));
  }
  return dir;
}

const PATH_ON_SERVER = 'conf/app.env';
const CONTENTS = 'SECRET=pässwörd\\with=signs#\nOTHER=2\n';

function isRemoteFileError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RemoteFileError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('pässwörd'), 'contents must not leak');
    assert.ok(!error.message.includes(PATH_ON_SERVER), 'the path must not leak');
    return true;
  };
}

// The remote end is a POSIX server, stood in for by a local /bin/sh with POSIX
// tools and file modes; Windows has neither, and jamal deploy refuses there
// (cli/platform-guard.ts). The argv and stdin tests below run everywhere.
describe(
  'writeRemoteFile through a real shell',
  { skip: process.platform === 'win32' && 'the remote end is a POSIX shell' },
  () => {
    it('writes the exact bytes with mode 0600 and leaves no temporary file', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      await writeRemoteFile(localShellRemote(home), 's', PATH_ON_SERVER, CONTENTS);

      const file = join(home, PATH_ON_SERVER);
      assert.equal(readFileSync(file, 'utf8'), CONTENTS);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.ok(!existsSync(`${file}.tmp`));
    });

    it('refuses a payload cut short in transit and keeps the previous file', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      mkdirSync(join(home, 'conf'));
      writeFileSync(join(home, PATH_ON_SERVER), 'PREVIOUS=1\n');
      const truncate = (stdin: string): string => stdin.slice(0, stdin.length - 8);

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { mangle: truncate }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
          ),
        isRemoteFileError('integrity_failed'),
      );
      assert.equal(readFileSync(join(home, PATH_ON_SERVER), 'utf8'), 'PREVIOUS=1\n');
      assert.ok(!existsSync(join(home, `${PATH_ON_SERVER}.tmp`)));
    });

    it('refuses a payload of the right length whose bytes changed', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      const alter = (stdin: string): string => stdin.replace('OTHER=2', 'OTHER=3');

      await assert.rejects(
        () =>
          writeRemoteFile(localShellRemote(home, { mangle: alter }), 's', PATH_ON_SERVER, CONTENTS),
        isRemoteFileError('integrity_failed'),
      );
      assert.ok(!existsSync(join(home, PATH_ON_SERVER)));
      assert.ok(!existsSync(join(home, `${PATH_ON_SERVER}.tmp`)));
    });

    it('refuses a stream cut inside the header line', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      const cutHeader = (stdin: string): string => stdin.slice(0, 10);

      await assert.rejects(
        () =>
          writeRemoteFile(
            localShellRemote(home, { mangle: cutHeader }),
            's',
            PATH_ON_SERVER,
            CONTENTS,
          ),
        isRemoteFileError('integrity_failed'),
      );
      assert.ok(!existsSync(join(home, PATH_ON_SERVER)));
    });

    it('falls back to shasum -a 256 when sha256sum is absent', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      const bin = bareToolDir(home);
      const shasum = join(bin, 'shasum');
      writeFileSync(
        shasum,
        `#!/bin/sh\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 9\nexec ${which('sha256sum')}\n`,
      );
      chmodSync(shasum, 0o755);

      await writeRemoteFile(localShellRemote(home, { path: bin }), 's', PATH_ON_SERVER, CONTENTS);
      assert.equal(readFileSync(join(home, PATH_ON_SERVER), 'utf8'), CONTENTS);
    });

    it('refuses to write unverified when the server has no digest tool', async () => {
      const home = mkdtempSync(join(tmpdir(), 'jamal-remote-file-'));
      const bin = bareToolDir(home);

      await assert.rejects(
        () => writeRemoteFile(localShellRemote(home, { path: bin }), 's', PATH_ON_SERVER, CONTENTS),
        isRemoteFileError('missing_digest_tool'),
      );
      assert.ok(!existsSync(join(home, PATH_ON_SERVER)));
      assert.ok(!existsSync(join(home, `${PATH_ON_SERVER}.tmp`)));
    });
  },
);

describe('remote write argv and stdin', () => {
  it('keeps the contents and their digest out of the argv', () => {
    const argv = remoteWriteFileArgv(PATH_ON_SERVER);
    const stdin = remoteWriteFileStdin(CONTENTS);
    const header = stdin.slice(0, stdin.indexOf('\n'));
    assert.match(header, /^\d+ [0-9a-f]{64}$/);
    assert.equal(header.split(' ')[0], String(Buffer.byteLength(CONTENTS, 'utf8')));
    assert.ok(!argv.join(' ').includes(header.split(' ')[1] ?? ''));
    assert.equal(argv.at(-1), PATH_ON_SERVER);
  });

  it('reports a failure exit as io_failed, value-free', async () => {
    const remote: RemoteRunner = {
      async run() {
        return { exitCode: 3, stdout: '', stderr: CONTENTS };
      },
    };
    await assert.rejects(
      () => writeRemoteFile(remote, 's', PATH_ON_SERVER, CONTENTS),
      isRemoteFileError('io_failed'),
    );
  });
});
