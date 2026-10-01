/**
 * Tests for the loopback fake SMTP server: the real nodemailer-backed
 * transport delivers through it in each TLS mode, a client that insists on
 * TLS refuses the stripped server before sending anything secret, and the
 * generated certificate is a valid self-signed certificate for loopback.
 */

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { createTransport } from 'nodemailer';

import { SmtpMailTransport } from '../src/transports.js';
import {
  derInteger,
  selfSignedCertificate,
  startFakeSmtp,
  type FakeSmtpServer,
} from './fake-smtp.js';

const MESSAGE = {
  to: 'ada@example.com',
  subject: 'fake smtp',
  text: 'line one\n.line starting with a dot',
};

const servers: FakeSmtpServer[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function server(tls: 'none' | 'starttls' | 'stripped'): Promise<FakeSmtpServer> {
  const started = await startFakeSmtp({ tls });
  servers.push(started);
  return started;
}

describe('derInteger', () => {
  it('encodes each non-negative integer in its one minimal DER form', () => {
    const encode = (bytes: number[]): string => derInteger(Buffer.from(bytes)).toString('hex');
    // A random serial whose first byte is zero must not keep it as padding.
    assert.equal(encode([0x00, 0x05, 0x10]), '02020510');
    assert.equal(encode([0x00, 0x00, 0x80]), '02020080');
    assert.equal(encode([0x80]), '02020080');
    assert.equal(encode([0x7f, 0xff]), '02027fff');
    assert.equal(encode([0x00, 0x00]), '020100');
    assert.equal(encode([]), '020100');
  });
});

describe('startFakeSmtp', () => {
  it('generates a valid self-signed certificate for localhost and 127.0.0.1', () => {
    const { cert } = selfSignedCertificate();
    const x509 = new X509Certificate(cert);
    assert.ok(x509.verify(x509.publicKey), 'the certificate is not signed by its own key');
    assert.equal(x509.checkHost('localhost'), 'localhost');
    assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
    assert.ok(new Date(x509.validTo).getTime() > Date.now());
  });

  it('accepts a plaintext delivery from SmtpMailTransport on a relay without TLS', async () => {
    const fake = await server('none');
    const transport = new SmtpMailTransport({
      host: fake.host,
      port: fake.port,
      from: 'noreply@example.com',
      pool: false,
    });
    try {
      await transport.send(MESSAGE);
    } finally {
      await transport.close();
    }
    assert.equal(fake.messages.length, 1);
    const [message] = fake.messages;
    assert.equal(message?.from, 'noreply@example.com');
    assert.deepEqual(message?.to, ['ada@example.com']);
    assert.match(message?.data ?? '', /Subject: fake smtp/);
    assert.match(message?.data ?? '', /\r\n\.line starting with a dot/, 'dot-unstuffing');
    assert.equal(message?.tls, false);
    assert.equal(fake.sessions[0]?.upgraded, false);
  });

  it('upgrades with STARTTLS before credentials and the message cross the wire', async () => {
    const fake = await server('starttls');
    const transporter = createTransport({
      host: 'localhost',
      port: fake.port,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer', pass: 'secret' },
      tls: { ca: fake.certificate },
    });
    try {
      await transporter.sendMail({ from: 'noreply@example.com', ...MESSAGE });
    } finally {
      transporter.close();
    }
    assert.equal(fake.sessions[0]?.upgraded, true);
    assert.deepEqual(fake.credentials, [
      { mechanism: 'PLAIN', user: 'mailer', pass: 'secret', tls: true },
    ]);
    assert.equal(fake.messages[0]?.tls, true);
    const plaintext = fake.sessions[0]?.commands.filter((command) => !command.tls) ?? [];
    assert.deepEqual(
      plaintext.map((command) => command.verb),
      ['EHLO', 'STARTTLS'],
    );
  });

  it('shows a stripped upgrade: refused by requireTLS, credentials leaked without it', async () => {
    const fake = await server('stripped');
    const strict = new SmtpMailTransport({
      url: `smtp://mailer:secret@${fake.host}:${fake.port}?requireTLS=true&pool=false`,
      from: 'noreply@example.com',
    });
    try {
      await assert.rejects(strict.send(MESSAGE));
    } finally {
      await strict.close();
    }
    assert.equal(
      fake.credentials.length,
      0,
      'credentials were sent after the upgrade was stripped',
    );
    assert.equal(fake.messages.length, 0);

    const lax = new SmtpMailTransport({
      url: `smtp://mailer:secret@${fake.host}:${fake.port}?requireTLS=false&pool=false`,
      from: 'noreply@example.com',
    });
    try {
      await lax.send(MESSAGE);
    } finally {
      await lax.close();
    }
    assert.deepEqual(
      fake.credentials.map((credential) => credential.tls),
      [false],
      'the fake must record a plaintext credential so a downgrade is detectable',
    );
    assert.equal(fake.messages[0]?.tls, false);
  });
});
