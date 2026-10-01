/**
 * Tests for password reset and email verification: the mail-sender factories
 * forward the recipient and URL to the `SendMailFn` seam, and the three
 * handlers validate, rate-limit, delegate to Better Auth, and answer every
 * failure in the value-free error envelope.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createResetPasswordSender,
  createVerificationSender,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  type SendMailFn,
} from '../src/index.js';
import { fakeAuth, formRequest, ORIGIN } from './fixtures.js';

describe('mail sender factories', () => {
  it('createResetPasswordSender forwards the recipient and reset URL to sendMail', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const sendMail: SendMailFn = async (to, subject, text) => {
      sent.push({ to, subject, text });
    };
    const sender = createResetPasswordSender(sendMail);

    await sender({
      user: { email: 'ada@example.com' },
      url: 'https://example.com/reset?token=abc',
      token: 'abc',
    });

    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.to, 'ada@example.com');
    assert.equal(first.subject, 'Reset your password');
    assert.match(first.text, /https:\/\/example\.com\/reset\?token=abc/);
  });

  it('createVerificationSender forwards the recipient and verify URL to sendMail', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const sendMail: SendMailFn = async (to, _subject, text) => {
      sent.push({ to, text });
    };
    const sender = createVerificationSender(sendMail);

    await sender({
      user: { email: 'ada@example.com' },
      url: 'https://example.com/verify-email?token=xyz',
      token: 'xyz',
    });

    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.to, 'ada@example.com');
    assert.match(first.text, /verify-email\?token=xyz/);
  });
});

describe('handleRequestPasswordReset', () => {
  const auth = fakeAuth({ requestPasswordReset: async () => ({ status: true, message: 'sent' }) });

  it('rejects a malformed email with 400', async () => {
    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'nope' }),
      { auth, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { status: 400, code: 'invalid_email', message: 'a valid email address is required' },
    });
  });

  it('applies the rate-limit hook and returns a generic 429', async () => {
    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'ada@example.com' }),
      { auth, publicOrigin: ORIGIN, rateLimit: () => false },
    );
    assert.equal(response.status, 429);
  });

  it('delegates and returns an opaque 200 on success', async () => {
    let received: unknown;
    const recording = fakeAuth({
      requestPasswordReset: async (input: unknown) => ((received = input), { status: true }),
    });

    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'ada@example.com' }),
      { auth: recording, publicOrigin: ORIGIN },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { email: 'ada@example.com' } });
  });

  it('maps a provider failure to a generic 500', async () => {
    const failing = fakeAuth({
      requestPasswordReset: async () => {
        throw new Error('boom');
      },
    });
    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'ada@example.com' }),
      { auth: failing, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: {
        status: 500,
        code: 'internal_error',
        message: 'the password reset could not be requested',
      },
    });
  });
});

describe('handleResetPassword', () => {
  it('rejects a missing token with 422', async () => {
    const auth = fakeAuth({ resetPassword: async () => ({ status: true }) });
    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { newPassword: 'pw12345678' }),
      { auth, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'invalid_form');
  });

  it('delegates the token and new password and returns 200', async () => {
    let received: unknown;
    const auth = fakeAuth({
      resetPassword: async (input: unknown) => ((received = input), { status: true }),
    });

    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { token: 'tok-1', newPassword: 'pw12345678' }),
      { auth, publicOrigin: ORIGIN },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { newPassword: 'pw12345678', token: 'tok-1' } });
  });

  it('maps an invalid/expired token to a generic 422', async () => {
    const auth = fakeAuth({
      resetPassword: async () => {
        throw new Error('invalid');
      },
    });
    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { token: 'tok-1', newPassword: 'pw12345678' }),
      { auth, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: { status: 422, code: 'invalid_token', message: 'invalid or expired token' },
    });
  });
});

describe('handleSendVerificationEmail', () => {
  it('rejects a malformed email with 400', async () => {
    const auth = fakeAuth({ sendVerificationEmail: async () => ({ status: true }) });
    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'nope' }),
      { auth, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 400);
  });

  it('delegates and returns an opaque 200 on success', async () => {
    let received: unknown;
    const auth = fakeAuth({
      sendVerificationEmail: async (input: unknown) => ((received = input), { status: true }),
    });

    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'ada@example.com' }),
      { auth, publicOrigin: ORIGIN },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { email: 'ada@example.com' } });
  });

  it('maps a provider failure to a generic 400', async () => {
    const auth = fakeAuth({
      sendVerificationEmail: async () => {
        throw new Error('boom');
      },
    });
    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'ada@example.com' }),
      { auth, publicOrigin: ORIGIN },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        status: 400,
        code: 'verification_failed',
        message: 'the verification email could not be sent',
      },
    });
  });
});
