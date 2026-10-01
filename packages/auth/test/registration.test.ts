/**
 * Tests for self-registration: `handleRegister` validates the form, applies the rate-limit hook, delegates to Better Auth's
 * `signUpEmail`, and collapses every failure to a value-free 422.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleRegister } from '../src/index.js';
import { fakeAuth, formRequest, ORIGIN } from './fixtures.js';

const FIELDS = { name: 'Ada', email: 'ada@example.com', password: 'pw12345678' };

describe('handleRegister', () => {
  const auth = fakeAuth({ signUpEmail: async () => ({ token: null, user: {} }) });

  it('rejects a malformed email or missing password with 422', async () => {
    const badEmail = await handleRegister(
      formRequest('/api/register', { ...FIELDS, email: 'not-an-email' }),
      { auth },
    );
    assert.equal(badEmail.status, 422);
    assert.deepEqual(await badEmail.json(), {
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: 'name, email, and password are required',
      code: 'invalid_form',
    });

    const badPassword = await handleRegister(
      formRequest('/api/register', { ...FIELDS, password: '' }),
      { auth },
    );
    assert.equal(badPassword.status, 422);
  });

  it('rejects a body that is not a form with 400', async () => {
    const request = new Request(`${ORIGIN}/api/register`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    });
    const response = await handleRegister(request, { auth });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_body');
  });

  it('applies the rate-limit hook and returns a generic 429', async () => {
    const response = await handleRegister(formRequest('/api/register', FIELDS), {
      auth,
      rateLimit: () => false,
    });
    assert.equal(response.status, 429);
  });

  it('delegates to signUpEmail and returns an opaque 200 on success', async () => {
    let received: unknown;
    const recording = fakeAuth({
      signUpEmail: async (input: unknown) => ((received = input), { token: null, user: {} }),
    });

    const response = await handleRegister(formRequest('/api/register', FIELDS), {
      auth: recording,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: FIELDS });
  });

  it('collapses a provider failure into a generic 422', async () => {
    const failing = fakeAuth({
      signUpEmail: async () => {
        throw new Error('boom');
      },
    });
    const response = await handleRegister(formRequest('/api/register', FIELDS), {
      auth: failing,
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: 'registration failed',
      code: 'registration_failed',
    });
  });
});
