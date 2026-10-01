/**
 * The generated deny matrix (`lane-matrix.ts`) over a gate written in TSX,
 * and the lane boundary's other guarantees: the slot a timed-out handler
 * keeps until it settles (on a fake clock), the credential envelope of every
 * kind, and the type fixture that a plain function is not a mountable
 * `ComponentRoute`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { h } from 'preact';
import { z } from 'zod';

import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import type {
  ComponentRoute,
  Credential,
  CredentialEnvelope,
  LaneCredentialKind,
} from '../../src/server-components/runtime/index.js';
import {
  authorizeEntered,
  describeLaneMatrix,
  makeLaneFixture,
  sendLane,
  type GateFactory,
} from './lane-matrix.js';

/** The matrix's gate, in TSX. */
const tsxGate: GateFactory = (hooks) =>
  defineServerComponent<{ count: number }>({
    name: 'gate',
    stateSchema: z.object({ count: z.number() }).strict(),
    initialState: () => ({ count: 0 }),
    authorize: (context) => hooks.authorize(context),
    uploads: {
      contentTypes: ['image/png'],
      anonymous: { maxBytes: 1024 * 1024, maxFiles: 100, maxConcurrent: 16 },
    },
    actions: {
      ping: defineAction({
        run(state) {
          hooks.ran();
          state.count += 1;
        },
      }),
    },
    render: (state) => h('span', null, String(state.count)),
  });

describeLaneMatrix('component lane deny matrix', tsxGate);

// ---------------------------------------------------------------------------
// The slot a timed-out handler keeps
// ---------------------------------------------------------------------------

describe('component lane deadline', () => {
  it('answers timeout at the deadline but keeps the slot until the handler settles', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const fixture = makeLaneFixture(tsxGate, {
      lane: 'update',
      limits: { maxConcurrent: 1, totalMs: 1000 },
    });
    fixture.policy = 'hang';

    const first = sendLane(fixture, 'update', {});
    await authorizeEntered(fixture);
    t.mock.timers.tick(1000);
    const timedOut = await first;
    assert.equal(timedOut.status, 503);
    assert.equal(timedOut.code, 'timeout');

    // The authorize that ignored the abort is still running, so its slot is held.
    fixture.policy = 'scoped';
    const refused = await sendLane(fixture, 'update', {});
    assert.equal(refused.code, 'unavailable');

    fixture.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.actionRuns, 0, 'an authorize past the deadline never starts the action');
    const admitted = await sendLane(fixture, 'update', {});
    assert.equal(admitted.status, 200, admitted.raw);
    assert.equal(fixture.actionRuns, 1);
  });
});

// ---------------------------------------------------------------------------
// Only componentRoute builds a mountable route
// ---------------------------------------------------------------------------

describe('Credential', () => {
  it('carries the whole envelope for every kind', () => {
    // Fails to compile when a credential kind drops an envelope claim.
    const kinds: {
      readonly [K in LaneCredentialKind]: (credential: Credential<K>) => CredentialEnvelope;
    } = { snapshot: (credential) => credential, 'download-ref': (credential) => credential };
    assert.deepEqual(Object.keys(kinds), ['snapshot', 'download-ref']);
  });
});

describe('ComponentRoute', () => {
  it('is not satisfied by a plain handler function', () => {
    // @ts-expect-error a hand-written handler skips the lane boundary, so it is not a ComponentRoute
    const route: ComponentRoute = async () => new Response(null);
    assert.equal(typeof route, 'function');
  });
});
