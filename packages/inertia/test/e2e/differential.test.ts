/**
 * The differential that certifies `preact/compat`: a scenario runs once on
 * React 19 and react-dom 19 (the reference) and once on `preact/compat`, its
 * own assertions hold on both, and the two runs must leave identical page
 * snapshots, request logs, and client events. The default suite runs the
 * smoke rows; `JSAILS_INERTIA_FULL_DIFFERENTIAL=1` runs every row, the gate
 * for a bump of the pinned client.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CERTIFIED_CLIENT, type ClientFlavor } from './module-graph.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { openSession, type SessionRecord } from './session.js';

const FULL = process.env.JSAILS_INERTIA_FULL_DIFFERENTIAL === '1';

async function observe(flavor: ClientFlavor, scenario: Scenario): Promise<SessionRecord> {
  const session = await openSession(flavor);
  try {
    await scenario.run(session);
    await session.settle();
    return session.record();
  } finally {
    await session.close();
  }
}

describe(`preact/compat against React ${CERTIFIED_CLIENT.react}`, () => {
  for (const scenario of SCENARIOS.filter((row) => FULL || row.smoke)) {
    it(scenario.name, async () => {
      const reference = await observe('react', scenario);
      const subject = await observe('preact', scenario);
      assert.deepEqual(subject, reference);
    });
  }
});
