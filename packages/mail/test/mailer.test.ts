/**
 * Message validation tests: every rejection is a value-free `MailError` with a
 * stable code, and header-injection attempts in any header field are refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MailError, validateMessage, type MailErrorCode } from '../src/mailer.js';

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
});
