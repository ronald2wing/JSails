/**
 * Tests for environment resolution: the name and the derived `NODE_ENV`, the
 * precedence of the six layers (a property test over random layer contents),
 * which environments read `.env` files, fatal reserved keys and unreadable
 * files, the per-command secrets axis, the secrets-file layer, and the
 * inheritance marker, including a real parent and child process.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { after, describe, it } from 'node:test';

import { sealCredentials } from '../../src/environment/credentials.js';
import { CredentialsErrors, EnvironmentErrors } from '../../src/environment/errors.js';
import { KeyRing } from '../../src/environment/key-ring.js';
import {
  applyEnvironment,
  resolveEnvironment,
  type EnvironmentSource,
} from '../../src/environment/resolve.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-resolve-'));
/** Creating a directory symlink on Windows needs a privilege CI runners lack. */
const SYMLINKS_NEED_PRIVILEGE = process.platform === 'win32';
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A fresh project directory holding `files` (relative path to contents). */
function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = join(root, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), contents);
  }
  return dir;
}

/** Seal `plaintext` for `environment` in `dir`, writing the key file unless `keyFile` is false. */
function seal(dir: string, environment: string, plaintext: string, keyFile = true): KeyRing {
  const ring = KeyRing.generate();
  mkdirSync(join(dir, 'config', 'credentials'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'credentials', `${environment}.enc`),
    sealCredentials(plaintext, ring, environment),
  );
  if (keyFile) {
    writeFileSync(join(dir, 'config', 'credentials', `${environment}.key`), ring.toKeyFile());
  }
  return ring;
}

/**
 * Seal `plaintext` without the sealing side's checks, as a hostile or older
 * tool could, writing the document and its key file.
 */
