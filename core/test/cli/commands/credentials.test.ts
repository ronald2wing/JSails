/**
 * Tests for `jsails credentials` (init, edit, set, unset, show, import,
 * rotate) and for the CLI's per-command secrets axis: a command that runs the
 * app fails on a sealed document without its key in every environment, while
 * build, help, create, and credentials run without it.
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
import { parseEnv } from 'node:util';
import { after, describe, it } from 'node:test';

import { CLI_SUITE_CONCURRENCY, runCli } from '../spawn-cli.js';
import {
  runCredentialsCommand,
  type CredentialsDeps,
} from '../../../src/cli/commands/credentials.js';
import { parseCommandArgs } from '../../../src/cli/command-args.js';
import { renderCommandHelp } from '../../../src/cli/help.js';
import { BUILTIN_COMMANDS } from '../../../src/cli/manifest.js';
import {
  openCredentials,
  readKeyFile,
  readSealedDocument,
  sealCredentials,
} from '../../../src/environment/credentials.js';
import { KeyRing } from '../../../src/environment/key-ring.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-credentials-cli-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

interface Harness {
  readonly deps: CredentialsDeps;
  readonly dir: string;
  readonly out: string[];
  readonly err: string[];
  readonly drafts: string[];
}

interface HarnessOptions {
  readonly running?: string;
  readonly keyVariable?: KeyRing;
  readonly write?: (previous: string) => string;
  readonly status?: number;
  readonly stdin?: string;
  readonly ignored?: boolean;
  readonly overridden?: readonly string[];
}

/** A command harness whose editor replaces the draft with `write(previous)`. */
function harness(options: HarnessOptions = {}): Harness {
  const dir = join(root, `case-${seq++}`);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const drafts: string[] = [];
  const deps: CredentialsDeps = {
    rootDir: dir,
    runningEnvironment: options.running ?? 'development',
    keyVariable: options.keyVariable,
    overridden: (name) => options.overridden?.includes(name) ?? false,
    edit(path) {
      drafts.push(path);
      if (options.write !== undefined) {
        writeFileSync(path, options.write(readFileSync(path, 'utf8')));
      }
      return options.status ?? 0;
    },
    readStdin: () => options.stdin ?? '',
    isIgnored: () => options.ignored ?? true,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, dir, out, err, drafts };
}

const DESCRIPTOR = BUILTIN_COMMANDS.find((command) => command.name === 'credentials');

/** Run `jsails credentials ...argv` as the dispatcher would, over `deps`. */
async function credentials(argv: readonly string[], deps: CredentialsDeps): Promise<number> {
  assert.ok(DESCRIPTOR);
  const parsed = parseCommandArgs(DESCRIPTOR, argv);
  const usage = (message: string): number => {
    deps.stderr(`jsails: ${message}`);
    return 2;
  };
  if (parsed.kind === 'help') {
    deps.stdout(renderCommandHelp(DESCRIPTOR));
    return 0;
  }
  if (parsed.kind === 'usage') return usage(parsed.message);
  return runCredentialsCommand(parsed.values, parsed.positionals, deps, usage);
}

/** The document of `environment` in `dir`, opened with its key file. */
function opened(dir: string, environment: string): { plaintext: string; keyId: string } {
  const ring = readKeyFile(dir, environment);
  assert.ok(ring !== undefined, 'a key file');
  return openCredentials(readSealedDocument(dir, environment) as Buffer, ring, environment);
}

function values(dir: string, environment: string): Record<string, string | undefined> {
  return { ...parseEnv(opened(dir, environment).plaintext) };
}

/** The key file is readable by its owner only (Windows has no POSIX modes). */
function assertOwnerOnly(file: string): void {
  if (process.platform === 'win32') return;
  assert.equal(statSync(file).mode & 0o777, 0o600);
}

