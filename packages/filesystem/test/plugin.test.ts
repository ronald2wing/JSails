/**
 * The `filesystem` plugin (disks built from data under the token, the
 * definePlugin contract: value-free option validation before any setup and an
 * inert setup, value-free lookup failures) and `createDiskFromEnv` (one disk
 * built from `FILESYSTEM_*` / `S3_*`, refusals that name the variable and
 * never its value).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import { DiskErrors, filesystemToken, type FileSystem } from 'jsails/filesystem';
import { checkOptionSchema, ConfigErrors, describePluginEnv } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';

import {
  createDiskFromEnv,
  FilesystemErrors,
  filesystemPlugin,
  LocalDisk,
  MemoryDisk,
  S3Disk,
} from '../src/index.js';

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(FilesystemErrors.is(error), `expected filesystem.${code}, got ${String(error)}`);
    assert.equal(error.code, `filesystem.${code}`);
    return true;
  };
}

describe('filesystemPlugin', () => {
  it('provides a FileSystem with named lookups, the default, and the names', async () => {
    const plugin = filesystemPlugin({
      disks: { files: { driver: 'memory' }, scratch: { driver: 'memory', maxBytes: 64 } },
      default: 'files',
    });
    assert.equal(plugin.name, 'filesystem');
    const runtime = await runExtensions([plugin], { rootDir: import.meta.dirname, env: {} });
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.ok(fs.disk('files') instanceof MemoryDisk);
      assert.ok(fs.disk('scratch') instanceof MemoryDisk);
      assert.notEqual(fs.disk('files'), fs.disk('scratch'));
      assert.equal(fs.disk(), fs.disk('files'));
      assert.deepEqual(fs.names(), ['files', 'scratch']);
    } finally {
      await runtime.close();
      await runtime.close();
    }
  });

  it('roots a relative local disk at the application root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsails-fs-plugin-'));
    try {
      const runtime = await runExtensions(
        [filesystemPlugin({ disks: { files: { driver: 'local', root: 'storage/files' } } })],
        { rootDir: dir, env: {} },
      );
      try {
        const disk = runtime.services.get(filesystemToken).disk();
        assert.ok(disk instanceof LocalDisk);
        await disk.write('a.txt', new TextEncoder().encode('hi'), { maxBytes: 16 });
        assert.equal(await readFile(join(dir, 'storage', 'files', 'a.txt'), 'utf8'), 'hi');
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds the env disk from the variables it declares, never the process environment', async () => {
    const runtime = await runExtensions(
      [filesystemPlugin({ disks: { files: { driver: 'env' } } })],
      {
        rootDir: import.meta.dirname,
        env: { FILESYSTEM_DISK: 'memory' },
      },
    );
    try {
      assert.ok(runtime.services.get(filesystemToken).disk('files') instanceof MemoryDisk);
    } finally {
      await runtime.close();
    }
    await assert.rejects(
      runExtensions([filesystemPlugin({ disks: { files: { driver: 'env' } } })], {
        rootDir: import.meta.dirname,
        env: { FILESYSTEM_DISK: 's3' },
      }),
      isCode('invalid_environment'),
    );
  });

  it('resolves disk() to the sole disk, and refuses unknown or ambiguous lookups', async () => {
    const sole = await runExtensions(
      [filesystemPlugin({ disks: { only: { driver: 'memory' } } })],
      {
        rootDir: import.meta.dirname,
        env: {},
      },
    );
    const many = await runExtensions(
      [filesystemPlugin({ disks: { a: { driver: 'memory' }, b: { driver: 'memory' } } })],
      { rootDir: import.meta.dirname, env: {} },
    );
    try {
      assert.ok(sole.services.get(filesystemToken).disk() instanceof MemoryDisk);
      const fs = many.services.get(filesystemToken);
      assert.throws(
        () => fs.disk('missing'),
        (error: unknown) => {
          isCode('unknown_disk')(error);
          assert.ok(!(error as Error).message.includes('missing'));
          return true;
        },
      );
      assert.throws(() => fs.disk('toString'), isCode('unknown_disk'));
      assert.throws(() => fs.disk(), isCode('missing_default'));
    } finally {
      await sole.close();
      await many.close();
    }
  });

  it('sets up inertly, building every disk without touching storage', async () => {
    const run = await testPlugin(
      filesystemPlugin({
        disks: {
          files: { driver: 'local', root: 'storage/files' },
          scratch: { driver: 'memory' },
          deployed: { driver: 'env' },
        },
      }),
      {
        env: {
          FILESYSTEM_DISK: 's3',
          S3_BUCKET: 'b',
          S3_REGION: 'us-east-1',
          S3_ACCESS_KEY_ID: 'id',
          S3_SECRET_ACCESS_KEY: 'secret',
        },
      },
    );
    try {
      assert.deepEqual(run.provided, [filesystemToken]);
      assert.ok(run.services.get(filesystemToken).disk('deployed') instanceof S3Disk);
    } finally {
      await run.close();
    }
  });

  it('declares data options and its environment', () => {
    assert.deepEqual(checkOptionSchema(filesystemPlugin.definition.options!), []);
    const env = describePluginEnv('filesystem', filesystemPlugin.definition.env!);
    assert.ok(env.every((variable) => !variable.required));
    assert.deepEqual(
      env.filter((variable) => variable.kind === 'secret').map((variable) => variable.name),
      ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN'],
    );
  });

  describe('invalid options', () => {
    const SECRET = 'zz-secret-input';
    const cases: readonly { readonly name: string; readonly input: unknown }[] = [
      { name: 'no options', input: undefined },
      { name: 'a non-object', input: SECRET },
      { name: 'an unknown option', input: { disks: { a: { driver: 'memory' } }, [SECRET]: 1 } },
      { name: 'no disks', input: { disks: {} } },
      { name: 'a disk instance', input: { disks: { a: new MemoryDisk() } } },
      { name: 'an unknown driver', input: { disks: { a: { driver: SECRET } } } },
      { name: 'a local disk without a root', input: { disks: { a: { driver: 'local' } } } },
      {
        name: 'a malformed disk name',
        input: { disks: { [`${SECRET} /`]: { driver: 'memory' } } },
      },
      { name: 'a zero byte budget', input: { disks: { a: { driver: 'memory', maxBytes: 0 } } } },
      { name: 'a missing default', input: { disks: { a: { driver: 'memory' } }, default: 'b' } },
    ];
    for (const { name, input } of cases) {
      it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
        const factory = filesystemPlugin as unknown as (input: unknown) => unknown;
        assert.throws(
          () => factory(input),
          (error: unknown) => {
            assert.ok(ConfigErrors.is(error, 'invalid_options'));
            assert.equal(
              `${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET),
              false,
            );
            return true;
          },
        );
      });
    }
  });

  it('refuses a malformed declared variable with config.invalid_env before any setup', async () => {
    await assert.rejects(
      runExtensions([filesystemPlugin({ disks: { files: { driver: 'env' } } })], {
        rootDir: import.meta.dirname,
        env: { S3_ENDPOINT: 'not a url secret-value' },
      }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'invalid_env'));
        assert.ok(!String(error).includes('secret-value'));
        return true;
      },
    );
  });

  it('refuses a blank FILESYSTEM_DISK before any setup instead of selecting the local disk', async () => {
    await assert.rejects(
      runExtensions([filesystemPlugin({ disks: { files: { driver: 'env' } } })], {
        rootDir: import.meta.dirname,
        env: { FILESYSTEM_DISK: '', S3_BUCKET: 'b', S3_REGION: 'r' },
      }),
      (error: unknown) =>
        ConfigErrors.is(error, 'invalid_env') &&
        error.context['variable'] === 'FILESYSTEM_DISK' &&
        error.context['problem'] === 'blank',
    );
  });
});

describe('createDiskFromEnv', () => {
  it('roots a relative local root at rootDir when given', () => {
    const { disk } = createDiskFromEnv({ FILESYSTEM_LOCAL_ROOT: 'files' }, { rootDir: tmpdir() });
    assert.ok(disk instanceof LocalDisk);
    assert.throws(() => createDiskFromEnv({}, { rootDir: 'relative' }), isCode('invalid_option'));
  });

  it('builds the selected disk, local by default', () => {
    assert.ok(createDiskFromEnv({}).disk instanceof LocalDisk);
    assert.ok(createDiskFromEnv({ FILESYSTEM_DISK: 'local' }).disk instanceof LocalDisk);
    const memory = createDiskFromEnv({ FILESYSTEM_DISK: 'memory' });
    assert.equal(memory.name, 'memory');
    assert.ok(memory.disk instanceof MemoryDisk);
    const s3 = createDiskFromEnv({
      FILESYSTEM_DISK: 's3',
      S3_BUCKET: 'my-bucket',
      S3_REGION: 'us-west-2',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PREFIX: 'media',
    });
    assert.equal(s3.name, 's3');
    assert.ok(s3.disk instanceof S3Disk);
  });

  it('declares a store without conditional writes through S3_CONDITIONAL_WRITES', async () => {
    const { disk } = createDiskFromEnv({
      FILESYSTEM_DISK: 's3',
      S3_BUCKET: 'b',
      S3_REGION: 'us-east-1',
      S3_CONDITIONAL_WRITES: 'false',
    });
    // Refused before any request, so no network is touched.
    await assert.rejects(
      disk.write('k', new Uint8Array(1), { maxBytes: 1, ifAbsent: true }),
      (error: unknown) => DiskErrors.is(error, 'unsupported'),
    );
  });

  it('names the missing or invalid variable, never its value', () => {
    const cases: [Readonly<Record<string, string>>, string][] = [
      [{ FILESYSTEM_DISK: '' }, 'FILESYSTEM_DISK'],
      [{ FILESYSTEM_DISK: 'ftp-secret-value' }, 'FILESYSTEM_DISK'],
      [{ FILESYSTEM_DISK: 's3' }, 'S3_BUCKET'],
      [{ FILESYSTEM_DISK: 's3', S3_BUCKET: 'b' }, 'S3_REGION'],
      [
        { FILESYSTEM_DISK: 's3', S3_BUCKET: 'b', S3_REGION: 'r', S3_ACCESS_KEY_ID: 'only-id' },
        'S3_SECRET_ACCESS_KEY',
      ],
      [
        { FILESYSTEM_DISK: 's3', S3_BUCKET: 'b', S3_REGION: 'r', S3_CONDITIONAL_WRITES: 'maybe' },
        'S3_CONDITIONAL_WRITES',
      ],
    ];
    for (const [env, variable] of cases) {
      assert.throws(
        () => createDiskFromEnv(env),
        (error: unknown) => {
          isCode('invalid_environment')(error);
          assert.equal((error as { context: { variable: string } }).context.variable, variable);
          assert.doesNotMatch((error as Error).message, /secret-value|only-id/);
          return true;
        },
      );
    }
  });
});
