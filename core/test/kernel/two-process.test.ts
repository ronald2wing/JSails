/**
 * The reach rule across real processes, through the CLI. `jsails serve` (the
 * web role) and `jsails work` (the worker role) of one app run a job a route
 * dispatched when the jobs transport is shared (a file-backed fake adapter
 * that declares `reach: 'shared'`), including a job a request dispatches
 * after the server stopped accepting on the shutdown signal: the HTTP server
 * drains before the producer it dispatches on. Over the in-memory adapter each of them is
 * refused with `kernel.adapter_not_shared` before anything starts, instead of
 * dispatching jobs no worker will ever see.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { cliPath } from '../cli/spawn-cli.js';

// Under core's dist, so the app config resolves `jsails/*` and `zod` as an
// installed app does.
const fixtures = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'two-process-'),
);
after(() => rmSync(fixtures, { recursive: true, force: true }));

/**
 * A jobs adapter over a directory: a dispatch writes one file, a worker claims
 * files by renaming them. Any process on the same directory sees the jobs, so
 * its reach is shared.
 */
const FILE_ADAPTER = `
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class FileJobsAdapter {
  name = 'file';
  reach = 'shared';
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  createProducer() {
    const dir = this.dir;
    let sequence = 0;
    let closed = false;
    return {
      async dispatch(name, data, opts) {
        if (closed) throw new Error('the producer is closed');
        const id = process.pid + '-' + sequence++;
        writeFileSync(join(dir, id + '.tmp'), JSON.stringify({ name, data, opts }));
        renameSync(join(dir, id + '.tmp'), join(dir, id + '.job'));
        return id;
      },
      async close() {
        closed = true;
      },
    };
  }
  createWorker(_context, processJob) {
    const dir = this.dir;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.job'))) {
          const claimed = join(dir, file + '.claimed');
          try {
            renameSync(join(dir, file), claimed);
          } catch {
            continue;
          }
          const { name, data, opts } = JSON.parse(readFileSync(claimed, 'utf8'));
          await processJob({
            name, id: file, data, opts, attemptsMade: 0, attemptsStarted: 1,
            log: async () => {}, updateProgress: async () => {},
          });
          rmSync(claimed);
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => { poll().catch((error) => process.emitWarning(error)); }, 20);
    return { async close() { clearInterval(timer); } };
  }
}
`;

/** The app config both processes load, with `adapter` as its jobs transport. */
function appConfig(adapter: 'file' | 'memory'): string {
  return `
import { z } from 'zod';
import { createJobRegistry, defineJob, jobsPlugin, MemoryJobsAdapter } from 'jsails/jobs';
import { FileJobsAdapter } from './file-adapter.mjs';

export default {
  host: '127.0.0.1',
  port: 0,
  extensions: [
    jobsPlugin({
      registry: createJobRegistry({
        record: defineJob(z.string(), (payload) => {
          process.stdout.write('ran ' + payload + '\\n');
        }),
      }),
      adapter: ${adapter === 'file' ? `new FileJobsAdapter(${JSON.stringify(join(fixtures, 'queue'))})` : 'new MemoryJobsAdapter()'},
      prefix: 'two-process',
    }),
  ],
};
`;
}

/** A route that dispatches `record` with `payload`, once `before` resolved. */
function dispatchRoute(path: string, payload: string, before: string): string {
  return `
import { defineApi, publicAccess, Respond } from 'jsails/api';
import { jobsToken } from 'jsails/jobs';

export default defineApi(${JSON.stringify(path)}, {
  access: publicAccess('two-process test'),
  GET: async ({ services }) => {
    ${before}
    const id = await services.get(jobsToken).dispatch('record', ${JSON.stringify(payload)});
    return Respond.json({ id });
  },
});
`;
}

