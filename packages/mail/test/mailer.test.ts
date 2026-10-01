/**
 * Message validation tests: every rejection is a value-free `MailError` with a
 * stable code, and header-injection attempts in any header field are refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MailError,
  validateMessage,
  validateMessageAddresses,
  type MailErrorCode,
} from '../src/mailer.js';

/** Match a `MailError` carrying `code` whose message echoes none of `secrets`. */
function mailError(code: MailErrorCode, ...secrets: string[]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof MailError &&
    error.code === code &&
    secrets.every((secret) => !error.message.includes(secret));
}

describe('validateMessage', () => {
  it('normalizes a valid message, leaving optional fields absent', () => {
    assert.deepEqual(validateMessage({ to: 'ada@example.com', subject: 'hello' }), {
      to: 'ada@example.com',
      from: undefined,
      subject: 'hello',
      text: undefined,
      html: undefined,
    });
  });

  it('rejects a non-object message', () => {
    assert.throws(() => validateMessage(null as never), mailError('invalid_message'));
    assert.throws(() => validateMessage([] as never), mailError('invalid_message'));
  });

  it('rejects a CR/LF in the subject (header injection)', () => {
    for (const subject of ['evil\r\nBcc: victim@example.com', 'evil\nBcc: victim@example.com']) {
      assert.throws(
        () => validateMessage({ to: 'ada@example.com', subject }),
        mailError('invalid_subject', 'victim'),
      );
    }
    assert.throws(
      () => validateMessage({ to: 'ada@example.com', subject: '  ' }),
      mailError('invalid_subject'),
    );
  });

  it('rejects an invalid recipient or sender address without echoing it', () => {
    for (const address of [
      'no-at-sign',
      'with space@example.com',
      'tab\t@example.com',
      'ada@example.com\r\nBcc: victim@example.com',
      '',
      // One recipient per field: list separators and display-name forms are refused.
      'ada@example.com,eve@example.com',
      'ada@example.com;eve@example.com',
      '"Ada"<ada@example.com>',
      'ada@example.com@eve.example',
    ]) {
      assert.throws(
        () => validateMessage({ to: address, subject: 'x' }),
        mailError('invalid_address', 'example.com'),
      );
      assert.throws(
        () => validateMessage({ to: 'ada@example.com', subject: 'x', from: address }),
        mailError('invalid_address', 'eve'),
      );
    }
  });

  it('rejects a non-string body', () => {
    assert.throws(
      () => validateMessage({ to: 'ada@example.com', subject: 'x', text: 1 as never }),
      mailError('invalid_body'),
    );
    assert.throws(
      () => validateMessage({ to: 'ada@example.com', subject: 'x', html: {} as never }),
      mailError('invalid_body'),
    );
  });

  it('accepts several recipients and structured addresses, formatted for a header', () => {
    const validated = validateMessage({
      to: ['ada@example.com', { name: 'Grace "G" H\\', address: 'grace@example.com' }],
      cc: { name: '', address: 'cc@example.com' },
      replyTo: 'support@example.com',
      from: { name: 'App', address: 'no-reply@example.com' },
      subject: 'x',
    });
    assert.equal(validated.to, 'ada@example.com, "Grace \\"G\\" H\\\\" <grace@example.com>');
    assert.equal(validated.cc, 'cc@example.com');
    assert.equal(validated.replyTo, 'support@example.com');
    assert.equal(validated.from, '"App" <no-reply@example.com>');
    assert.equal('bcc' in validated, false);
  });

  it('rejects a display name or list entry that could inject a header or recipient', () => {
    assert.throws(
      () =>
        validateMessage({
          to: { name: 'x\r\nBcc: victim@example.com', address: 'ada@example.com' },
          subject: 'x',
        }),
      mailError('invalid_address', 'victim'),
    );
    assert.throws(
      () => validateMessage({ to: ['ada@example.com', 'eve@example.com,x@y'], subject: 'x' }),
      mailError('invalid_address', 'eve'),
    );
    assert.throws(() => validateMessage({ to: [], subject: 'x' }), mailError('invalid_address'));
    assert.throws(
      () =>
        validateMessage({
          to: 'ada@example.com',
          bcc: { name: 'B', address: 'not-an-address' },
          subject: 'x',
        }),
      mailError('invalid_address', 'not-an-address'),
    );
  });

  it('caps the recipients across to, cc, and bcc', () => {
    const many = Array.from({ length: 60 }, (_, i) => `r${i}@example.com`);
    assert.throws(
      () => validateMessage({ to: many, bcc: many, subject: 'x' }),
      mailError('invalid_address'),
    );
  });

  it('validates attachments and normalizes text content to bytes', () => {
    const validated = validateMessage({
      to: 'ada@example.com',
      subject: 'x',
      attachments: [{ filename: 'a.txt', content: 'hi' }],
    });
    assert.deepEqual(validated.attachments, [
      { filename: 'a.txt', content: new TextEncoder().encode('hi'), contentType: undefined },
    ]);
    for (const attachment of [
      { filename: '../etc/passwd', content: 'x' },
      { filename: 'a\r\n.txt', content: 'x' },
      { filename: 'a.txt', content: 1 },
      { filename: 'a.txt', content: 'x', contentType: 'text/plain\r\nX-Evil: 1' },
    ]) {
      assert.throws(
        () =>
          validateMessage({
            to: 'ada@example.com',
            subject: 'x',
            attachments: [attachment as never],
          }),
        mailError('invalid_attachment', 'Evil'),
      );
    }
  });
});

describe('validateMessageAddresses', () => {
  it('returns structured entries without parsing a display name out of text', () => {
    const addresses = validateMessageAddresses({
      from: { name: 'App, <x@evil.test>', address: 'no-reply@example.com' },
      to: ['ada@example.com', { name: '  ', address: 'grace@example.com' }],
      bcc: { name: 'B', address: 'b@example.com' },
      subject: 'hi',
    });
    assert.deepEqual(addresses, {
      from: { name: 'App, <x@evil.test>', address: 'no-reply@example.com' },
      to: [
        { name: '', address: 'ada@example.com' },
        { name: '', address: 'grace@example.com' },
      ],
      cc: [],
      bcc: [{ name: 'B', address: 'b@example.com' }],
      replyTo: [],
    });
  });

  it('applies the same address rules as validateMessage', () => {
    assert.throws(
      () => validateMessageAddresses({ to: 'Eve <eve@evil.test>', subject: 'hi' }),
      mailError('invalid_address', 'eve@evil.test'),
    );
  });
});
