/**
 * Tests for the production image generator (`renderAppDockerfile`,
 * `renderAppDockerignore`): determinism, the stage layout, the contract with
 * `jamal deploy` (port, health path, probe timeout, `node` on PATH), the
 * health probe run for real against a local server, and the build-context
 * exclusions that keep secrets out of the image.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  APP_IMAGE_BASE,
  APP_IMAGE_NODE_MAJOR,
  APP_IMAGE_PORT,
  renderAppDockerfile,
  renderAppDockerignore,
} from '../../src/app/dockerfile.js';
import { AppConfigError } from '../../src/app/config/errors.js';
import { DEFAULT_HEALTH_PATH } from '../../src/app/config/defaults.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, '..');

/** The instruction lines of a Dockerfile: comments and blank lines dropped. */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.trimEnd());
}

/** The `node -e` script of the image's HEALTHCHECK, parsed from its exec form. */
function healthProbe(dockerfile: string): string {
  const match = /^ {2}CMD (\[.*\])$/m.exec(dockerfile);
  assert.ok(match !== null, 'the HEALTHCHECK has an exec-form command');
  const argv = JSON.parse(match[1] as string) as string[];
  assert.equal(argv.length, 3);
  assert.equal(argv[0], 'node');
  assert.equal(argv[1], '-e');
  return argv[2] as string;
}

/** Run the probe as the image would, with `JSAILS_PORT` set; resolves its exit code. */
function runProbe(script: string, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, JSAILS_PORT: String(port) },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

