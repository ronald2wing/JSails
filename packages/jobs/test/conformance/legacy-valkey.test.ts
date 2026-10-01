/**
 * The conformance suite against today's `jsails/jobs` runtime over the
 * built-in BullMQ adapter and a real Valkey.
 *
 * Opt-in: it runs only when `JSAILS_TEST_VALKEY` is `"1"` and `VALKEY_URL` is
 * set (the convention of `packages/live`'s live test); otherwise one skipped
 * test says so and nothing connects. The scenarios it fails are listed in
 * `scripts/expected-failures/jobs.json` with `"services": ["valkey"]`, so they
 * apply only to a run that declares the service (`JSAILS_TEST_SERVICES`); the
 * jobs stage of `npm run verify:integrations` runs this package through
 * `scripts/run-tests.mjs` that way. Every scenario uses its own queue
 * prefix, so a shared server is not disturbed. Completed jobs are removed at
 * once (`removeOnComplete: true`), which is what `evictCompleted` stands for.
 * Scenarios that need virtual time are not registered: BullMQ runs on the
 * server's clock.
 */

import { describe, test } from 'node:test';

import { BullMQAdapter } from 'jsails/jobs';
import { createValkeyConnections } from 'jsails/plugin-sdk';

import { conformancePlan, suiteName, type DriverFactory } from '../../src/testing/index.js';
import { createLegacyDriver } from './legacy-driver.js';

const url = process.env.VALKEY_URL?.trim() ?? '';
const gated = process.env.JSAILS_TEST_VALKEY === '1' && url !== '';

let sequence = 0;

const legacyValkey: DriverFactory = (options) => {
  sequence += 1;
  const connections = createValkeyConnections(url, {
    appPrefix: `jsails-conformance-${process.pid}`,
    name: 'conformance',
  });
  return createLegacyDriver(
    {
      adapter: new BullMQAdapter({
        connections,
        removeOnComplete: true,
        // Transport errors surface as scenario failures; the adapter's log line would only add noise.
        onError: () => undefined,
      }),
      queueName: 'default',
      prefix: `jsails-conformance-${process.pid}-${Date.now()}-${sequence}`,
      close: () => connections.close(),
    },
    options,
  );
};

if (gated) {
  describe(suiteName('legacy-valkey'), () => {
    for (const group of conformancePlan(legacyValkey, { virtualTime: false })) {
      describe(group.name, () => {
        for (const entry of group.tests) test(entry.name, () => entry.run());
      });
    }
  });
} else {
  test('legacy-valkey conformance', { skip: 'set JSAILS_TEST_VALKEY=1 and VALKEY_URL' }, () => {});
}
