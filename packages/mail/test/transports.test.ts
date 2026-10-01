/**
 * Transport tests for the in-memory, callback, and SMTP transports.
 *
 * The SMTP transport runs against an injected transporter factory, so no live
 * SMTP server, nodemailer connection, or network is ever opened. Covered: each
 * transport validates and delivers, laziness (no transporter until the first
 * send), sanitized send failures, and idempotent close.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CallbackMailTransport,
  InMemoryMailTransport,
  MailError,
  SmtpMailTransport,
  type SmtpTransportDependencies,
  type SmtpTransporter,
} from '../src/index.js';

const MESSAGE = {
  to: 'ada@example.com',
  subject: 'hello',
  text: 'plain body',
  html: '<p>html body</p>',
};

describe('InMemoryMailTransport', () => {
  it('validates and captures each message', async () => {
    const transport = new InMemoryMailTransport();
    await transport.send(MESSAGE);
    await transport.send({ to: 'grace@example.com', subject: 'again', text: 'second' });

    const messages = transport.messages();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      to: 'ada@example.com',
      from: undefined,
      subject: 'hello',
      text: 'plain body',
      html: '<p>html body</p>',
    });
    assert.deepEqual(messages[1], {
      to: 'grace@example.com',
      from: undefined,
      subject: 'again',
      text: 'second',
      html: undefined,
    });

    await transport.close();
  });

  it('captures nothing from a rejected message', async () => {
    const transport = new InMemoryMailTransport();
    await assert.rejects(
      transport.send({ to: 'ada@example.com', subject: 'evil\r\nBcc: victim@example.com' }),
      MailError,
    );
    assert.equal(transport.messages().length, 0);
    await transport.close();
  });

  it('rejects sending after close and closes idempotently', async () => {
    const transport = new InMemoryMailTransport();
    await transport.send(MESSAGE);
    await transport.close();
    await transport.close();
    assert.equal(transport.messages().length, 0, 'close drops captured messages');
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) => error instanceof MailError && error.code === 'closed',
    );
  });
});

describe('CallbackMailTransport', () => {
  it('forwards each validated message to the callback and closes idempotently', async () => {
    const received: string[] = [];
    const transport = new CallbackMailTransport((message) => {
      received.push(message.to);
    });
    await transport.send(MESSAGE);
    await transport.send({ to: 'grace@example.com', subject: 'again' });
    assert.deepEqual(received, ['ada@example.com', 'grace@example.com']);

    await transport.close();
    await transport.close();
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) => error instanceof MailError && error.code === 'closed',
    );
  });

  it('rejects a non-function callback at construction', () => {
    assert.throws(() => new CallbackMailTransport(undefined as never), TypeError);
  });
});

describe('SmtpMailTransport', () => {
  it('rejects a missing url and host at construction', () => {
    assert.throws(
      () => new SmtpMailTransport({}),
      (error: unknown) => error instanceof MailError && error.code === 'missing_smtp_connection',
    );
  });

  it('rejects a non-SMTP URL scheme at construction without echoing it', () => {
    assert.throws(
      () => new SmtpMailTransport({ url: 'http://user:secret@example.com' }),
      (error: unknown) =>
        error instanceof MailError &&
        error.code === 'invalid_smtp_url' &&
        !error.message.includes('secret'),
    );
  });

  it('rejects an invalid default from address at construction', () => {
    assert.throws(
      () => new SmtpMailTransport({ host: 'smtp.example.com', from: 'not-an-address' }),
      (error: unknown) => error instanceof MailError && error.code === 'invalid_address',
    );
  });

  it('constructs no transporter until the first send (lazy)', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    assert.equal(state.creates, 0, 'construction loads no nodemailer');

    await transport.send(MESSAGE);
    assert.equal(state.creates, 1);

    await transport.send({ to: 'grace@example.com', subject: 'again' });
    assert.equal(state.creates, 1, 'the transporter is reused');
    await transport.close();
  });

  it('shares one transporter between concurrent first sends', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await Promise.all([transport.send(MESSAGE), transport.send(MESSAGE)]);
    assert.equal(state.creates, 1);
    await transport.close();
  });

  it('retries the transporter after a failed construction', async () => {
    const { dependencies, state } = fakeSmtpDependencies({ failCreateOnce: true });
    const transport = new SmtpMailTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) => error instanceof MailError && error.code === 'transport_failed',
    );
    await transport.send(MESSAGE);
    assert.equal(state.creates, 2);
    await transport.close();
  });

  it('applies the configured from default when the message omits it', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport(
      { url: 'smtp://smtp.example.com', from: 'noreply@example.com' },
      dependencies,
    );
    await transport.send({ to: 'ada@example.com', subject: 'hi', text: 'x' });
    assert.equal(state.sent[0]?.from, 'noreply@example.com');

    await transport.send({
      to: 'ada@example.com',
      subject: 'hi',
      text: 'x',
      from: 'me@example.com',
    });
    assert.equal(state.sent[1]?.from, 'me@example.com', 'a message from overrides the default');
    await transport.close();
  });

  it('sanitizes a send failure into a value-free MailError', async () => {
    const { dependencies } = fakeSmtpDependencies({ failSendWith: { code: 'EAUTH' } });
    const transport = new SmtpMailTransport(
      { url: 'smtps://user:pass@smtp.example.com' },
      dependencies,
    );
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) =>
        error instanceof MailError &&
        error.code === 'transport_failed' &&
        error.message === 'mail transport error (EAUTH)',
    );
    await transport.close();
  });

  it('closes the underlying transporter exactly once', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await transport.send(MESSAGE);
    await Promise.all([transport.close(), transport.close()]);
    await transport.close();
    assert.equal(state.closes, 1);
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) => error instanceof MailError && error.code === 'closed',
    );
  });

  it('close is a no-op when no transporter was ever created', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await transport.close();
    assert.equal(state.creates, 0);
    assert.equal(state.closes, 0);
  });
});

/** What the fake SMTP factory seam records. */
interface FakeSmtpState {
  creates: number;
  closes: number;
  sent: Array<{ from?: string; to: string; subject: string }>;
}

/** An SMTP factory seam that records creates/sends/closes and can fail either. */
function fakeSmtpDependencies(options?: {
  failSendWith?: { code: string };
  failCreateOnce?: boolean;
}): {
  dependencies: SmtpTransportDependencies;
  state: FakeSmtpState;
} {
  const state: FakeSmtpState = { creates: 0, closes: 0, sent: [] };
  const dependencies: SmtpTransportDependencies = {
    createTransport() {
      state.creates += 1;
      if (options?.failCreateOnce === true && state.creates === 1) {
        throw new Error('backend unreachable at smtp.example.com');
      }
      const transporter: SmtpTransporter = {
        async sendMail(mail) {
          if (options?.failSendWith !== undefined) {
            const error = new Error('backend auth failed') as Error & { code: string };
            error.code = options.failSendWith.code;
            throw error;
          }
          state.sent.push({ from: mail.from, to: mail.to, subject: mail.subject });
        },
        close() {
          state.closes += 1;
        },
      };
      return transporter;
    },
  };
  return { dependencies, state };
}
