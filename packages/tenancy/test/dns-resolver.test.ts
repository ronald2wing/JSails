/**
 * Tests for the system DNS resolver adapter against an in-process UDP DNS
 * server on 127.0.0.1 (no external network): TXT answers with several
 * character-strings, NXDOMAIN and NODATA as empty, SERVFAIL as a rejection,
 * timeouts, abort, no answer reuse between lookups, option validation, and an
 * end-to-end domain challenge check.
 */

import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { after, before, describe, it } from 'node:test';

import { systemDnsResolver } from '../src/dns-resolver.js';
import { checkDomainChallenge, domainChallenge } from '../src/domain-verification.js';
import { thrownCode } from './thrown-code.js';

type Answer = { readonly rcode: number; readonly txt: readonly (readonly string[])[] } | 'drop';

let server: Socket;
let address = '';
let answer: (name: string) => Answer = () => 'drop';

/** Read the question name and the end offset of the question section. */
function readQuestion(query: Buffer): { readonly name: string; readonly end: number } {
  const labels: string[] = [];
  let offset = 12;
  for (let length = query[offset] ?? 0; length !== 0; length = query[offset] ?? 0) {
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString('latin1'));
    offset += 1 + length;
  }
  return { name: labels.join('.').toLowerCase(), end: offset + 5 };
}

function respond(query: Buffer, reply: Exclude<Answer, 'drop'>): Buffer {
  const { end } = readQuestion(query);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180 | reply.rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(reply.txt.length, 6);
  const answers = reply.txt.map((strings) => {
    const rdata = Buffer.concat(
      strings.map((value) => {
        const bytes = Buffer.from(value, 'utf8');
        return Buffer.concat([Buffer.from([bytes.byteLength]), bytes]);
      }),
    );
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0);
    fixed.writeUInt16BE(16, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(300, 6);
    fixed.writeUInt16BE(rdata.byteLength, 10);
    return Buffer.concat([fixed, rdata]);
  });
  return Buffer.concat([header, query.subarray(12, end), ...answers]);
}

before(async () => {
  server = createSocket('udp4');
  server.on('message', (query, peer) => {
    const reply = answer(readQuestion(query).name);
    if (reply !== 'drop') {
      server.send(respond(query, reply), peer.port, peer.address);
    }
  });
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  address = `127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

const never = new AbortController().signal;

describe('systemDnsResolver', () => {
  it('returns TXT records with their character-strings', async () => {
    answer = (name) =>
      name === 'txt.example.test' ? { rcode: 0, txt: [['token=ab', 'cd'], ['other']] } : 'drop';
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 1000, tries: 1 });
    const records = await resolver.resolveTxt('txt.example.test', never);
    assert.deepEqual([...records].map((record) => [...record]).sort(), [
      ['other'],
      ['token=ab', 'cd'],
    ]);
  });

  it('resolves NXDOMAIN and NODATA to an empty list', async () => {
    answer = (name) => ({ rcode: name.startsWith('nx.') ? 3 : 0, txt: [] });
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 1000, tries: 1 });
    assert.deepEqual(await resolver.resolveTxt('nx.example.test', never), []);
    assert.deepEqual(await resolver.resolveTxt('nodata.example.test', never), []);
  });

  it('rejects SERVFAIL', async () => {
    answer = () => ({ rcode: 2, txt: [] });
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 1000, tries: 1 });
    await assert.rejects(resolver.resolveTxt('fail.example.test', never), { code: 'ESERVFAIL' });
  });

  it('times out an unanswered lookup', async () => {
    answer = () => 'drop';
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 100, tries: 1 });
    await assert.rejects(resolver.resolveTxt('slow.example.test', never), { code: 'ETIMEOUT' });
  });

  it('cancels the lookup when the signal aborts, and refuses an aborted signal', async () => {
    answer = () => 'drop';
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 10_000, tries: 1 });
    const started = Date.now();
    await assert.rejects(resolver.resolveTxt('slow.example.test', AbortSignal.timeout(50)));
    assert.ok(Date.now() - started < 5000);
    await assert.rejects(resolver.resolveTxt('slow.example.test', AbortSignal.abort()));
  });

  it('answers each lookup afresh, never from an earlier response', async () => {
    let value = 'first';
    answer = () => ({ rcode: 0, txt: [[value]] });
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 1000, tries: 1 });
    assert.deepEqual(await resolver.resolveTxt('fresh.example.test', never), [['first']]);
    value = 'second';
    assert.deepEqual(await resolver.resolveTxt('fresh.example.test', never), [['second']]);
  });

  it('verifies a challenge end to end', async () => {
    const challenge = domainChallenge({
      hostname: 'shop.acme.test',
      token: 'abcdefghijklmnopqrstuvwxyz234567',
    });
    answer = (name) =>
      name === challenge.recordName
        ? { rcode: 0, txt: [['token=abcdefghijklmnop', 'qrstuvwxyz234567']] }
        : { rcode: 3, txt: [] };
    const resolver = systemDnsResolver({ servers: [address], timeoutMs: 1000, tries: 1 });
    assert.equal(await checkDomainChallenge(challenge, resolver), 'verified');
  });

  it('refuses malformed options with invalid_dns_options', () => {
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: 120_000 },
      { tries: 0 },
      { servers: [] },
      { servers: ['not a server'] },
      { servers: [7 as unknown as string] },
    ]) {
      assert.equal(
        thrownCode(() => systemDnsResolver(options)),
        'invalid_dns_options',
      );
    }
    assert.doesNotThrow(() => systemDnsResolver());
  });
});