writeFileSync(join(fixtures, 'package.json'), JSON.stringify({ name: 'two-process' }));
writeFileSync(join(fixtures, 'file-adapter.mjs'), FILE_ADAPTER);
writeFileSync(join(fixtures, 'jsails.app.js'), appConfig('file'));
writeFileSync(join(fixtures, 'memory.app.js'), appConfig('memory'));
mkdirSync(join(fixtures, 'api'));
writeFileSync(join(fixtures, 'api', 'dispatch.js'), dispatchRoute('/api/dispatch', 'route', ''));
// Holds its request until the process receives SIGUSR2, then dispatches: the
// test sends it once the server stopped accepting, so the job is dispatched by
// a request still in flight while the server drains.
writeFileSync(
  join(fixtures, 'api', 'late.js'),
  dispatchRoute(
    '/api/late',
    'late',
    `const proceed = new Promise((resolve) => process.once('SIGUSR2', resolve));
    process.stdout.write('handling\\n');
    await proceed;`,
  ),
);

/** A CLI child and its output, with a wait for a line on its stdout. */
interface Cli {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  output(): string;
  /** The first match of `pattern` on stdout; fails when the child exits first. */
  line(pattern: RegExp): Promise<RegExpMatchArray>;
}

/** Run the compiled CLI in the fixture app, in the test environment. */
function cli(args: readonly string[]): Cli {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', JSAILS_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT;
  delete env.VALKEY_URL;
  delete env.JSAILS_ENV_RESOLVED;
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: fixtures,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters: { pattern: RegExp; resolve: (match: RegExpMatchArray) => void }[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const waiter of [...waiters]) {
      const match = waiter.pattern.exec(stdout);
      if (match === null) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(match);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  const output = (): string => stdout + stderr;
  return {
    child,
    exited,
    output,
    line: (pattern) =>
      Promise.race([
        new Promise<RegExpMatchArray>((resolve) => {
          const match = pattern.exec(stdout);
          if (match === null) waiters.push({ pattern, resolve });
          else resolve(match);
        }),
        exited.then((code) => {
          throw new Error(`jsails ${args[0]} exited (${code}) before ${pattern}: ${output()}`);
        }),
      ]),
  };
}

/** A GET on a connection of its own, closed after the response. */
function getOnce(url: URL): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

/**
 * Resolve once a connection to `url`'s port is refused: the server stopped
 * accepting, so its shutdown began. Each attempt that still connects is
 * closed at once and tried again on a later turn.
 */
async function refused(url: URL): Promise<void> {
  for (;;) {
    const connected = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') resolve(false);
        else reject(error);
      });
    });
    if (!connected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Kill a child still running, so a failed assertion cannot leak a process. */
function ensureStopped(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

describe('jsails serve and jsails work of one app', () => {
  it(
    'run the jobs routes dispatch over a shared transport, one dispatched while the server drains',
    { skip: process.platform === 'win32' && 'graceful signals are POSIX-only' },
    async () => {
      const worker = cli(['work', '--config', 'jsails.app.js']);
      const web = cli(['serve', '--config', 'jsails.app.js']);
      try {
        await worker.line(/^Worker started \(jobs\.producer, jobs\.worker\)/m);
        const [, url] = await web.line(/^Serving at (\S+)$/m);

        const routed = await getOnce(new URL('/api/dispatch', url));
        assert.equal(routed.status, 200, routed.body);
        await worker.line(/^ran route$/m);

        const late = getOnce(new URL('/api/late', url));
        await web.line(/^handling$/m);
        web.child.kill('SIGTERM');
        await refused(new URL('/', url));
        web.child.kill('SIGUSR2');
        const answered = await late;
        assert.equal(answered.status, 200, answered.body + web.output());
        assert.equal(await web.exited, 0, web.output());
        await worker.line(/^ran late$/m);

        worker.child.kill('SIGTERM');
        assert.equal(await worker.exited, 0, worker.output());
      } finally {
        ensureStopped(web.child);
        ensureStopped(worker.child);
      }
    },
  );

  it('are each refused over the in-memory transport, which cannot reach the other', async () => {
    const [web, worker] = [
      cli(['serve', '--config', 'memory.app.js']),
      cli(['work', '--config', 'memory.app.js']),
    ];
    assert.equal(await web.exited, 1, web.output());
    assert.match(web.output(), /transport jobs is process-local, .*\(worker is elsewhere\)/);
    assert.doesNotMatch(web.output(), /Serving at/);
    assert.equal(await worker.exited, 1, worker.output());
    assert.match(worker.output(), /transport jobs is process-local, .*\(web is elsewhere\)/);
    assert.doesNotMatch(worker.output(), /Worker started/);
  });
});