function handSeal(dir: string, environment: string, plaintext: string): void {
  const ring = KeyRing.generate();
  const header = `jsails-credentials v2 ${environment} ${ring.currentId}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.encryptionKey(ring.currentId) as Buffer, iv);
  cipher.setAAD(Buffer.from(header));
  const body = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  mkdirSync(join(dir, 'config', 'credentials'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'credentials', `${environment}.enc`),
    `${header}\n${body.toString('base64url')}\n`,
  );
  writeFileSync(join(dir, 'config', 'credentials', `${environment}.key`), ring.toKeyFile());
}

function failsWith(code: string, ...secrets: string[]) {
  return (error: unknown): boolean =>
    (EnvironmentErrors.is(error) || CredentialsErrors.is(error)) &&
    error.code === code &&
    secrets.every((secret) => !error.message.includes(secret));
}

/** A small deterministic PRNG, so a failing property case reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('resolveEnvironment: the name', () => {
  it('defaults to development and derives NODE_ENV from the name', () => {
    const dir = project();
    const cases: Array<readonly [NodeJS.ProcessEnv, string | undefined, string, string]> = [
      [{}, undefined, 'development', 'development'],
      [{ JSAILS_ENV: 'test' }, undefined, 'test', 'test'],
      [{ JSAILS_ENV: 'staging' }, undefined, 'staging', 'production'],
      [{ JSAILS_ENV: 'staging' }, 'production', 'production', 'production'],
      [{ JSAILS_ENV: '' }, undefined, 'development', 'development'],
    ];
    for (const [env, name, expected, nodeEnv] of cases) {
      const resolved = resolveEnvironment({ rootDir: dir, env, name, secrets: 'required' });
      assert.equal(resolved.name, expected);
      assert.equal(resolved.nodeEnv, nodeEnv);
    }
    assert.equal(
      resolveEnvironment({ rootDir: dir, env: {}, defaultName: 'test', secrets: 'required' }).name,
      'test',
    );
  });

  it('is fatal when a real NODE_ENV contradicts the name, value-free', () => {
    const dir = project();
    for (const [env, name] of [
      [{ NODE_ENV: 'production' }, undefined],
      [{ NODE_ENV: 'test' }, 'development'],
      [{ NODE_ENV: 'staging-secret-x' }, 'staging'],
    ] as const) {
      assert.throws(
        () => resolveEnvironment({ rootDir: dir, env, name, secrets: 'unused' }),
        failsWith('environment.conflict', 'staging-secret-x'),
      );
    }
    assert.equal(
      resolveEnvironment({
        rootDir: dir,
        env: { NODE_ENV: 'production', JSAILS_ENV: 'staging' },
        secrets: 'unused',
      }).nodeEnv,
      'production',
    );
  });

  it('rejects a name that could not be a file name, without echoing it', () => {
    for (const name of ['../etc', 'a b', '-x', 'x'.repeat(65)]) {
      assert.throws(
        () => resolveEnvironment({ rootDir: project(), env: {}, name, secrets: 'unused' }),
        failsWith('environment.invalid_name', name),
      );
    }
  });
});

describe('resolveEnvironment: layers', () => {
  const KEYS = ['K1', 'K2', 'K3', 'K4'] as const;
  type Layer = 'process' | 'secrets-file' | '.env.local' | 'credentials' | 'own' | '.env';
  /** Highest precedence first. */
  const ORDER: readonly Layer[] = [
    'process',
    'secrets-file',
    '.env.local',
    'credentials',
    'own',
    '.env',
  ];

  it('property: each key resolves to its highest-precedence layer, and sources names it', () => {
    const random = prng(0x5eed);
    for (let round = 0; round < 120; round += 1) {
      const name = (['development', 'test', 'production', 'staging'] as const)[round % 4] as string;
      const defined = new Map<Layer, Record<string, string>>();
      for (const layer of ORDER) {
        const values: Record<string, string> = {};
        for (const key of KEYS) if (random() < 0.45) values[key] = `${layer}:${key}:${round}`;
        defined.set(layer, values);
      }
      const dotenv = (values: Record<string, string>): string =>
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}\n`)
          .join('');
      const dir = project({
        '.env': dotenv(defined.get('.env') ?? {}),
        [`.env.${name}`]: dotenv(defined.get('own') ?? {}),
        '.env.local': dotenv(defined.get('.env.local') ?? {}),
        'secrets.json': JSON.stringify({ v: 1, values: defined.get('secrets-file') }),
      });
      seal(dir, name, dotenv(defined.get('credentials') ?? {}));
      const env: NodeJS.ProcessEnv = {
        ...defined.get('process'),
        JSAILS_ENV: name,
        JSAILS_SECRETS_FILE: join(dir, 'secrets.json'),
      };
      const resolved = resolveEnvironment({ rootDir: dir, env, secrets: 'required' });

      const reads = (layer: Layer): boolean => {
        if (layer === '.env' || layer === 'own') return name === 'development' || name === 'test';
        if (layer === '.env.local') return name === 'development';
        return true;
      };
      const sourceOf = (layer: Layer): EnvironmentSource =>
        layer === 'own' ? `.env.${name}` : layer;
      for (const key of KEYS) {
        const winner = ORDER.find(
          (layer) => reads(layer) && defined.get(layer)?.[key] !== undefined,
        );
        const context = `round ${round} (${name}) ${key}`;
        if (winner === undefined) {
          assert.equal(resolved.values[key], undefined, context);
          assert.equal(resolved.sources[key], undefined, context);
        } else {
          assert.equal(resolved.values[key], defined.get(winner)?.[key], context);
          assert.equal(resolved.sources[key], sourceOf(winner), context);
        }
      }
    }
  });

  it('reads no .env file in a production-named environment, so a stray .env decides nothing', () => {
    const dir = project({
      '.env': 'DATABASE_PASSWORD=from-a-stray-file\n',
      '.env.production': 'A=1\n',
    });
    for (const name of ['production', 'staging']) {
      const resolved = resolveEnvironment({ rootDir: dir, env: {}, name, secrets: 'required' });
      assert.equal(resolved.values.DATABASE_PASSWORD, undefined);
      assert.equal(resolved.values.A, undefined);
    }
  });

  it('never resolves the control variables as values', () => {
    const ring = KeyRing.generate();
    const resolved = resolveEnvironment({
      rootDir: project(),
      env: { JSAILS_CREDENTIALS_KEY: ring.toVariable(), NODE_ENV: 'development', PATH: '/bin' },
      secrets: 'required',
    });
    for (const key of ['JSAILS_CREDENTIALS_KEY', 'NODE_ENV', 'JSAILS_ENV', 'JSAILS_ENV_RESOLVED']) {
      assert.equal(Object.hasOwn(resolved.values, key), false, key);
    }
    assert.equal(resolved.values.PATH, '/bin');
    assert.equal(resolved.sources.PATH, 'process');
    assert.deepEqual(resolved.keyVariable?.ids, ring.ids);
  });

  it('is fatal when any file kind defines a reserved key, value-free', () => {
    const reserved = ['JSAILS_ENV', 'NODE_ENV', 'JSAILS_CREDENTIALS_KEY', 'JSAILS_SECRETS_FILE'];
    for (const key of reserved) {
      for (const [file, name] of [
        ['.env', 'development'],
        ['.env.development', 'development'],
        ['.env.local', 'development'],
        ['.env.test', 'test'],
      ] as const) {
        const dir = project({ [file]: `${key}=leak-me\n` });
        assert.throws(
          () => resolveEnvironment({ rootDir: dir, env: {}, name, secrets: 'unused' }),
          (error: unknown) =>
            failsWith('environment.reserved_key', 'leak-me')(error) &&
            (error as Error).message ===
              `${file} defines ${key}, which only the real environment may set`,
          `${file} ${key}`,
        );
      }
      const sealedDir = project();
      handSeal(sealedDir, 'development', `${key}=leak-me\n`);
      assert.throws(
        () => resolveEnvironment({ rootDir: sealedDir, env: {}, secrets: 'required' }),
        failsWith('credentials.reserved_key', 'leak-me'),
      );
      // The secrets file may carry the key ring a deploy delivers.
      if (key === 'JSAILS_CREDENTIALS_KEY') continue;
      const secretsDir = project({
        's.json': JSON.stringify({ v: 1, values: { [key]: 'leak-me' } }),
      });
      assert.throws(
        () =>
          resolveEnvironment({
            rootDir: secretsDir,
            env: { JSAILS_SECRETS_FILE: join(secretsDir, 's.json') },
            secrets: 'unused',
          }),
        failsWith('environment.secrets_file_reserved_key', 'leak-me'),
      );
    }
  });

  it(
    'is fatal when a file exists but cannot be read',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    () => {
      const dir = project({ '.env': 'A=1\n' });
      chmodSync(join(dir, '.env'), 0o000);
      try {
        assert.throws(
          () => resolveEnvironment({ rootDir: dir, env: {}, secrets: 'unused' }),
          (error: unknown) =>
            failsWith('environment.unreadable_file', dir)(error) &&
            (error as Error).message === '.env exists but cannot be read',
        );
      } finally {
        chmodSync(join(dir, '.env'), 0o600);
      }
    },
  );

  it('records the secrets file as consumed, and refuses a variable naming a missing one', () => {
    const dir = project({ 's.json': JSON.stringify({ v: 1, values: { A: '1', B: '2' } }) });
    const resolved = resolveEnvironment({
      rootDir: dir,
      env: { JSAILS_SECRETS_FILE: join(dir, 's.json') },
      name: 'production',
      secrets: 'required',
    });
    assert.deepEqual(resolved.secretsFile, { consumed: true, count: 2 });
    assert.equal(resolved.sources.A, 'secrets-file');
    assert.equal(
      resolveEnvironment({ rootDir: dir, env: {}, secrets: 'required' }).secretsFile,
      undefined,
    );
    assert.throws(
      () =>
        resolveEnvironment({
          rootDir: dir,
          env: { JSAILS_SECRETS_FILE: join(dir, 'missing.json') },
          secrets: 'required',
        }),
      failsWith('environment.unreadable_secrets_file', dir),
    );
  });
});

