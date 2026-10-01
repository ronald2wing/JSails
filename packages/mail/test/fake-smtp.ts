/**
 * A loopback SMTP server for transport tests, speaking enough ESMTP for
 * nodemailer to deliver: EHLO/HELO, AUTH PLAIN and LOGIN, MAIL/RCPT/DATA,
 * RSET, NOOP, QUIT, and STARTTLS.
 *
 * The `tls` mode sets what a client finds on the wire:
 *
 * - `none`: a relay without TLS. STARTTLS is neither offered nor accepted.
 * - `starttls`: STARTTLS is offered and upgrades the session with a fresh
 *   self-signed certificate for `localhost` and `127.0.0.1` (`certificate`,
 *   for a client's `ca`).
 * - `stripped`: what a client sees through an active attacker who strips the
 *   upgrade: the STARTTLS capability is overwritten in the EHLO reply and the
 *   STARTTLS command is refused, so a client that does not insist on TLS
 *   carries on in plaintext.
 *
 * Every credential and message is recorded with whether it crossed the wire
 * encrypted, so a test can assert that nothing secret was sent in the clear.
 */

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';

/** What the server offers for transport security; see the module comment. */
export type FakeSmtpTlsMode = 'none' | 'starttls' | 'stripped';

/** Options for {@link startFakeSmtp}. */
export interface FakeSmtpOptions {
  readonly tls?: FakeSmtpTlsMode;
}

/** A credential a client presented with AUTH. */
export interface FakeSmtpCredential {
  readonly mechanism: 'PLAIN' | 'LOGIN';
  readonly user: string;
  readonly pass: string;
  /** Whether the session was encrypted when the credential was sent. */
  readonly tls: boolean;
}

/** A message accepted with DATA. */
export interface FakeSmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent, dot-unstuffed, without the terminating line. */
  readonly data: string;
  readonly tls: boolean;
}

/** One client connection. */
export interface FakeSmtpSession {
  /** Each command verb in order, with whether it arrived encrypted. */
  readonly commands: { readonly verb: string; readonly tls: boolean }[];
  /** Whether the session upgraded with STARTTLS. */
  upgraded: boolean;
}

/** A running fake server. */
export interface FakeSmtpServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly mode: FakeSmtpTlsMode;
  /** The PEM certificate a `starttls` server presents (always generated). */
  readonly certificate: string;
  readonly sessions: FakeSmtpSession[];
  readonly credentials: FakeSmtpCredential[];
  readonly messages: FakeSmtpMessage[];
  close(): Promise<void>;
}

const HOSTNAME = 'fake-smtp.test';

// --- A minimal DER encoder, enough for one self-signed X.509 certificate. ---

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Uint8Array[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Uint8Array[]): Buffer => der(0x30, ...items);

/**
 * A non-negative big-endian integer in its one valid DER form: redundant
 * leading zero bytes are dropped (OpenSSL refuses them as illegal padding,
 * and a random serial starts with one about once in 256 draws), and one zero
 * byte is kept or added only where the top bit would otherwise read as a sign.
 */
export function derInteger(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const magnitude = bytes.length === 0 ? Buffer.from([0]) : Buffer.from(bytes.subarray(start));
  const first = magnitude[0] ?? 0;
  return der(0x02, first & 0x80 ? Buffer.concat([Buffer.from([0]), magnitude]) : magnitude);
}