describe('renderAppDockerfile', () => {
  it('is deterministic', () => {
    assert.equal(renderAppDockerfile(), renderAppDockerfile());
    assert.equal(renderAppDockerfile({}), renderAppDockerfile({ healthPath: DEFAULT_HEALTH_PATH }));
    assert.equal(renderAppDockerignore(), renderAppDockerignore());
  });

  it('builds in three stages from one base, with the BuildKit syntax line first', () => {
    const dockerfile = renderAppDockerfile();
    assert.ok(dockerfile.startsWith('# syntax=docker/dockerfile:1\n'));
    assert.ok(dockerfile.endsWith('\n'));
    const from = instructions(dockerfile).filter((line) => line.startsWith('FROM '));
    assert.deepEqual(from, [
      `FROM ${APP_IMAGE_BASE} AS base`,
      'FROM base AS deps',
      'FROM base AS build',
      'FROM base',
    ]);
  });

  it('installs production dependencies and builds the app with cached npm installs', () => {
    const dockerfile = renderAppDockerfile();
    assert.match(
      dockerfile,
      /FROM base AS deps\nCOPY package\.json package-lock\.json \.\/\nRUN --mount=type=cache,target=\/root\/\.npm,sharing=locked \\\n {4}npm ci --omit=dev --no-audit --no-fund\n/,
    );
    assert.match(
      dockerfile,
      /FROM base AS build\nCOPY package\.json package-lock\.json \.\/\nRUN --mount=type=cache,target=\/root\/\.npm,sharing=locked \\\n {4}npm ci --no-audit --no-fund\nCOPY \. \.\nRUN npm run build\n/,
    );
  });

  it('runs the built app from production dependencies as the unprivileged node user', () => {
    const runtime = instructions(renderAppDockerfile().split('\nFROM base\n')[1] ?? '');
    assert.deepEqual(runtime.slice(0, 2), [
      `ENV JSAILS_ENV=production NODE_ENV=production JSAILS_HOST=0.0.0.0 JSAILS_PORT=${APP_IMAGE_PORT}`,
      'COPY --from=deps /app/node_modules ./node_modules',
    ]);
    const tail = runtime.slice(runtime.indexOf('    /app ./') + 1);
    assert.deepEqual(tail.slice(0, 3), [
      'RUN install -d -o node -g node storage',
      'USER node',
      `EXPOSE ${APP_IMAGE_PORT}`,
    ]);
    assert.equal(runtime.at(-1), 'CMD ["node", "node_modules/.bin/jsails", "serve"]');
    // NODE_ENV=production would make the build stage's `npm ci` skip the
    // compiler and bundler, so it is set in the runtime stage only.
    assert.equal(renderAppDockerfile().split('NODE_ENV=production').length, 2);
  });

  it('copies the built tree without its node_modules, secrets, or local state', () => {
    const copy = /^COPY --from=build \\\n((?: {4}--exclude=\S+ \\\n)+) {4}\/app \.\/$/m.exec(
      renderAppDockerfile(),
    );
    assert.ok(copy !== null, 'the runtime stage copies /app from the build stage');
    const excluded = [...(copy[1] as string).matchAll(/--exclude=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(excluded, [
      'node_modules',
      '.env',
      '.env.*',
      '.jamal',
      'config/credentials/*.key',
      'storage',
    ]);
    // Every secret and local-state pattern of the .dockerignore is excluded
    // again, so a missing or edited ignore file cannot ship one.
    const ignored = renderAppDockerignore().split('\n');
    for (const pattern of excluded.slice(1)) {
      assert.ok(
        ignored.includes(pattern) || ignored.includes(`${pattern}/`),
        `${pattern} is in .dockerignore too`,
      );
    }
  });

  it('takes no build argument or secret mount, and copies no env or credential file', () => {
    const dockerfile = renderAppDockerfile();
    const lines = instructions(dockerfile);
    assert.ok(!lines.some((line) => line.startsWith('ARG ')));
    assert.doesNotMatch(dockerfile, /type=secret/);
    assert.doesNotMatch(dockerfile, /COPY[^\n]*\.env/);
    assert.doesNotMatch(dockerfile, /COPY[^\n]*credentials/);
  });

  it('declares a HEALTHCHECK on the default /up path', () => {
    const dockerfile = renderAppDockerfile();
    assert.match(
      dockerfile,
      /^HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \\$/m,
    );
    assert.match(healthProbe(dockerfile), /\+'\/up',\{signal:AbortSignal\.timeout\(5000\)\}/);
  });

  it('omits the HEALTHCHECK when the app disabled its health route', () => {
    const dockerfile = renderAppDockerfile({ healthPath: false });
    assert.ok(!instructions(dockerfile).some((line) => line.startsWith('HEALTHCHECK')));
    assert.match(dockerfile, /declares no HEALTHCHECK/);
  });

  it('refuses a health path the app config would refuse, without echoing it', () => {
    for (const healthPath of ['up', '/up/', '/_jsails/up', '/a?b', '/a\nb']) {
      assert.throws(
        () => renderAppDockerfile({ healthPath }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.ok(!error.message.includes(healthPath));
          return true;
        },
      );
    }
  });

  describe('the health probe, run against a local server', () => {
    let server: Server;
    let port: number;
    const seen: string[] = [];

    before(async () => {
      server = createServer((request, response) => {
        seen.push(request.url ?? '');
        response.statusCode = request.url === '/down' ? 503 : 200;
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('exits 0 on a 2xx answer from the health path on JSAILS_PORT', async () => {
      assert.equal(await runProbe(healthProbe(renderAppDockerfile()), port), 0);
      assert.equal(seen.at(-1), '/up');
    });

    it('exits 1 on a non-2xx answer', async () => {
      const probe = healthProbe(renderAppDockerfile({ healthPath: '/down' }));
      assert.equal(await runProbe(probe, port), 1);
    });

    it('exits 1 when nothing listens', async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const unused = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      assert.equal(await runProbe(healthProbe(renderAppDockerfile()), unused), 1);
    });

    it('carries a custom path, quotes included, to the request line', async () => {
      const probe = healthProbe(renderAppDockerfile({ healthPath: "/health/it's" }));
      assert.equal(await runProbe(probe, port), 0);
      assert.equal(seen.at(-1), "/health/it's");
    });
  });

  it('runs the Node line the framework declares', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    assert.equal(manifest.engines.node, `>=${APP_IMAGE_NODE_MAJOR}.0.0`);
    assert.equal(readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim(), `${APP_IMAGE_NODE_MAJOR}`);
    assert.equal(APP_IMAGE_BASE, `node:${APP_IMAGE_NODE_MAJOR}-trixie-slim`);
  });

  it('matches the port, health path, and probe timeout jamal deploy uses', () => {
    // Core does not depend on @jsails/jamal, so its deploy constants are read
    // from source: a change on either side fails here instead of in a deploy.
    const plan = readFileSync(
      join(REPO_ROOT, 'packages', 'jamal', 'src', 'production', 'plan.ts'),
      'utf8',
    );
    assert.match(plan, new RegExp(`export const PRODUCTION_APP_PORT = ${APP_IMAGE_PORT};`));
    assert.match(plan, new RegExp(`const DEFAULT_HEALTH_PATH = '${DEFAULT_HEALTH_PATH}';`));
    assert.match(plan, /const DEFAULT_TIMEOUT_MS = 5000;/);
    // The deploy's health step runs `node` inside the release's container.
    assert.match(plan, /'exec',\n\s+[\w.]+,\n\s+'node',\n\s+'-e',/);
  });
});

describe('renderAppDockerignore', () => {
  const patterns = renderAppDockerignore()
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('keeps secrets and local state out of the build context', () => {
    for (const pattern of ['.env', '.env.*', '.jamal/', 'config/credentials/*.key', 'storage/']) {
      assert.ok(patterns.includes(pattern), `${pattern} is excluded`);
    }
  });

  it('keeps every secret the web starter ignores out of the image too', () => {
    const gitignore = readFileSync(
      join(PACKAGE_ROOT, 'templates', 'starter-web', '.gitignore.template'),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('!'));
    for (const pattern of gitignore) {
      // A database's sidecar files (-journal, -wal, -shm) share one glob.
      const covering = pattern.replace(/^(\*\.(?:sqlite|db))-.*$/, '$1-*');
      assert.ok(patterns.includes(covering), `${pattern} is excluded`);
    }
  });

  it('rebuilds dependencies and build output inside the image', () => {
    for (const pattern of ['node_modules/', 'dist/', 'out/', 'public/assets/', '.jsails/']) {
      assert.ok(patterns.includes(pattern), `${pattern} is excluded`);
    }
  });

  it('excludes version control, deploy tooling, and test output', () => {
    for (const pattern of ['.git/', 'jamal.config.ts', 'test/', 'test-results/', 'coverage/']) {
      assert.ok(patterns.includes(pattern), `${pattern} is excluded`);
    }
  });

  it('keeps what the image build reads', () => {
    for (const kept of ['package.json', 'package-lock.json', 'public/', 'config/', '*.js']) {
      assert.ok(!patterns.includes(kept), `${kept} is not excluded`);
    }
  });
});