describe('resolveEnvironment: the key ring a secrets file carries', () => {
  it('opens the sealed document with it when the real environment holds no ring', () => {
    const dir = project();
    const ring = seal(dir, 'production', 'TOKEN=from-doc\n', false);
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ v: 1, values: { JSAILS_CREDENTIALS_KEY: ring.toVariable(), A: '1' } }),
    );
    const resolved = resolveEnvironment({
      rootDir: dir,
      env: { JSAILS_SECRETS_FILE: join(dir, 's.json') },
      name: 'production',
      secrets: 'required',
    });
    assert.equal(resolved.values.TOKEN, 'from-doc');
    assert.equal(resolved.credentials.status, 'loaded');
    assert.deepEqual(resolved.keyVariable?.ids, ring.ids);
    assert.equal(Object.hasOwn(resolved.values, 'JSAILS_CREDENTIALS_KEY'), false);
    assert.deepEqual(resolved.secretsFile, { consumed: true, count: 1 });
    const target: NodeJS.ProcessEnv = {};
    applyEnvironment(resolved, target);
    assert.equal(target.JSAILS_CREDENTIALS_KEY, undefined);
    assert.equal(target.A, '1');
  });

  it('loses to a ring in the real environment, and outranks the key file', () => {
    const dir = project();
    const fileRing = seal(dir, 'development', 'TOKEN=t\n');
    const other = KeyRing.generate();
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ v: 1, values: { JSAILS_CREDENTIALS_KEY: other.toVariable() } }),
    );
    // The secrets file's ring is tried before the key file, and cannot open it.
    assert.throws(
      () =>
        resolveEnvironment({
          rootDir: dir,
          env: { JSAILS_SECRETS_FILE: join(dir, 's.json') },
          secrets: 'required',
        }),
      failsWith('credentials.unknown_key'),
    );
    const resolved = resolveEnvironment({
      rootDir: dir,
      env: {
        JSAILS_SECRETS_FILE: join(dir, 's.json'),
        JSAILS_CREDENTIALS_KEY: fileRing.toVariable(),
      },
      secrets: 'required',
    });
    assert.equal(resolved.values.TOKEN, 't');
    assert.deepEqual(resolved.keyVariable?.ids, fileRing.ids);
  });
});