function derOid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift(0x80 | (value % 128));
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function derTime(date: Date): Buffer {
  const iso = date.toISOString();
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '');
  // UTCTime covers 1950-2049; GeneralizedTime takes over from 2050 (RFC 5280).
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : der(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

function pem(label: string, bytes: Buffer): string {
  const lines = bytes.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * A fresh P-256 key and a self-signed certificate for `localhost` and
 * `127.0.0.1`, valid from a day ago to a day from now. Generated per server so
 * no private key is committed to the repository.
 */
export function selfSignedCertificate(): { readonly key: string; readonly cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaWithSha256 = sequence(derOid('1.2.840.10045.4.3.2'));
  const name = sequence(
    der(0x31, sequence(derOid('2.5.4.3'), der(0x0c, Buffer.from('localhost', 'utf8')))),
  );
  const day = 24 * 60 * 60 * 1000;
  const subjectAltName = sequence(
    derOid('2.5.29.17'),
    der(
      0x04,
      sequence(
        der(0x82, Buffer.from('localhost', 'ascii')),
        der(0x87, Buffer.from([127, 0, 0, 1])),
      ),
    ),
  );
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = sequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(serial),
    ecdsaWithSha256,
    name,
    sequence(derTime(new Date(Date.now() - day)), derTime(new Date(Date.now() + day))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(subjectAltName)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate),
  };
}

// --- The server. ---

/** An address from `MAIL FROM:<a>` / `RCPT TO:<a>`, parameters dropped. */
function pathOf(argument: string): string {
  const match = /<([^>]*)>/.exec(argument);
  return match?.[1] ?? argument.trim().split(/\s+/)[0] ?? '';
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

/** Start a fake server on an ephemeral loopback port. */
export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const mode = options.tls ?? 'none';
  const { key, cert } = selfSignedCertificate();
  const secureContext: SecureContext = createSecureContext({ key, cert });
  const sessions: FakeSmtpSession[] = [];
  const credentials: FakeSmtpCredential[] = [];
  const messages: FakeSmtpMessage[] = [];
  const sockets = new Set<Socket>();

  function serve(raw: Socket): void {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => raw.destroy());
    const session: FakeSmtpSession = { commands: [], upgraded: false };
    sessions.push(session);

    let stream: Socket = raw;
    let tls = false;
    let buffered = '';
    let from: string | undefined;
    let to: string[] = [];
    let data: string[] | undefined;
    /** A pending AUTH exchange waiting for the client's next line. */
    let awaiting: ((line: string) => void) | undefined;

    const reply = (line: string): void => {
      stream.write(`${line}\r\n`);
    };
    const resetEnvelope = (): void => {
      from = undefined;
      to = [];
      data = undefined;
    };

    function ehlo(): void {
      const lines = [HOSTNAME, '8BITMIME', 'AUTH PLAIN LOGIN'];
      if (!tls && mode === 'starttls') {
        lines.push('STARTTLS');
      }
      if (!tls && mode === 'stripped') {
        lines.push('XXXXXXXA');
      }
      lines.push('OK');
      lines.forEach((line, index) => {
        reply(`250${index === lines.length - 1 ? ' ' : '-'}${line}`);
      });
    }

    function startTls(): void {
      reply('220 2.0.0 Ready to start TLS');
      stream.removeListener('data', onData);
      const secure = new TLSSocket(raw, { isServer: true, secureContext });
      secure.on('error', () => raw.destroy());
      secure.on('secure', () => {
        tls = true;
        session.upgraded = true;
      });
      stream = secure;
      buffered = '';
      resetEnvelope();
      secure.on('data', onData);
    }

    function authenticate(mechanism: 'PLAIN' | 'LOGIN', user: string, pass: string): void {
      credentials.push({ mechanism, user, pass, tls });
      reply('235 2.7.0 Authentication successful');
    }

    function command(line: string): void {
      const space = line.indexOf(' ');
      const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const argument = space === -1 ? '' : line.slice(space + 1);
      session.commands.push({ verb, tls });
      switch (verb) {
        case 'EHLO':
          resetEnvelope();
          ehlo();
          return;
        case 'HELO':
          resetEnvelope();
          reply(`250 ${HOSTNAME}`);
          return;
        case 'STARTTLS':
          if (mode === 'starttls' && !tls) {
            startTls();
          } else if (mode === 'stripped') {
            reply('500 5.5.1 Unrecognized command');
          } else {
            reply('502 5.5.1 Command not implemented');
          }
          return;
        case 'AUTH': {
          const [mechanism = '', initial] = argument.split(' ');
          if (mechanism.toUpperCase() === 'PLAIN') {
            const finish = (payload: string): void => {
              const [, user = '', pass = ''] = decode(payload).split('\0');
              authenticate('PLAIN', user, pass);
            };
            if (initial === undefined) {
              awaiting = finish;
              reply('334 ');
            } else {
              finish(initial);
            }
          } else if (mechanism.toUpperCase() === 'LOGIN') {
            const askPassword = (userLine: string): void => {
              awaiting = (passLine) => {
                authenticate('LOGIN', decode(userLine), decode(passLine));
              };
              reply('334 UGFzc3dvcmQ6');
            };
            if (initial === undefined) {
              awaiting = askPassword;
              reply('334 VXNlcm5hbWU6');
            } else {
              askPassword(initial);
            }
          } else {
            reply('504 5.5.4 Unrecognized authentication type');
          }
          return;
        }
        case 'MAIL':
          from = pathOf(argument.replace(/^FROM:/i, ''));
          to = [];
          reply('250 2.1.0 OK');
          return;
        case 'RCPT':
          if (from === undefined) {
            reply('503 5.5.1 MAIL first');
            return;
          }
          to.push(pathOf(argument.replace(/^TO:/i, '')));
          reply('250 2.1.5 OK');
          return;
        case 'DATA':
          if (from === undefined || to.length === 0) {
            reply('503 5.5.1 RCPT first');
            return;
          }
          data = [];
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          resetEnvelope();
          reply('250 2.0.0 OK');
          return;
        case 'NOOP':
          reply('250 2.0.0 OK');
          return;
        case 'QUIT':
          reply('221 2.0.0 Bye');
          stream.end();
          return;
        default:
          reply('502 5.5.2 Command not recognized');
      }
    }

    function line(text: string): void {
      if (data !== undefined) {
        if (text === '.') {
          messages.push({ from: from ?? '', to, data: data.join('\r\n'), tls });
          resetEnvelope();
          reply('250 2.0.0 Queued');
        } else {
          data.push(text.startsWith('.') ? text.slice(1) : text);
        }
        return;
      }
      const pending = awaiting;
      if (pending !== undefined) {
        awaiting = undefined;
        pending(text);
        return;
      }
      command(text);
    }

    function onData(chunk: Buffer): void {
      buffered += chunk.toString('utf8');
      for (let end = buffered.indexOf('\r\n'); end !== -1; end = buffered.indexOf('\r\n')) {
        const text = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const before = stream;
        line(text);
        if (stream !== before) {
          // STARTTLS switched streams: anything pipelined after it is discarded,
          // as RFC 3207 requires.
          return;
        }
      }
    }

    raw.on('data', onData);
    reply(`220 ${HOSTNAME} ESMTP fake`);
  }

  const server: Server = createServer(serve);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake SMTP server has no TCP address');
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    mode,
    certificate: cert,
    sessions,
    credentials,
    messages,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