describe('jsails credentials init', () => {
  it('creates a private key file and a sealed document from a dotenv file', async () => {
    const h = harness();
    writeFileSync(join(h.dir, 'seed.env'), '# comment kept\nAPI_TOKEN=abc\nOTHER="two words"\n');
    assert.equal(
      await credentials(['init', '--env', 'production', '--from', 'seed.env'], h.deps),
      0,
    );
    assertOwnerOnly(join(h.dir, 'config/credentials/production.key'));
    const sealed = readFileSync(join(h.dir, 'config/credentials/production.enc'), 'utf8');
    assert.ok(!sealed.includes('abc'));
    assert.match(sealed, /^jsails-credentials v2 production [0-9a-f]{16}\n/);
    assert.equal(
      opened(h.dir, 'production').plaintext,
      '# comment kept\nAPI_TOKEN=abc\nOTHER="two words"\n',
    );
    assert.ok(h.out.some((line) => line.includes('(2 keys)')));
  });

  it('refuses to overwrite an existing document', async () => {
    const h = harness();
    assert.equal(await credentials(['init'], h.deps), 0);
    const before = readFileSync(join(h.dir, 'config/credentials/development.enc'), 'utf8');
    assert.equal(await credentials(['init'], h.deps), 1);
    assert.match(
      h.err.join('\n'),
      /credentials\.already_exists: config\/credentials\/development\.enc already exists/,
    );
    assert.equal(readFileSync(join(h.dir, 'config/credentials/development.enc'), 'utf8'), before);
  });

  it('seals with the running environment variable ring and writes no key file', async () => {
    const ring = KeyRing.generate();
    const h = harness({ running: 'production', keyVariable: ring });
    assert.equal(await credentials(['init', '--env', 'production'], h.deps), 0);
    assert.equal(existsSync(join(h.dir, 'config/credentials/production.key')), false);
    const document = readSealedDocument(h.dir, 'production') as Buffer;
    assert.equal(openCredentials(document, ring, 'production').keyId, ring.currentId);
  });

  it('refuses a source file that defines a reserved or invalid name, value-free', async () => {
    for (const contents of [
      'NODE_ENV=leak-me\n',
      'JSAILS_CREDENTIALS_KEY=leak-me\n',
      'BAD.NAME=leak-me\n',
    ]) {
      const h = harness();
      writeFileSync(join(h.dir, 'seed.env'), contents);
      assert.equal(await credentials(['init', '--from', 'seed.env'], h.deps), 1);
      assert.match(h.err.join('\n'), /credentials\.invalid_source: seed\.env/);
      assert.doesNotMatch(h.err.join('\n'), /leak-me/);
      assert.equal(existsSync(join(h.dir, 'config/credentials/development.enc')), false);
    }
  });

  it('warns when git does not ignore the key file', async () => {
    const h = harness({ ignored: false });
    assert.equal(await credentials(['init'], h.deps), 0);
    assert.match(h.err.join('\n'), /git does not ignore config\/credentials\/development\.key/);
  });
});