describe('resolveEnvironment: the secrets axis', () => {
  it('fails a command that needs secrets when the document is sealed and no key opens it', () => {
    for (const name of ['development', 'test', 'production']) {
      const dir = project();
      seal(dir, name, 'TOKEN=t0ken-secret\n', false);
      assert.throws(
        () => resolveEnvironment({ rootDir: dir, env: {}, name, secrets: 'required' }),
        (error: unknown) =>
          failsWith('credentials.missing_key', 't0ken-secret')(error) &&
          (error as Error).message.includes(`config/credentials/${name}.enc`),
      );
    }
  });

  it('skips the document for a command that does not use secrets, and records it', () => {
    const dir = project();
    seal(dir, 'production', 'TOKEN=t\n', false);
    const resolved = resolveEnvironment({
      rootDir: dir,
      env: {},
      name: 'production',
      secrets: 'unused',
    });
    assert.equal(resolved.credentials.status, 'skipped');
    assert.equal(resolved.values.TOKEN, undefined);
    assert.match(resolved.marker, /^production:skipped:[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it('opens with the variable ahead of the key file, for the running environment', () => {
    const dir = project();
    const fileRing = seal(dir, 'development', 'TOKEN=from-doc\n');
    const wrong = KeyRing.generate();
    assert.throws(
      () =>
        resolveEnvironment({
          rootDir: dir,
          env: { JSAILS_CREDENTIALS_KEY: wrong.toVariable() },
          secrets: 'required',
        }),
      failsWith('credentials.unknown_key'),
    );
    const both = KeyRing.parse(`${wrong.toVariable()},${fileRing.toVariable()}`);
    const resolved = resolveEnvironment({
      rootDir: dir,
      env: { JSAILS_CREDENTIALS_KEY: both.toVariable() },
      secrets: 'required',
    });
    assert.equal(resolved.values.TOKEN, 'from-doc');
    assert.equal(resolved.credentials.status, 'loaded');
    assert.match(
      resolved.marker,
      new RegExp(`^development:${fileRing.currentId}:[0-9a-f]{64}:[0-9a-f]{64}$`),
    );
  });

  it('records no document in the marker when there is none', () => {
    const resolved = resolveEnvironment({ rootDir: project(), env: {}, secrets: 'required' });
    assert.equal(resolved.credentials.status, 'absent');
    assert.match(resolved.marker, /^development:none:none:[0-9a-f]{64}$/);
  });

  it('binds the marker to a digest of the root, never the path itself', () => {
    const dir = project();
    const resolved = resolveEnvironment({ rootDir: dir, env: {}, secrets: 'required' });
    const root = resolved.marker.split(':').at(-1);
    assert.notEqual(
      root,
      resolveEnvironment({ rootDir: project(), env: {}, secrets: 'required' })
        .marker.split(':')
        .at(-1),
      'another root gets another digest',
    );
    for (const part of dir.split(sep).filter((segment) => segment.length > 2)) {
      assert.ok(!resolved.marker.includes(part), 'no segment of the path appears in the marker');
    }
  });
});

describe('applyEnvironment', () => {
  it('fills every non-real value, sets the name, NODE_ENV and the marker, and consumes the key', () => {
    const dir = project({ '.env': 'FROM_FILE=1\nREAL=file\n' });
    const ring = seal(dir, 'development', 'FROM_DOC=2\n');
    const target: NodeJS.ProcessEnv = { REAL: 'real', JSAILS_CREDENTIALS_KEY: ring.toVariable() };
    const resolved = resolveEnvironment({ rootDir: dir, env: target, secrets: 'required' });
    applyEnvironment(resolved, target);
    assert.equal(target.FROM_FILE, '1');
    assert.equal(target.FROM_DOC, '2');
    assert.equal(target.REAL, 'real');
    assert.equal(target.JSAILS_ENV, 'development');
    assert.equal(target.NODE_ENV, 'development');
    assert.equal(target.JSAILS_ENV_RESOLVED, resolved.marker);
    assert.equal('JSAILS_CREDENTIALS_KEY' in target, false);
  });
});

describe('resolveEnvironment: inheritance', () => {
  function resolvedParent(dir: string, name = 'development'): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { JSAILS_ENV: name };
    applyEnvironment(resolveEnvironment({ rootDir: dir, env, secrets: 'required' }), env);
    return env;
  }

  it('inherits a resolved parent of the same environment and document without reading files', () => {
    const dir = project({ '.env': 'A=parent\n' });
    seal(dir, 'development', 'TOKEN=t\n');
    const child = { ...resolvedParent(dir) };
    writeFileSync(join(dir, '.env'), 'A=changed-after\n');
    const resolved = resolveEnvironment({ rootDir: dir, env: child, secrets: 'required' });
    assert.equal(resolved.values.A, 'parent');
    assert.equal(resolved.values.TOKEN, 't');
    assert.equal(resolved.sources.TOKEN, 'inherited');
    assert.equal(resolved.credentials.status, 'inherited');
    assert.equal(resolved.marker, child.JSAILS_ENV_RESOLVED);
  });

  it(
    'inherits through a symlinked route to the same root',
    { skip: SYMLINKS_NEED_PRIVILEGE },
    () => {
      const dir = project({ '.env': 'A=parent\n' });
      const link = join(root, `link${seq++}`);
      symlinkSync(dir, link, 'dir');
      const resolved = resolveEnvironment({
        rootDir: link,
        env: { ...resolvedParent(dir) },
        secrets: 'required',
      });
      assert.equal(resolved.sources.A, 'inherited');
    },
  );

  it('inherits between the spelled and the real path of one root', () => {
    // macOS's temporary directory sits under the /var -> /private/var symlink,
    // and a Windows one may be spelled with 8.3 short names: a parent started
    // from one spelling and a child from the other are still one project.
    const dir = project({ '.env': 'A=parent\n' });
    for (const [parentRoot, childRoot] of [
      [dir, realpathSync.native(dir)],
      [realpathSync.native(dir), dir],
    ] as const) {
      const resolved = resolveEnvironment({
        rootDir: childRoot,
        env: { ...resolvedParent(parentRoot) },
        secrets: 'required',
      });
      assert.equal(resolved.sources.A, 'inherited');
    }
  });

  it('inherits through a differently cased route on a case-insensitive file system', (t) => {
    const dir = project({ '.env': 'A=parent\n' });
    const name = basename(dir);
    const recased = join(dirname(dir), name.toUpperCase());
    if (recased === dir || !existsSync(recased)) {
      t.skip('the file system is case-sensitive');
      return;
    }
    const resolved = resolveEnvironment({
      rootDir: recased,
      env: { ...resolvedParent(dir) },
      secrets: 'required',
    });
    assert.equal(resolved.sources.A, 'inherited');
  });

  it('is fatal when the marker was written for another project root', () => {
    const parentDir = project({ '.env': 'A=parent\n' });
    const childDir = project({ '.env': 'A=child\n' });
    const child = { ...resolvedParent(parentDir) };
    assert.throws(
      () => resolveEnvironment({ rootDir: childDir, env: child, secrets: 'unused' }),
      failsWith('environment.inherited_foreign_project', parentDir, childDir),
    );
    // The root decides before the name: another project's marker is wrong
    // whatever environment it names.
    assert.throws(
      () =>
        resolveEnvironment({
          rootDir: childDir,
          env: child,
          name: 'production',
          secrets: 'unused',
        }),
      failsWith('environment.inherited_foreign_project'),
    );
  });

  it('is fatal when the child asks for another environment', () => {
    const dir = project();
    const child = { ...resolvedParent(dir) };
    assert.throws(
      () => resolveEnvironment({ rootDir: dir, env: child, name: 'production', secrets: 'unused' }),
      failsWith('environment.inherited_mismatch'),
    );
  });

  it('is fatal when the sealed document differs from the one the parent resolved', () => {
    const dir = project();
    const child = { ...resolvedParent(dir) };
    seal(dir, 'development', 'A=1\n');
    assert.throws(
      () => resolveEnvironment({ rootDir: dir, env: child, secrets: 'unused' }),
      failsWith('environment.inherited_stale'),
    );
  });

  it('is fatal when a child that needs secrets inherits a parent that skipped them', () => {
    const dir = project();
    seal(dir, 'development', 'A=1\n');
    const env: NodeJS.ProcessEnv = {};
    applyEnvironment(resolveEnvironment({ rootDir: dir, env, secrets: 'unused' }), env);
    assert.throws(
      () => resolveEnvironment({ rootDir: dir, env: { ...env }, secrets: 'required' }),
      failsWith('environment.inherited_without_secrets'),
    );
    assert.equal(
      resolveEnvironment({ rootDir: dir, env: { ...env }, secrets: 'unused' }).credentials.status,
      'inherited',
    );
  });

  it('rejects a marker no JSails process wrote', () => {
    const digest = 'c'.repeat(64);
    for (const marker of [
      'development',
      'development:xyz:none',
      'a:none:abc',
      // The format before the root was bound: a marker that names no root
      // cannot prove it belongs to this project.
      'development:none:none',
      `development:none:none:${digest.slice(1)}`,
      `development:none:none:${digest}:${digest}`,
    ]) {
      assert.throws(
        () =>
          resolveEnvironment({
            rootDir: project(),
            env: { JSAILS_ENV_RESOLVED: marker },
            secrets: 'unused',
          }),
        failsWith('environment.invalid_marker'),
      );
    }
  });

  it('spawned child: the parent holds the key, the child does not, and the child succeeds', () => {
    const dir = project({ '.env': 'FROM_FILE=file\n' });
    const ring = seal(dir, 'production', 'TOKEN=sealed-token\n', false);
    const resolver = new URL('../../src/environment/resolve.js', import.meta.url).href;
    const childScript = `
      import { resolveEnvironment } from ${JSON.stringify(resolver)};
      const r = resolveEnvironment({ rootDir: process.cwd(), secrets: 'required' });
      process.stdout.write(JSON.stringify({ token: r.values.TOKEN, source: r.sources.TOKEN,
        status: r.credentials.status, sawKey: 'JSAILS_CREDENTIALS_KEY' in process.env }));
    `;
    const parentScript = `
      import { spawnSync } from 'node:child_process';
      import { applyEnvironment, resolveEnvironment } from ${JSON.stringify(resolver)};
      applyEnvironment(resolveEnvironment({ rootDir: process.cwd(), secrets: 'required' }));
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childScript)}],
        { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      process.exitCode = child.status ?? 1;
    `;
    const { PATH, SystemRoot } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parentScript], {
      cwd: dir,
      env: {
        ...(PATH === undefined ? {} : { PATH }),
        ...(SystemRoot === undefined ? {} : { SystemRoot }),
        JSAILS_ENV: 'production',
        JSAILS_CREDENTIALS_KEY: ring.toVariable(),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      token: 'sealed-token',
      source: 'inherited',
      status: 'inherited',
      sawKey: false,
    });
  });

  it('spawned child: a child started in another project root is refused, value-free', () => {
    const parentDir = project({ '.env': 'SHARED=parent-only-value\n' });
    const childDir = project({ '.env': 'SHARED=child-value\n' });
    const resolver = new URL('../../src/environment/resolve.js', import.meta.url).href;
    const childScript = `
      import { resolveEnvironment } from ${JSON.stringify(resolver)};
      try {
        resolveEnvironment({ rootDir: process.cwd(), secrets: 'required' });
        process.stdout.write('resolved');
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
      }
    `;
    const parentScript = `
      import { spawnSync } from 'node:child_process';
      import { applyEnvironment, resolveEnvironment } from ${JSON.stringify(resolver)};
      applyEnvironment(resolveEnvironment({ rootDir: process.cwd(), secrets: 'required' }));
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childScript)}],
        { cwd: ${JSON.stringify(childDir)}, env: process.env, encoding: 'utf8' });
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      process.exitCode = child.status ?? 1;
    `;
    const { PATH, SystemRoot } = process.env;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parentScript], {
      cwd: parentDir,
      env: {
        ...(PATH === undefined ? {} : { PATH }),
        ...(SystemRoot === undefined ? {} : { SystemRoot }),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { code: string; message: string };
    assert.equal(reported.code, 'environment.inherited_foreign_project');
    for (const leak of [parentDir, childDir, 'parent-only-value', 'child-value']) {
      assert.ok(!reported.message.includes(leak));
    }
  });
});
