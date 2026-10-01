/**
 * Audit regressions for live (CNT-01): each test states the correct behaviour
 * for one audited defect. Those that fail today are listed, with the failure
 * they show, in `scripts/expected-failures/content.json`.
 *
 * The Valkey timeout probe runs in a child process: a client with no timeout
 * against a silent peer reconnects forever, and that loop must not outlive the
 * probe inside the test process.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { auditCase, blackholeServer, waitFor } from 'jsails/testing';
import { DEFAULT_VALKEY_TIMEOUTS } from 'jsails/plugin-sdk';

import type { LiveService } from '../src/live-service.js';
import { openClient, startLive, stopLive, subscribe, WAIT_MS } from './fixtures.js';

test(
  ...auditCase(
    'live/resnapshot-single-flight',
    'oversized changes re-snapshot a subscription one at a time',
  ),
  async () => {
    let active = 0;
    let peak = 0;
    let resnapshots = 0;
    let subscribed = false;
    const running = await startLive({
      table: 'audit_live_resnapshot',
      socket: { maxChangeBytes: 64 },
      wrapService: (service): LiveService => ({
        ...service,
        async subscribe(request, sink) {
          if (subscribed) {
            resnapshots += 1;
          }
          active += 1;
          peak = Math.max(peak, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return await service.subscribe(request, sink);
          } finally {
            active -= 1;
          }
        },
      }),
    });
    const client = await openClient(running.port);
    try {
      const ack = await subscribe(client.socket, 'live.items');
      assert.equal(ack.ok, true);
      subscribed = true;
      peak = 0;
      // Concurrent writes land in one flush window, so their oversized
      // changes reach the subscription back to back.
      await Promise.all(
        [0, 1, 2, 3].map((index) =>
          running.Item.create({ name: `oversized-${index}-${'x'.repeat(80)}` }).save(),
        ),
      );
      await waitFor(() => resnapshots >= 1 && active === 0, {
        timeoutMs: WAIT_MS,
        label: 'the re-snapshots',
      });
      assert.equal(peak, 1, `${peak} snapshot queries ran at once for one subscription`);
    } finally {
      client.socket.disconnect();
      await stopLive(running);
    }
  },
);

/**
 * The window the change log has to fail in: the provider's default connect
 * deadline, plus a margin for a loaded test run.
 */
const PROBE_WINDOW_MS = DEFAULT_VALKEY_TIMEOUTS.connectMs + 2000;

/** Run `createValkeyChangeLog` against `url` in a child; report how it ended within the window. */
function probeChangeLog(url: string): Promise<string> {
  const moduleUrl = new URL('../src/valkey-change-log.js', import.meta.url).href;
  const sdkUrl = import.meta.resolve('jsails/plugin-sdk');
  const script = `
    const { createValkeyChangeLog } = await import(${JSON.stringify(moduleUrl)});
    const { createValkeyConnections } = await import(${JSON.stringify(sdkUrl)});
    setTimeout(() => { process.stdout.write('pending'); process.exit(0); }, ${PROBE_WINDOW_MS});
    const connections = createValkeyConnections(${JSON.stringify(url)}, {
      appPrefix: 'app:test',
      name: 'audit',
    });
    try {
      await createValkeyChangeLog({ connections });
      process.stdout.write('resolved');
    } catch {
      process.stdout.write('rejected');
    }
    process.exit(0);
  `;
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_OPTIONS'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
}

test(
  ...auditCase(
    'live/valkey-command-timeout',
    'the Valkey change log fails within a bounded time against a silent server',
  ),
  async (t) => {
    const blackhole = await blackholeServer();
    t.after(() => blackhole.close());
    const outcome = await probeChangeLog(blackhole.url('redis'));
    assert.equal(
      outcome,
      'rejected',
      `starting the change log against a silent Valkey ended as "${outcome}"`,
    );
  },
);
