/**
 * Audit regressions for mail (CNT-01): each test states the correct behaviour
 * for one audited defect. Those that fail today are listed, with the failure
 * they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditCase } from 'jsails/testing';

import { assertMailAddress, MailError, validateMessage } from '../src/mailer.js';
import { InMemoryMailTransport } from '../src/transports.js';

test(...auditCase('mail/address-shape', 'an address needs a local part and a domain'), () => {
  for (const value of ['@', 'ada@', '@example.com']) {
    assert.throws(
      () => assertMailAddress(value, 'to'),
      MailError,
      `"${value}" was accepted as an email address`,
    );
  }
});

test(...auditCase('mail/body-required', 'a message with neither text nor html is refused'), () => {
  assert.throws(
    () => validateMessage({ to: 'ada@example.com', subject: 'Hello' }),
    MailError,
    'a message with no body was accepted',
  );
});

test(
  ...auditCase('mail/memory-transport-bounded', 'the in-memory transport keeps a bounded capture'),
  async () => {
    const transport = new InMemoryMailTransport();
    const sent = 20_000;
    for (let index = 0; index < sent; index += 1) {
      await transport.send({ to: 'ada@example.com', subject: 'Hello', text: 'body' });
    }
    assert.ok(
      transport.messages().length < sent,
      `all ${sent} messages are held: the capture grows without bound`,
    );
  },
);