describe('jsails credentials edit, set, unset, import, show', () => {
  async function initialized(options: HarnessOptions = {}, seed = 'A=1\nB=2\n'): Promise<Harness> {
    const h = harness(options);
    writeFileSync(join(h.dir, 'seed.env'), seed);
    assert.equal(await credentials(['init', '--from', 'seed.env'], h.deps), 0);
    return h;
  }

  it('re-seals only a changed edit and never leaves the plaintext behind', async () => {
    const h = await initialized({ write: (previous) => `${previous}C=3\n` });
    assert.equal(await credentials(['edit'], h.deps), 0);
    assert.deepEqual(values(h.dir, 'development'), { A: '1', B: '2', C: '3' });
    assert.equal(existsSync(dirname(h.drafts[0] as string)), false);

    const same = await initialized({ write: (previous) => previous });
    const before = readFileSync(join(same.dir, 'config/credentials/development.enc'), 'utf8');
    assert.equal(await credentials(['edit'], same.deps), 0);
    assert.ok(same.out.includes('No changes.'));
    assert.equal(
      readFileSync(join(same.dir, 'config/credentials/development.enc'), 'utf8'),
      before,
    );
  });

  it('saves nothing when the editor fails, and refuses a reserved key in the draft', async () => {
    const failed = await initialized({ status: 1, write: () => 'X=1\n' });
    assert.equal(await credentials(['edit'], failed.deps), 1);
    assert.deepEqual(values(failed.dir, 'development'), { A: '1', B: '2' });

    const reserved = await initialized({ write: () => 'JSAILS_ENV=leak-me\n' });
    assert.equal(await credentials(['edit'], reserved.deps), 1);
    assert.match(reserved.err.join('\n'), /credentials\.reserved_key/);
    assert.doesNotMatch(reserved.err.join('\n'), /leak-me/);
  });

  it('sets a value from stdin that dotenv reads back exactly, keeping the document order', async () => {
    const samples = [
      '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      `quote ' and " together`,
      'back`tick and "double"',
      'literal \\n and $HOME and # hash',
      '',
      ' padded ',
    ];
    for (const value of samples) {
      const h = await initialized({ stdin: `${value}\n` });
      assert.equal(await credentials(['set', 'B'], h.deps), 0);
      assert.deepEqual(values(h.dir, 'development'), { A: '1', B: value }, JSON.stringify(value));
      assert.match(opened(h.dir, 'development').plaintext, /^A=1\nB=/);
    }
  });

  it('refuses a value holding every quote character, or NUL, naming only the key', async () => {
    for (const value of [`a'b"c\`d`, 'nul\0x']) {
      const h = await initialized({ stdin: value });
      assert.equal(await credentials(['set', 'TOKEN'], h.deps), 1);
      assert.match(
        h.err.join('\n'),
        /credentials\.invalid_value: the value of TOKEN cannot be sealed/,
      );
      assert.deepEqual(values(h.dir, 'development'), { A: '1', B: '2' });
    }
  });

  it('refuses to set a reserved or malformed name', async () => {
    for (const name of ['NODE_ENV', 'JSAILS_SECRETS_FILE', 'bad-name']) {
      const h = await initialized({ stdin: 'x' });
      assert.equal(await credentials(['set', name], h.deps), 1);
      assert.match(h.err.join('\n'), /credentials\.invalid_name/);
    }
  });

  it('unsets a name, and fails for one the document does not define', async () => {
    const h = await initialized();
    assert.equal(await credentials(['unset', 'A'], h.deps), 0);
    assert.deepEqual(values(h.dir, 'development'), { B: '2' });
    assert.equal(await credentials(['unset', 'A'], h.deps), 1);
    assert.match(h.err.join('\n'), /credentials\.unknown_name/);
  });

  it('imports a dotenv file over the existing values', async () => {
    const h = await initialized();
    writeFileSync(join(h.dir, 'more.env'), 'B=changed\nC=3\n');
    assert.equal(await credentials(['import', 'more.env'], h.deps), 0);
    assert.deepEqual(values(h.dir, 'development'), { A: '1', B: 'changed', C: '3' });
    assert.equal(await credentials(['import', 'more.env'], h.deps), 0);
    assert.ok(h.out.includes('No changes.'));
  });

  it('never seals what only process.env holds: PATH, GITHUB_TOKEN, or the key', async () => {
    const saved = { ...process.env };
    process.env.GITHUB_TOKEN = 'ghp_must_not_seal';
    process.env.JSAILS_CREDENTIALS_KEY = KeyRing.generate().toVariable();
    try {
      const h = await initialized({ write: (previous) => `${previous}C=3\n`, stdin: 'v' });
      writeFileSync(join(h.dir, 'more.env'), 'D=4\n');
      await credentials(['edit'], h.deps);
      await credentials(['set', 'E'], h.deps);
      await credentials(['import', 'more.env'], h.deps);
      assert.deepEqual(Object.keys(values(h.dir, 'development')).sort(), ['A', 'B', 'C', 'D', 'E']);
    } finally {
      for (const key of ['GITHUB_TOKEN', 'JSAILS_CREDENTIALS_KEY']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('shows names only, marking those a higher layer overrides', async () => {
    const h = await initialized({ overridden: ['B'] }, 'B=secret-two\nA=secret-one\n');
    assert.equal(await credentials(['show'], h.deps), 0);
    const output = h.out.join('\n');
    assert.match(
      output,
      /config\/credentials\/development\.enc \(development, key [0-9a-f]{16}\): 2 keys/,
    );
    assert.match(output, /^ {2}A$/m);
    assert.match(output, /^ {2}B {2}\(overridden by a higher layer\)$/m);
    assert.doesNotMatch(output, /secret-/);
  });

  it('fails show for a missing document, a missing key, or a foreign key, value-free', async () => {
    const missing = harness();
    assert.equal(await credentials(['show'], missing.deps), 1);
    assert.match(missing.err.join('\n'), /credentials\.missing_document/);

    const keyless = await initialized();
    rmSync(join(keyless.dir, 'config/credentials/development.key'));
    assert.equal(await credentials(['show'], keyless.deps), 1);
    assert.match(keyless.err.join('\n'), /credentials\.missing_key/);

    const foreign = await initialized();
    const other = KeyRing.generate();
    writeFileSync(join(foreign.dir, 'config/credentials/development.key'), other.toKeyFile());
    assert.equal(await credentials(['show'], foreign.deps), 1);
    assert.match(foreign.err.join('\n'), /credentials\.unknown_key/);
    assert.doesNotMatch(foreign.err.join('\n'), new RegExp(other.toVariable()));
  });

  it('ignores the running environment variable ring for another environment', async () => {
    const variable = KeyRing.generate();
    const h = harness({ running: 'production', keyVariable: variable });
    assert.equal(await credentials(['init', '--env', 'staging'], h.deps), 0);
    assert.ok(existsSync(join(h.dir, 'config/credentials/staging.key')));
    assert.notEqual(opened(h.dir, 'staging').keyId, variable.currentId);
  });
});

describe('jsails credentials rotate', () => {
  it('adds a new current key, re-seals under it, and finishes by dropping the old one', async () => {
    const h = harness();
    writeFileSync(join(h.dir, 'seed.env'), 'TOKEN=t\n');
    assert.equal(await credentials(['init', '--from', 'seed.env'], h.deps), 0);
    const first = readKeyFile(h.dir, 'development') as KeyRing;
    const oldDocument = readSealedDocument(h.dir, 'development') as Buffer;

    assert.equal(await credentials(['rotate'], h.deps), 0);
    const rotated = readKeyFile(h.dir, 'development') as KeyRing;
    assert.equal(rotated.size, 2);
    assert.equal(rotated.ids[1], first.currentId);
    assertOwnerOnly(join(h.dir, 'config/credentials/development.key'));
    assert.equal(opened(h.dir, 'development').keyId, rotated.currentId);
    // A server still running the old document opens it with the rotated ring.
    assert.equal(openCredentials(oldDocument, rotated, 'development').keyId, first.currentId);
    assert.equal(await credentials(['rotate'], h.deps), 1);
    assert.match(h.err.join('\n'), /credentials\.rotation_in_progress/);

    assert.equal(await credentials(['rotate', '--finish'], h.deps), 0);
    const finished = readKeyFile(h.dir, 'development') as KeyRing;
    assert.deepEqual(finished.ids, [rotated.currentId]);
    assert.deepEqual(values(h.dir, 'development'), { TOKEN: 't' });
    assert.equal(await credentials(['rotate', '--finish'], h.deps), 1);
    assert.match(h.err.join('\n'), /credentials\.no_rotation/);
  });

  it('keeps the rotation state through an edit in the middle of it, in either ring order', async () => {
    const h = harness({ stdin: 'changed' });
    assert.equal(await credentials(['init'], h.deps), 0);
    assert.equal(await credentials(['rotate'], h.deps), 0);
    const rotated = readKeyFile(h.dir, 'development') as KeyRing;
    const reversed = KeyRing.parse(rotated.toVariable().split(',').reverse().join(','));
    writeFileSync(join(h.dir, 'config/credentials/development.key'), reversed.toKeyFile());
    assert.equal(await credentials(['set', 'X'], h.deps), 0);
    assert.equal(opened(h.dir, 'development').keyId, rotated.currentId);
    assert.equal(await credentials(['rotate', '--finish'], h.deps), 0);
    assert.deepEqual((readKeyFile(h.dir, 'development') as KeyRing).ids, [rotated.currentId]);
  });

  it('warns that a key variable still holds the old ring', async () => {
    const ring = KeyRing.generate();
    const h = harness({ keyVariable: ring });
    mkdirSync(join(h.dir, 'config/credentials'), { recursive: true });
    writeFileSync(
      join(h.dir, 'config/credentials/development.enc'),
      sealCredentials('A=1\n', ring, 'development'),
    );
    assert.equal(await credentials(['rotate'], h.deps), 0);
    const err = h.err.join('\n');
    assert.match(err, /JSAILS_CREDENTIALS_KEY still holds the old ring/);
    assert.doesNotMatch(err, new RegExp(ring.toVariable()));
  });
});

describe('jsails credentials usage', () => {
  it('rejects usage errors with exit code 2', async () => {
    for (const args of [
      [],
      ['regenerate'],
      ['edit', '--yes'],
      ['edit', '--order', 'x'],
      ['set'],
      ['set', 'A', 'B'],
      ['show', 'extra'],
      ['edit', '--from', 'x'],
      ['show', '--finish'],
      ['show', '--env'],
      ['show', '--env', '../x'],
    ]) {
      const h = harness();
      assert.equal(await credentials(args, h.deps), 2, args.join(' '));
    }
  });

  it('prints help', async () => {
    const h = harness();
    assert.equal(await credentials(['--help'], h.deps), 0);
    assert.match(h.out.join('\n'), /^jsails credentials - /);
    assert.match(h.out.join('\n'), /"rotate --finish"/);
    assert.doesNotMatch(h.out.join('\n'), /regenerate/);
  });
});

describe('the CLI secrets axis', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  /** A project whose `environment` document is sealed under a key it does not hold. */
  function keyless(environment: string): string {
    const dir = join(root, `cli-${seq++}`);
    mkdirSync(join(dir, 'config/credentials'), { recursive: true });
    writeFileSync(
      join(dir, 'config/credentials', `${environment}.enc`),
      sealCredentials('A=1\n', KeyRing.generate(), environment),
    );
    return dir;
  }

  function runAs(environment: string, args: string[], cwd: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, JSAILS_ENV: environment };
    delete env.NODE_ENV;
    delete env.JSAILS_CREDENTIALS_KEY;
    delete env.JSAILS_ENV_RESOLVED;
    return runCli(args, { cwd, env });
  }

  it('fails serve, work and db:push without the key, in development as in production', async () => {
    const cases: Array<readonly [string, string[]]> = [
      ['production', ['serve']],
      ['production', ['work']],
      ['production', ['db:push']],
      ['development', ['serve']],
      ['test', ['inspect', 'routes']],
    ];
    const results = await Promise.all(
      cases.map(([name, args]) => runAs(name, args, keyless(name))),
    );
    cases.forEach(([name, args], index) => {
      const result = results[index]!;
      assert.equal(result.status, 1, `${name} ${args.join(' ')}`);
      assert.match(
        result.stderr,
        new RegExp(
          `^jsails: credentials\\.missing_key: config/credentials/${name}\\.enc is sealed`,
          'm',
        ),
      );
    });
  });

  it('runs build steps, help, create and credentials without the key', async () => {
    const dir = keyless('production');
    const [help, meta, build, init, create] = await Promise.all([
      runAs('production', ['--help'], dir),
      runAs('production', ['build:meta'], dir),
      runAs('production', ['--config', 'missing.app.js', 'build'], dir),
      runAs('production', ['credentials', 'init', '--env', 'staging'], dir),
      runAs('production', ['create', join(dir, 'app'), '--no-git'], dir),
    ]);
    assert.equal(help.status, 0);
    for (const result of [meta, build, init, create]) {
      assert.doesNotMatch(result.stderr, /credentials\.missing_key/);
    }
    assert.equal(init.status, 0, init.stderr);
    assert.equal(create.status, 0, create.stderr);
  });

  it('takes the environment from a leading --env, and refuses a contradicting NODE_ENV', async () => {
    const dir = keyless('staging');
    const [named, conflict] = await Promise.all([
      runCli(['--env', 'staging', 'inspect', 'routes'], {
        cwd: dir,
        env: { ...process.env, JSAILS_ENV: 'development', NODE_ENV: 'production' },
      }),
      runCli(['inspect', 'routes'], {
        cwd: dir,
        env: { ...process.env, JSAILS_ENV: 'staging', NODE_ENV: 'test' },
      }),
    ]);
    assert.match(named.stderr, /credentials\.missing_key: config\/credentials\/staging\.enc/);
    assert.equal(conflict.status, 1);
    assert.match(
      conflict.stderr,
      /^jsails: environment\.conflict: NODE_ENV is set to something other than production/m,
    );
  });

  it('rejects a .env file that sets a reserved key, value-free, even for a build step', async () => {
    const dir = join(root, `cli-reserved-${seq++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'NODE_ENV=production-secret-marker\n');
    const result = await runAs('development', ['build:meta'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment\.reserved_key: \.env defines NODE_ENV/);
    assert.doesNotMatch(result.stderr, /production-secret-marker/);
  });

  it('resolves no environment for create, which scaffolds outside the directory it runs in', async () => {
    const dir = join(root, `cli-create-${seq++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'NODE_ENV=production-secret-marker\n');
    const result = await runCli(['create', join(dir, 'app'), '--no-git'], {
      cwd: dir,
      env: { ...process.env, JSAILS_ENV: 'staging', NODE_ENV: 'test' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /environment\./);
  });
});
