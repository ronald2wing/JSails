/**
 * Tests for reconcile: the live and previous releases an observed host has,
 * the proxy taken as the truth, and the state repair each disagreement needs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeJamalConfig } from '../../src/config/index.js';
import { sha256Hex } from '../../src/production/remote-file.js';
import { reconcile, type Reconciled } from '../../src/production/reconcile.js';
import { observation, release, stateOf, stateSha, type HostSpec } from './host-observation.js';

const CONFIG = normalizeJamalConfig({
  service: 'myapp',
  image: 'ghcr.io/acme/myapp',
  production: { server: '203.0.113.7', domain: 'example.com' },
});

/** The SHA-256 the fixture gives an unreadable `state.json`. */
const UNREADABLE = sha256Hex(Buffer.from('{"v":0}\n'));

interface Row {
  readonly name: string;
  readonly host: HostSpec;
  /** Live and previous release numbers, and the repair, when one is due. */
  readonly live: number | null;
  readonly previous: number | null;
  readonly repair?: Reconciled['repair'];
}

const ROWS: readonly Row[] = [
  { name: 'an empty host', host: { serving: null }, live: null, previous: null },
  {
    name: 'a host whose record agrees with the proxy',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2], serving: 2 },
    live: 2,
    previous: 1,
  },
  {
    name: 'a run killed between the switch and the state write',
    host: { releases: [1, [2, 1]], state: stateOf(1), containers: [1, 2], serving: 2 },
    live: 2,
    previous: 1,
    repair: { reason: 'live-mismatch', expect: stateSha(stateOf(1)) },
  },
  {
    name: 'a first run killed between the switch and the state write',
    host: { releases: [1], containers: [1], serving: 1 },
    live: 1,
    previous: null,
    repair: { reason: 'missing', expect: 'absent' },
  },
  {
    name: 'a lost record: the live manifest says what it was deployed over',
    host: { releases: [1, [2, 1]], containers: [2], serving: 2 },
    live: 2,
    previous: 1,
    repair: { reason: 'missing', expect: 'absent' },
  },
  {
    name: 'a damaged record, replaced by the bytes observed',
    host: { releases: [1, [2, 1]], state: 'unreadable', containers: [2], serving: 2 },
    live: 2,
    previous: 1,
    repair: { reason: 'unreadable', expect: UNREADABLE },
  },
  {
    name: 'a dead release: the proxy serves nothing',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), serving: null },
    live: null,
    previous: 2,
    repair: { reason: 'route-missing', expect: stateSha(stateOf(2, 1)) },
  },
  {
    name: 'a proxy that serves a container of no release',
    host: { releases: [1], state: stateOf(1), containers: [1], serving: 'intruder' },
    live: null,
    previous: 1,
    repair: { reason: 'route-unknown', expect: stateSha(stateOf(1)) },
  },
  {
    name: 'a proxy that serves a container whose manifest is gone',
    host: { releases: [1], state: stateOf(1), containers: [1, 3], serving: 3 },
    live: null,
    previous: 1,
    repair: { reason: 'route-unknown', expect: stateSha(stateOf(1)) },
  },
  {
    name: 'a previous release whose manifest is gone',
    host: { releases: [2], state: stateOf(2, 1), containers: [2], serving: 2 },
    live: 2,
    previous: null,
    repair: { reason: 'previous-missing', expect: stateSha(stateOf(2, 1)) },
  },
  {
    name: 'an unrouted app keeps the live release its record names',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2] },
    live: 2,
    previous: 1,
  },
  {
    name: 'an unrouted app whose live manifest is gone',
    host: { releases: [1], state: stateOf(2, 1), containers: [1] },
    live: null,
    previous: null,
    repair: { reason: 'live-mismatch', expect: stateSha(stateOf(2, 1)) },
  },
  {
    name: 'a stopped kamal-proxy leaves the live release the record names',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2], proxy: 'stopped' },
    live: 2,
    previous: 1,
  },
  {
    name: 'a missing kamal-proxy leaves the live release the record names',
    host: { releases: [1, [2, 1]], state: stateOf(2, 1), containers: [2], proxy: 'missing' },
    live: 2,
    previous: 1,
  },
  {
    name: 'a stopped kamal-proxy and a record whose live manifest is gone',
    host: { releases: [1], state: stateOf(2, 1), containers: [1], proxy: 'stopped' },
    live: null,
    previous: null,
    repair: { reason: 'live-mismatch', expect: stateSha(stateOf(2, 1)) },
  },
  {
    name: 'an unrouted host with releases but no record and nothing live',
    host: { releases: [1, 2] },
    live: null,
    previous: null,
  },
];

describe('reconcile', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      // A host spec without `serving` is an app jamal does not route.
      const result = reconcile(observation(CONFIG, row.host));
      assert.deepEqual(result, {
        live: row.live === null ? null : release(row.live),
        previous: row.previous === null ? null : release(row.previous),
        repair: row.repair,
      });
    });
  }

  it('a repaired record reconciles with nothing left to repair', () => {
    for (const row of ROWS.filter((candidate) => candidate.repair !== undefined)) {
      const result = reconcile(observation(CONFIG, row.host));
      const repaired = observation(CONFIG, {
        ...row.host,
        state: {
          ...stateOf(null),
          live: result.live,
          previous: result.previous,
        },
      });
      assert.equal(reconcile(repaired).repair, undefined, row.name);
    }
  });
});
