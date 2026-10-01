/**
 * Tests for the `jamal` executable: it resolves the project's environment the
 * way the `jsails` CLI does, under the name the verb defaults to (a server
 * verb runs as the deployed app, `production`; a local verb as the developer,
 * `development`) unless `JSAILS_ENV` names one, then runs the verb over the
 * process arguments and exits with its code. `jsails jamal` gives a verb the
 * same environment.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
/** This package's root, which a test project installs as `@jsails/jamal`. */
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
/**
 * The `jsails` executable of the kernel this package is built against, read
 * from its manifest's `bin` field: a module of the CLI that is not a declared
 * bin loads, runs nothing and exits 0, so naming one by hand would make every
 * `jsails credentials init` below a silent no-op.
 */
const jsailsManifest = createRequire(import.meta.url).resolve('jsails/package.json');
const jsailsCli = join(
  dirname(jsailsManifest),
  (JSON.parse(readFileSync(jsailsManifest, 'utf8')) as { bin: { jsails: string } }).bin.jsails,
);
const cwd = mkdtempSync(join(tmpdir(), 'jamal-bin-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

describe('jamal bin', () => {
  it('prints the usage and exits 0 for --help', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jamal <verb> \[options\]/);
  });

  it('exits 2 with the jamal help hint for an unknown verb', () => {
    const result = run(['bogus']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^jamal: unknown subcommand "bogus"/);
    assert.match(result.stderr, /Run "jamal --help" for usage\./);
  });

  it('exits 1 without a stack trace when the project has no config', () => {
    const result = run(['up']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /jamal config not found/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});

/**
 * The bin invoked directly, as `npx jamal` does, with a stand-in `docker` on
 * PATH that records the variables Compose would interpolate. A shell script
 * on PATH is a POSIX fact, so Windows skips it.
 */
describe(
  'jamal bin: project environment',
  { skip: process.platform === 'win32' && 'a POSIX shell script stands in for docker' },
  () => {
    const VARIABLES = ['DATABASE_PASSWORD', 'DATABASE_NAME', 'FROM_LOCAL'] as const;

    /** A project with a jamal config, the given `.env` files, and a recording `docker`. */
    function project(files: Readonly<Record<string, string>>) {
      const dir = mkdtempSync(join(cwd, 'env-'));
      writeFileSync(
        join(dir, 'jamal.config.js'),
        "export default { service: 'envapp', image: 'envapp', services: { db: { type: 'mariadb' } } };\n",
      );
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const binDir = join(dir, 'fake-bin');
      mkdirSync(binDir);
      const record = join(dir, 'docker-saw.json');
      const docker = join(binDir, 'docker');
      writeFileSync(
        docker,
        [
          `#!${process.execPath}`,
          `const keys = ${JSON.stringify(VARIABLES)};`,
          'const seen = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));',
          `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), seen }) + '\\n');`,
          "if (process.argv[2] === 'ps') process.stdout.write(process.env.FAKE_DOCKER_PS ?? '');",
          '',
        ].join('\n'),
      );
      chmodSync(docker, 0o755);
      return { dir, binDir, record };
    }

    /** Every `docker` call the stand-in saw, in order. */
    function calls(record: string): { argv: string[]; seen: Record<string, string | null> }[] {
      return readFileSync(record, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[]; seen: Record<string, string | null> });
    }

    function runIn(
      dir: string,
      binDir: string,
      args: readonly string[],
      extra: NodeJS.ProcessEnv = {},
    ) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      };
      for (const key of [...VARIABLES, 'NODE_ENV', 'JSAILS_ENV', 'JSAILS_ENV_RESOLVED']) {
        delete env[key];
      }
      return spawnSync(process.execPath, [bin, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, ...extra },
      });
    }

    it('hands Compose the .env values without writing them into the managed file', () => {
      const { dir, binDir, record } = project({
        '.env': 'DATABASE_PASSWORD=from-dotenv-value\nDATABASE_NAME=base\n',
        '.env.local': 'DATABASE_NAME=local\nFROM_LOCAL=yes\n',
      });
      const result = runIn(dir, binDir, ['up']);
      assert.equal(result.status, 0, result.stderr);
      // The project-ownership query, then Compose itself.
      const [query, saw] = calls(record);
      assert.deepEqual(query?.argv.slice(0, 2), ['ps', '--all']);
      assert.ok(saw !== undefined);
      assert.deepEqual(saw.argv.slice(0, 5), [
        'compose',
        '-f',
        '.jamal/compose.yml',
        '-p',
        'envapp',
      ]);
      assert.deepEqual(saw.seen, {
        DATABASE_PASSWORD: 'from-dotenv-value',
        DATABASE_NAME: 'local',
        FROM_LOCAL: 'yes',
      });
      const compose = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');
      assert.match(compose, /\$\{DATABASE_PASSWORD/);
      assert.doesNotMatch(compose, /from-dotenv-value/);
    });

    it('lets a real variable win over .env, and JSAILS_ENV=test read .env.test but not .env.local', () => {
      const { dir, binDir, record } = project({
        '.env': 'DATABASE_PASSWORD=file\nDATABASE_NAME=base\n',
        '.env.local': 'DATABASE_NAME=local\n',
        '.env.test': 'DATABASE_NAME=testing\n',
      });
      const result = runIn(dir, binDir, ['up'], { DATABASE_PASSWORD: 'real', JSAILS_ENV: 'test' });
      assert.equal(result.status, 0, result.stderr);
      const saw = calls(record).at(-1);
      assert.ok(saw !== undefined);
      assert.equal(saw.seen.DATABASE_PASSWORD, 'real');
      assert.equal(saw.seen.DATABASE_NAME, 'testing');
    });

    it('refuses a .env that sets a reserved key, without running Compose or echoing a value', () => {
      const { dir, binDir, record } = project({ '.env': 'NODE_ENV=reserved-value-marker\n' });
      const result = runIn(dir, binDir, ['up']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^jamal: environment\.reserved_key: \.env defines NODE_ENV/);
      assert.doesNotMatch(result.stderr, /reserved-value-marker/);
      assert.throws(() => readFileSync(record), { code: 'ENOENT' });
      // Help resolves no environment, so the same project still prints it.
      const help = runIn(dir, binDir, ['--help']);
      assert.equal(help.status, 0);
      assert.equal(help.stderr, '');
    });

    it("refuses up when another directory's containers hold the project, before Compose runs", () => {
      const { dir, binDir, record } = project({});
      const result = runIn(dir, binDir, ['up'], {
        FAKE_DOCKER_PS: `${join(cwd, 'some-other-app', '.jamal')}\n`,
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /another directory's containers already use this app's Compose project/,
      );
      assert.doesNotMatch(result.stderr, /some-other-app/);
      assert.deepEqual(
        calls(record).map((call) => call.argv[0]),
        ['ps'],
      );
    });
  },
);

/**
 * One developer machine holding every layer: `.env`, `.env.local`,
 * `.env.development`, a stray `.env.production` and `.env.staging`, and sealed
 * development, production, and staging credentials with their keys. Each layer's value names the layer, so
 * an assertion shows which one a verb saw. `secrets fetch PROBE` is the server
 * verb (it prints `$NAME` resolved from the verb's environment, the very
 * substitution a deploy performs), `up` the local one (a stand-in `docker`
 * records what Compose would interpolate). Each runs through the bin and
 * through `jsails jamal`. The stand-ins are POSIX scripts, so Windows skips it.
 */
describe(
  'jamal bin: the environment of a server verb and a local verb',
  { skip: process.platform === 'win32' && 'POSIX scripts stand in for docker and the editor' },
  () => {
    const KEYS = ['NODE_ENV', 'LAYER', 'SEALED', 'FROM_DOTENV', 'FROM_LOCAL'] as const;
    const VALUE_MARKER = /-value/;
    const ENTRY_POINTS = {
      bin: (args: readonly string[]) => [bin, ...args],
      'jsails jamal': (args: readonly string[]) => [jsailsCli, 'jamal', ...args],
    } as const;

    let root: string;

    /** The test environment without any variable a layer defines, with the stand-in docker first on PATH. */
    function baseEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${join(dir, 'fake-bin')}${delimiter}${process.env.PATH ?? ''}`,
      };
      for (const key of [...KEYS, 'JSAILS_ENV', 'JSAILS_CREDENTIALS_KEY', 'JSAILS_ENV_RESOLVED']) {
        delete env[key];
      }
      return { ...env, ...extra };
    }

    /** Seal `SEALED=<environment>-credentials-value` for `environment` through `jsails credentials init`. */
    function seal(dir: string, environment: string): void {
      writeFileSync(join(dir, 'seed.env'), `SEALED=${environment}-credentials-value\n`);
      const result = spawnSync(
        process.execPath,
        [jsailsCli, 'credentials', 'init', '--env', environment, '--from', 'seed.env'],
        { cwd: dir, encoding: 'utf8', env: baseEnv(dir) },
      );
      rmSync(join(dir, 'seed.env'));
      assert.equal(result.status, 0, result.stderr);
    }

    /** A project with every layer; `keys: false` removes the production key afterwards. */
    function machine(options: { keys: boolean }): string {
      const dir = mkdtempSync(join(root, 'machine-'));
      writeFileSync(join(dir, 'package.json'), '{"name":"envapp","type":"module"}\n');
      writeFileSync(
        join(dir, 'jamal.config.js'),
        "export default { service: 'envapp', image: 'envapp', services: { db: { type: 'mariadb' } } };\n",
      );
      mkdirSync(join(dir, 'node_modules', '@jsails'), { recursive: true });
      symlinkSync(packageRoot, join(dir, 'node_modules', '@jsails', 'jamal'), 'dir');
      writeFileSync(join(dir, '.env'), 'LAYER=dotenv-value\nFROM_DOTENV=dotenv-value\n');
      writeFileSync(join(dir, '.env.local'), 'LAYER=local-value\nFROM_LOCAL=local-value\n');
      writeFileSync(join(dir, '.env.development'), 'LAYER=development-file-value\n');
      writeFileSync(join(dir, '.env.production'), 'LAYER=production-file-value\n');
      writeFileSync(join(dir, '.env.staging'), 'LAYER=staging-file-value\n');
      mkdirSync(join(dir, '.jamal'));
      writeFileSync(
        join(dir, '.jamal', 'secrets-common'),
        'PROBE=$NODE_ENV|$LAYER|$SEALED|$FROM_DOTENV|$FROM_LOCAL\n',
      );
      const binDir = join(dir, 'fake-bin');
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, 'docker'),
        [
          `#!${process.execPath}`,
          `const keys = ${JSON.stringify(KEYS)};`,
          'const seen = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));',
          // The project's package.json makes this extensionless script a module.
          `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(join(dir, 'docker-saw.json'))}, JSON.stringify(seen));`,
          '',
        ].join('\n'),
      );
      chmodSync(join(binDir, 'docker'), 0o755);
      for (const environment of ['development', 'production', 'staging']) seal(dir, environment);
      if (!options.keys) rmSync(join(dir, 'config', 'credentials', 'production.key'));
      return dir;
    }

    function runVia(
      entry: keyof typeof ENTRY_POINTS,
      dir: string,
      args: readonly string[],
      extra: NodeJS.ProcessEnv = {},
    ) {
      return spawnSync(process.execPath, ENTRY_POINTS[entry](args), {
        cwd: dir,
        encoding: 'utf8',
        env: baseEnv(dir, extra),
      });
    }

    let withKeys: string;
    let withoutProductionKey: string;

    /**
     * The `<root>` field a resolution in `dir` writes into its marker: the
     * digest the resolver documents, of the root's real path.
     */
    function rootDigest(dir: string): string {
      return createHash('sha256')
        .update('jsails-environment-root\0')
        .update(realpathSync.native(dir))
        .digest('hex');
    }

    before(() => {
      root = mkdtempSync(join(cwd, 'scopes-'));
      withKeys = machine({ keys: true });
      withoutProductionKey = machine({ keys: false });
    });

    for (const entry of Object.keys(ENTRY_POINTS) as (keyof typeof ENTRY_POINTS)[]) {
      it(`${entry}: a server verb reads the production credentials and no .env file at all`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'production||production-credentials-value||');
        assert.equal(result.stderr, '');
      });

      it(`${entry}: an explicit JSAILS_ENV chooses the server verb's environment`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE'], {
          JSAILS_ENV: 'staging',
        });
        assert.equal(result.status, 0, result.stderr);
        // NODE_ENV is derived: every environment but development and test is production.
        assert.equal(result.stdout.trim(), 'production||staging-credentials-value||');
      });

      it(`${entry}: an explicit JSAILS_ENV=production is the default deployment`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE'], {
          JSAILS_ENV: 'production',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'production||production-credentials-value||');
      });

      it(`${entry}: a NODE_ENV that contradicts the environment refuses the verb`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE'], {
          NODE_ENV: 'development',
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^jamal: environment\.conflict: /);
      });

      it(`${entry}: a server verb refuses an environment a jsails command already resolved`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE'], {
          JSAILS_ENV_RESOLVED: `development:none:none:${rootDigest(withKeys)}`,
          LAYER: 'local-value',
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^jamal: environment\.inherited_mismatch: /);
        assert.doesNotMatch(result.stderr, VALUE_MARKER);
      });

      it(`${entry}: a verb refuses an environment resolved for another project`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'fetch', 'PROBE'], {
          JSAILS_ENV_RESOLVED: `production:none:none:${rootDigest(withoutProductionKey)}`,
          LAYER: 'local-value',
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^jamal: environment\.inherited_foreign_project: /);
        assert.doesNotMatch(result.stderr, VALUE_MARKER);
        assert.ok(!result.stderr.includes(withoutProductionKey));
      });

      it(`${entry}: a server verb that lists secrets prints names, never a value`, () => {
        const result = runVia(entry, withKeys, ['secrets', 'print']);
        assert.equal(result.status, 0, result.stderr);
        // The sealed production credentials make a deploy deliver their key.
        assert.equal(
          result.stdout.trim(),
          'PROBE\nJSAILS_CREDENTIALS_KEY  (delivered by jamal deploy from the sealed credentials)',
        );
        assert.doesNotMatch(result.stdout + result.stderr, VALUE_MARKER);
      });

      it(`${entry}: a server verb refuses without the production key, value-free`, () => {
        const result = runVia(entry, withoutProductionKey, ['secrets', 'fetch', 'PROBE']);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(
          result.stderr,
          /^jamal: credentials\.missing_key: config\/credentials\/production\.enc is sealed but no key was found for it; set JSAILS_CREDENTIALS_KEY or add config\/credentials\/production\.key\n {2}hint: /,
        );
      });

      it(`${entry}: a local verb keeps the development environment`, () => {
        const result = runVia(entry, withKeys, ['up']);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(readFileSync(join(withKeys, 'docker-saw.json'), 'utf8')), {
          NODE_ENV: 'development',
          LAYER: 'local-value',
          SEALED: 'development-credentials-value',
          FROM_DOTENV: 'dotenv-value',
          FROM_LOCAL: 'local-value',
        });
        assert.doesNotMatch(result.stdout + result.stderr, VALUE_MARKER);
      });
    }

    it('gives a verb the same environment through both entry points', () => {
      for (const [args, extra] of [
        [['secrets', 'fetch', 'PROBE'], {}],
        [['secrets', 'fetch', 'PROBE'], { JSAILS_ENV: 'staging' }],
      ] as const) {
        const [direct, forwarded] = (['bin', 'jsails jamal'] as const).map((entry) =>
          runVia(entry, withKeys, args, extra),
        );
        assert.equal(direct?.stdout, forwarded?.stdout);
        assert.equal(direct?.stderr, forwarded?.stderr);
        assert.equal(direct?.status, forwarded?.status);
      }
      const seen = (['bin', 'jsails jamal'] as const).map((entry) => {
        assert.equal(runVia(entry, withKeys, ['up']).status, 0);
        return readFileSync(join(withKeys, 'docker-saw.json'), 'utf8');
      });
      assert.equal(seen[0], seen[1]);
    });
  },
);

