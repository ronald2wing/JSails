/**
 * `openCarrier`: the flash, bag-shaped errors, and `clearHistory` a response
 * carries to the next request; `null` for no carrier, a deleted one, a
 * foreign key, or an expired one; both cookie names. Also checks that the
 * `./testing` subpath resolves through the package exports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inertiaRedirect,
  outcomeToResponse,
  requestFacts,
  resolveInertia,
  validationFailure,
  webCryptoSealer,
} from '../../src/index.js';
import { inertiaRequest, openCarrier } from '../../src/testing/index.js';
import { engine, TestClock, TEST_SEALER } from '../protocol/engine-fixture.js';

const ISSUES = [{ path: ['name'], message: 'Name is required', code: 'required' }];

describe('openCarrier', () => {
  it('opens the flash and clearHistory a redirect carries', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const facts = requestFacts(inertiaRequest('/logout', { method: 'POST', version: 'v1' }));
    const response = outcomeToResponse(
      await inertiaRedirect(config, facts, '/', { flash: { message: 'Bye' }, clearHistory: true }),
    );
    assert.deepEqual(await openCarrier(response, TEST_SEALER, { now: clock.current }), {
      flash: { message: 'Bye' },
      clearHistory: true,
    });
  });

  it('opens validation errors already shaped for the error bag', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const request = inertiaRequest('/users', {
      method: 'POST',
      version: 'v1',
      errorBag: 'createUser',
      headers: { Referer: 'http://localhost/users/create' },
    });
    const outcome = await validationFailure(config, requestFacts(request), ISSUES);
    assert.ok(outcome !== null);
    const carried = await openCarrier(outcomeToResponse(outcome), TEST_SEALER, {
      now: clock.current,
    });
    assert.deepEqual(carried, { errors: { createUser: { name: 'Name is required' } } });
  });

  it('reads the __Host- cookie of an https app', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const facts = requestFacts(
      inertiaRequest('https://app.test/save', { method: 'POST', version: 'v1' }),
    );
    const response = outcomeToResponse(
      await inertiaRedirect(config, facts, '/', { flash: { saved: true } }),
    );
    assert.match(response.headers.getSetCookie()[0] ?? '', /^__Host-jsails-inertia-carrier=/u);
    assert.deepEqual(await openCarrier(response, TEST_SEALER, { now: clock.current }), {
      flash: { saved: true },
    });
  });

  it('returns null for no carrier, a deleted carrier, another key, and an expired one', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const save = requestFacts(inertiaRequest('/save', { method: 'POST', version: 'v1' }));
    const carrying = outcomeToResponse(
      await inertiaRedirect(config, save, '/', { flash: { message: 'Saved' } }),
    );
    const cookie = (carrying.headers.getSetCookie()[0] ?? '').split(';', 1)[0] ?? '';
    const consumed = outcomeToResponse(
      await resolveInertia(
        config,
        requestFacts(new Request('http://localhost/', { headers: { Cookie: cookie } })),
        { component: 'Home', props: {} },
      ),
    );
    assert.match(consumed.headers.getSetCookie()[0] ?? '', /Max-Age=0/u);
    assert.equal(await openCarrier(consumed, TEST_SEALER, { now: clock.current }), null);
    assert.equal(await openCarrier(new Response(null), TEST_SEALER), null);
    const foreign = webCryptoSealer(new Uint8Array(32).fill(9));
    assert.equal(await openCarrier(carrying, foreign, { now: clock.current }), null);
    assert.equal(await openCarrier(carrying, TEST_SEALER, { now: clock.current + 61_000 }), null);
    const other = new Response(null, { headers: { 'Set-Cookie': 'session=abc; Path=/' } });
    assert.equal(await openCarrier(other, TEST_SEALER), null);
  });
});

describe('@jsails/inertia/testing', () => {
  it('is exported through the package exports', async () => {
    const testing = await import('@jsails/inertia/testing');
    assert.equal(typeof testing.inertiaRequest, 'function');
    assert.equal(typeof testing.readInertiaPage, 'function');
    assert.equal(typeof testing.openCarrier, 'function');
  });
});
