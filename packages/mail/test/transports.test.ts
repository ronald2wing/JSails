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
  SMTP_DEFAULTS,
  SmtpMailTransport,
  type SmtpConnectionConfig,
  type SmtpMailOptions,
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

  it('pools connections with bounded timeouts by default (host options)', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport({ host: 'smtp.example.com', port: 587 }, dependencies);
    await transport.send(MESSAGE);
    assert.deepEqual(state.configs[0], {
      host: 'smtp.example.com',
      port: 587,
      secure: undefined,
      requireTLS: true,
      auth: undefined,
      pool: true,
      maxConnections: 5,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    assert.equal(SMTP_DEFAULTS.socketTimeoutMs, 30_000);
    await transport.close();
  });

  it('carries the tuning as URL parameters, keeping ones the URL sets', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport(
      { url: 'smtps://user:pass@smtp.example.com:465?pool=false', socketTimeoutMs: 5000 },
      dependencies,
    );
    await transport.send(MESSAGE);
    const config = state.configs[0];
    assert.equal(typeof config, 'string');
    const url = new URL(config as string);
    assert.equal(url.username, 'user');
    assert.equal(url.searchParams.get('pool'), 'false', 'the URL parameter wins');
    assert.equal(url.searchParams.get('socketTimeout'), '5000');
    assert.equal(url.searchParams.get('connectionTimeout'), '10000');
    await transport.close();
  });

  it('requires STARTTLS for every non-loopback host that does not start in TLS', async () => {
    const requireTlsFor = async (options: Record<string, unknown>): Promise<unknown> => {
      const { dependencies, state } = fakeSmtpDependencies();
      const transport = new SmtpMailTransport(options, dependencies);
      await transport.send(MESSAGE);
      await transport.close();
      const config = state.configs[0];
      return typeof config === 'string'
        ? new URL(config).searchParams.get('requireTLS')
        : config?.requireTLS;
    };
    // A plaintext hop over a network: nodemailer must not fall back when the
    // server's STARTTLS offer is stripped.
    assert.equal(await requireTlsFor({ host: 'smtp.example.com', port: 587 }), true);
    assert.equal(await requireTlsFor({ host: 'smtp.example.com', port: 25, secure: false }), true);
    assert.equal(await requireTlsFor({ url: 'smtp://user:pass@smtp.example.com:587' }), 'true');
    // Implicit TLS needs no upgrade.
    assert.equal(await requireTlsFor({ host: 'smtp.example.com', port: 465 }), false);
    assert.equal(await requireTlsFor({ host: 'smtp.example.com', secure: true }), false);
    assert.equal(await requireTlsFor({ url: 'smtps://smtp.example.com:465' }), 'false');
    // A loopback relay never crosses a network.
    assert.equal(await requireTlsFor({ host: 'localhost', port: 1025 }), false);
    assert.equal(await requireTlsFor({ host: '127.0.0.1', port: 1025 }), false);
    assert.equal(await requireTlsFor({ url: 'smtp://[::1]:1025' }), 'false');
    // An explicit opt-out, by option or by URL parameter, for a trusted relay.
    assert.equal(await requireTlsFor({ host: 'mailpit', port: 1025, requireTLS: false }), false);
    assert.equal(await requireTlsFor({ url: 'smtp://mailpit:1025?requireTLS=false' }), 'false');
    assert.throws(
      () => new SmtpMailTransport({ host: 'h', requireTLS: 'yes' } as never),
      TypeError,
    );
  });

  it('never lets nodemailer read a file or fetch a URL, whatever the URL says', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport(
      { url: 'smtp://smtp.example.com:587?disableFileAccess=false&disableUrlAccess=false' },
      dependencies,
    );
    await transport.send(MESSAGE);
    const url = new URL(state.configs[0] as string);
    assert.equal(url.searchParams.get('disableFileAccess'), 'true');
    assert.equal(url.searchParams.get('disableUrlAccess'), 'true');
    await transport.close();
  });

  it('rejects malformed tuning at construction', () => {
    for (const options of [
      { host: 'h', socketTimeoutMs: 0 },
      { host: 'h', maxConnections: 1.5 },
      { host: 'h', pool: 'yes' },
    ]) {
      assert.throws(() => new SmtpMailTransport(options as never), TypeError);
    }
  });

  it('forwards several recipients, cc/bcc/replyTo, a display-name sender, and attachments', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = new SmtpMailTransport(
      { host: 'smtp.example.com', from: { name: 'App', address: 'no-reply@example.com' } },
      dependencies,
    );
    await transport.send({
      to: ['ada@example.com', { name: 'Grace H', address: 'grace@example.com' }],
      cc: 'cc@example.com',
      bcc: ['b1@example.com', 'b2@example.com'],
      replyTo: 'support@example.com',
      subject: 'hi',
      text: 'x',
      attachments: [{ filename: 'a.txt', content: 'hello', contentType: 'text/plain' }],
    });
    const mail = state.mails[0];
    assert.ok(mail);
    assert.deepEqual(mail.from, { name: 'App', address: 'no-reply@example.com' });
    assert.deepEqual(mail.to, [
      { name: '', address: 'ada@example.com' },
      { name: 'Grace H', address: 'grace@example.com' },
    ]);
    assert.deepEqual(mail.cc, [{ name: '', address: 'cc@example.com' }]);
    assert.deepEqual(mail.bcc, [
      { name: '', address: 'b1@example.com' },
      { name: '', address: 'b2@example.com' },
    ]);
    assert.deepEqual(mail.replyTo, [{ name: '', address: 'support@example.com' }]);
    assert.equal(mail.attachments?.length, 1);
    assert.equal(mail.attachments?.[0]?.filename, 'a.txt');
    assert.equal(mail.attachments?.[0]?.contentType, 'text/plain');
    assert.equal(mail.attachments?.[0]?.content.toString('utf8'), 'hello');
    await transport.close();
  });

  it('never lets a display name add a recipient once nodemailer builds the message', async () => {
    const nodemailer = await import('nodemailer');
    const envelopes: Array<{ from: string | false; to: string[] }> = [];
    const headers: string[] = [];
    const transport = new SmtpMailTransport(
      { host: 'smtp.example.com' },
      {
        createTransport() {
          const real = nodemailer.createTransport({ streamTransport: true, buffer: true });
          return {
            async sendMail(mail) {
              const info = await real.sendMail(mail);
              envelopes.push(info.envelope);
              headers.push(String(info.message));
            },
            close: () => real.close(),
          };
        },
      },
    );
    const hostile = 'Eve", <attacker@evil.test>, "x\\';
    await transport.send({
      from: { name: hostile, address: 'sender@example.com' },
      to: { name: hostile, address: 'ada@example.com' },
      cc: [{ name: 'a, b <c@evil.test>', address: 'cc@example.com' }],
      subject: 'hi',
      text: 'x',
    });
    assert.deepEqual(envelopes[0], {
      from: 'sender@example.com',
      to: ['ada@example.com', 'cc@example.com'],
    });
    // The rendered headers, read back by nodemailer's own parser, still name
    // exactly one mailbox each.
    const addressparser = (await import('nodemailer/lib/addressparser')).default;
    const unfolded = (headers[0] ?? '').split('\r\n\r\n')[0]?.replace(/\r\n[ \t]+/g, ' ') ?? '';
    for (const name of ['From', 'To', 'Cc']) {
      const line = unfolded.split('\r\n').find((entry) => entry.startsWith(`${name}: `));
      assert.ok(line, `${name} header present`);
      const parsed = addressparser(line.slice(name.length + 2), { flatten: true });
      assert.equal(parsed.length, 1, `${name} carries one mailbox`);
    }
    await transport.close();
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
  sent: Array<{ from?: string; to: readonly string[]; subject: string }>;
  configs: Array<SmtpConnectionConfig | string>;
  mails: SmtpMailOptions[];
}

/** An SMTP factory seam that records creates/sends/closes and can fail either. */
function fakeSmtpDependencies(options?: {
  failSendWith?: { code: string };
  failCreateOnce?: boolean;
}): {
  dependencies: SmtpTransportDependencies;
  state: FakeSmtpState;
} {
  const state: FakeSmtpState = { creates: 0, closes: 0, sent: [], configs: [], mails: [] };
  const dependencies: SmtpTransportDependencies = {
    createTransport(config) {
      state.creates += 1;
      state.configs.push(config);
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
          state.sent.push({
            from: mail.from?.address,
            to: mail.to.map((entry) => entry.address),
            subject: mail.subject,
          });
          state.mails.push(mail);
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