/**
 * `jamal deploy` through the bin against a fake host: a stand-in `ssh` runs
 * each remote command with `sh` in a directory that plays the server's home,
 * and a stand-in `docker` records its calls. The resolution opens the sealed
 * production credentials, and the deploy writes their key ring into the
 * release's secrets file on the host, whether the key came from the variable
 * alone (a CI job) or from the key file. POSIX shell scripts stand in for both, so Windows skips
 * it (and refuses the verb anyway).
 */
describe(
  'jamal bin: deploy delivers the credentials key to the app',
  { skip: process.platform === 'win32' && 'POSIX scripts stand in for ssh and docker' },
  () => {
    let root: string;

    before(() => {
      root = mkdtempSync(join(cwd, 'delivery-'));
    });

    /** A recording stand-in that runs `body` (a script tail) after logging its argv and key sighting. */
    function standIn(dir: string, name: string, body: string): void {
      const path = join(dir, 'fake-bin', name);
      writeFileSync(
        path,
        [
          `#!${process.execPath}`,
          "const { appendFileSync } = require('node:fs');",
          `appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), sawKey: 'JSAILS_CREDENTIALS_KEY' in process.env }) + '\\n');`,
          body,
          '',
        ].join('\n'),
      );
      chmodSync(path, 0o755);
    }

    /** A project ready to deploy, with sealed production credentials when `sealed`. */
    function project(sealed: boolean): { dir: string; host: string; key: string | undefined } {
      const dir = mkdtempSync(join(root, 'app-'));
      const host = join(dir, 'host-home');
      mkdirSync(host);
      mkdirSync(join(dir, 'fake-bin'));
      writeFileSync(
        join(dir, 'jamal.config.js'),
        "export default { service: 'keyapp', image: 'keyapp', production: { server: 'fake-host' } };\n",
      );
      writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
      // What the stand-ins and the key file leave in the tree is no part of it.
      writeFileSync(
        join(dir, '.gitignore'),
        'fake-bin/\nhost-home/\ncalls.jsonl\nconfig/credentials/*.key\n',
      );
      // The local digest read of the pushed image answers with one digest;
      // every other docker call, local or on the host, does nothing.
      standIn(
        dir,
        'docker',
        `if (process.argv.includes('{{json .RepoDigests}}')) process.stdout.write('["keyapp@sha256:${'a'.repeat(64)}"]\\n');`,
      );
      // The remote command line is ssh's last argument; the host runs it with
      // `sh` in its home, stdin passed through.
      standIn(
        dir,
        'ssh',
        [
          "const { spawnSync } = require('node:child_process');",
          `const result = spawnSync('sh', ['-c', process.argv.at(-1)], { cwd: ${JSON.stringify(host)}, stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(host)} } });`,
          'process.exitCode = result.status ?? 1;',
        ].join('\n'),
      );
      if (!sealed) {
        commitAll(dir);
        return { dir, host, key: undefined };
      }
      writeFileSync(join(dir, 'seed.env'), 'APP_SECRET=sealed-value\n');
      const init = spawnSync(
        process.execPath,
        [jsailsCli, 'credentials', 'init', '--env', 'production', '--from', 'seed.env'],
        { cwd: dir, encoding: 'utf8', env: cleanEnv(dir) },
      );
      rmSync(join(dir, 'seed.env'));
      assert.equal(init.status, 0, init.stderr);
      commitAll(dir);
      const key = readFileSync(join(dir, 'config', 'credentials', 'production.key'), 'utf8').trim();
      return { dir, host, key };
    }

    /** Make `dir` a git checkout whose one commit holds the whole tree: a deploy needs a clean one. */
    function commitAll(dir: string): void {
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        ['commit', '-q', '-m', 'initial'],
      ]) {
        const result = spawnSync(
          'git',
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd: dir, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
      }
    }

    function cleanEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${join(dir, 'fake-bin')}${delimiter}${process.env.PATH ?? ''}`,
      };
      for (const name of [
        'NODE_ENV',
        'JSAILS_ENV',
        'JSAILS_CREDENTIALS_KEY',
        'JSAILS_ENV_RESOLVED',
      ]) {
        delete env[name];
      }
      return { ...env, ...extra };
    }

    function deploy(dir: string, extra: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, [bin, 'deploy'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(dir, extra),
      });
    }

    function calls(dir: string): { name: string; argv: string[]; sawKey: boolean }[] {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { name: string; argv: string[]; sawKey: boolean });
    }

    /** Every file under `dir` but the key file itself contains no `key`. */
    function assertNoFileHolds(dir: string, key: string, skip: string): void {
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        if (path === skip || path.startsWith(join(dir, 'host-home'))) continue;
        assert.ok(!readFileSync(path, 'utf8').includes(key), path);
      }
    }

    /** The secrets directory of the one release a deploy made on `host`. */
    const secretsDir = (host: string): string => {
      const releases = '.jamal/apps/keyapp/releases';
      const made = readdirSync(join(host, releases));
      assert.equal(made.length, 1, 'one release was made');
      return `${releases}/${made[0]}/secrets`;
    };
    const secretsFile = (host: string) => join(host, secretsDir(host), 'secrets.json');
    // The release mounts its secrets by absolute path under the home the
    // host reports (`pwd -P`, so symbolic links resolved).
    const mountsSecrets = (host: string, argv: readonly string[]) =>
      argv.join(' ').includes(`${realpathSync(host)}/${secretsDir(host)}:/run/jsails/secrets:ro`) &&
      !argv.includes('--env-file');

    for (const style of ['the key variable alone (CI)', 'the key file'] as const) {
      it(`writes the key into the release secrets file on the host from ${style}, and nowhere else`, () => {
        const { dir, host, key } = project(true);
        assert.ok(key !== undefined);
        const keyFile = join(dir, 'config', 'credentials', 'production.key');
        const extra: NodeJS.ProcessEnv = {};
        if (style === 'the key variable alone (CI)') {
          rmSync(keyFile);
          extra.JSAILS_CREDENTIALS_KEY = key;
        }
        const result = deploy(dir, extra);
        assert.equal(result.status, 0, result.stderr);

        assert.equal(
          readFileSync(secretsFile(host), 'utf8'),
          `{"v":1,"values":{"JSAILS_CREDENTIALS_KEY":${JSON.stringify(key)}}}\n`,
        );
        assert.equal(statSync(secretsFile(host)).mode & 0o777, 0o444);
        const recorded = calls(dir);
        assert.ok(recorded.some((call) => mountsSecrets(host, call.argv)));
        for (const call of recorded) {
          assert.ok(!call.argv.join(' ').includes(key), `${call.name} ${call.argv.join(' ')}`);
          assert.equal(call.sawKey, false, `${call.name} inherited the key`);
        }
        assert.ok(!(result.stdout + result.stderr).includes(key));
        assertNoFileHolds(dir, key, keyFile);
      });
    }

    it('writes an empty secrets file when the environment has no sealed credentials', () => {
      const { dir, host } = project(false);
      const result = deploy(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(secretsFile(host), 'utf8'), '{"v":1,"values":{}}\n');
      assert.ok(calls(dir).some((call) => mountsSecrets(host, call.argv)));
      assert.ok(!calls(dir).some((call) => call.argv.includes('--env-file')));
    });
  },
);
