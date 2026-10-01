/**
 * The generated deny matrix of the component lanes (`lane-matrix.ts`) over a
 * gate compiled from a `.jsails` live component (`fixtures/live/components/
 * gate.jsails`, sfc-plan SFC-05 exit): the compiled definition holds every
 * lane boundary its TSX twin holds. Each fixture installs its policy hooks in
 * the gate's `shared/gate.ts` before the runtime serves the compiled module.
 */

import { after } from 'node:test';

import type { ServerComponentDefinition } from '../../../src/server-components/component.js';
import { describeLaneMatrix, type GateHooks } from '../../server-components/lane-matrix.js';
import { compileFixtureApp } from './compiled-fixture.js';
import { LIVE_APP, LIVE_RESOLVER } from './live-corpus.js';

const fixture = compileFixtureApp(LIVE_APP, { resolver: LIVE_RESOLVER });
after(() => fixture.dispose());

const policy = (await fixture.load('shared/gate.ts')) as { useGate(hooks: GateHooks): void };
const gate = (await fixture.load('components/gate.jsails'))
  .default as ServerComponentDefinition<any>;

describeLaneMatrix('compiled live component lane deny matrix', (hooks) => {
  policy.useGate(hooks);
  return gate;
});
