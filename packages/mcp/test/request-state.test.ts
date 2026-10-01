/**
 * The request-state seal: canonical JSON and the arguments digest, the
 * binding composition, and the SDK codec under our binding. Property tests
 * show that byte flips, truncation, and re-encoding are always refused, that
 * changing any single binding component (actor kind or id, credential, method,
 * target, arguments) refuses the state, that two keys never accept each
 * other's states, and that an expired state is refused. The payload is
 * encrypted, so the wire value never shows it, and an authentic envelope whose
 * ciphertext does not open is refused.
 */

import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';

import type { McpActor } from '../src/access.js';
import { McpDefinitionError } from '../src/errors.js';
import {
  argumentsDigest,
  bindingValue,
  canonicalJson,
  checkPayload,
  createStateSeal,
  invalidRequestState,
  type StateBinding,
} from '../src/request-state.js';
import { forAll, type Gen } from './fixtures.js';

/** The seal only uses the context as an identity for the binding lookup. */
function context(): ServerContext {
  return {} as ServerContext;
}

const KEY = new Uint8Array(32).fill(7);
const ALICE: McpActor = { kind: 'user', id: 'alice', scopes: [] };

function binding(overrides: Partial<StateBinding> = {}): StateBinding {
  return {
    actor: ALICE,
    credential: 'tok-1',
    method: 'tools/call',
    target: 'deploy',
    args: { env: 'prod', replicas: 3 },
    ...overrides,
  };
}

function randomJson(gen: Gen, depth = 0): unknown {
  const kind = gen.int(0, depth > 2 ? 3 : 5);
  switch (kind) {
    case 0:
      return gen.int(-1000, 1000);
    case 1:
      return gen.pick(['', 'a', 'é', '"q"', 'line\nbreak', '世界']);
    case 2:
      return gen.bool();
    case 3:
      return null;
    case 4:
      return Array.from({ length: gen.int(0, 3) }, () => randomJson(gen, depth + 1));
    default: {
      const object: Record<string, unknown> = {};
      for (let index = gen.int(0, 4); index > 0; index -= 1) {
        object[gen.pick(['a', 'b', 'c', 'zeta', 'Ä', '10', '2'])] = randomJson(gen, depth + 1);
      }
      return object;
    }
  }
}

function shuffled(value: unknown, gen: Gen): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => shuffled(item, gen));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = gen.int(0, index);
    [entries[index], entries[swap]] = [entries[swap]!, entries[index]!];
  }
  return Object.fromEntries(entries.map(([key, member]) => [key, shuffled(member, gen)]));
}

describe('canonicalJson and argumentsDigest', () => {
  it('ignores member order and undefined members, and keeps array order', async () => {
    assert.equal(
      canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] }),
      '{"a":[2,{"d":3}],"b":1}',
    );
    assert.equal(canonicalJson(undefined), 'null');
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
    await forAll(0x5747_0001, 200, (gen) => {
      const value = randomJson(gen);
      const reordered = shuffled(value, gen);
      assert.equal(canonicalJson(reordered), canonicalJson(value));
      assert.equal(argumentsDigest(reordered), argumentsDigest(value));
      assert.deepEqual(JSON.parse(canonicalJson(value)), JSON.parse(JSON.stringify(value)));
    });
  });

  it('distinguishes values that differ as JSON', () => {
    const digests = [{ n: 42 }, { n: '42' }, { n: 43 }, { n: [42] }, {}, null].map(argumentsDigest);
    assert.equal(new Set(digests).size, digests.length);
    assert.equal(argumentsDigest({ n: 42 }), argumentsDigest({ n: 42.0 }));
    assert.match(argumentsDigest({}), /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('bindingValue', () => {
  it('changes when any one component changes, and cannot be forged by joining components', async () => {
    const variants: ((base: StateBinding) => StateBinding)[] = [
      (base) => ({ ...base, actor: { ...base.actor, kind: 'service' } }),
      (base) => ({ ...base, actor: { ...base.actor, id: 'bob' } }),
      (base) => ({ ...base, actor: { kind: base.actor.kind, scopes: [] } }),
      (base) => ({ ...base, credential: 'tok-2' }),
      (base) => ({ ...base, credential: undefined }),
      (base) => ({ ...base, method: 'prompts/get' }),
      (base) => ({ ...base, target: 'destroy' }),
      (base) => ({ ...base, args: { env: 'staging', replicas: 3 } }),
    ];
    await forAll(0x5747_0002, 50, (gen) => {
      const base = binding({ args: randomJson(gen) });
      const variant = gen.pick(variants)(base);
      assert.notEqual(bindingValue(variant), bindingValue(base));
    });
    assert.notEqual(
      bindingValue(binding({ actor: { kind: 'user', id: 'a","b', scopes: [] }, credential: 'c' })),
      bindingValue(binding({ actor: { kind: 'user', id: 'a', scopes: [] }, credential: 'b","c' })),
    );
    assert.equal(
      bindingValue(binding({ actor: { ...ALICE, scopes: ['x'] } })),
      bindingValue(binding()),
      'scopes are not part of the binding; the credential is',
    );
  });
});

describe('createStateSeal', () => {
  it('round-trips state, the confirmation flag, and the round count under the same binding', async () => {
    const seal = createStateSeal({ key: KEY });
    const sealed = await seal.seal(
      { state: { step: 2, tags: ['a'] }, confirmed: true, rounds: 2 },
      binding(),
      context(),
    );
    assert.match(sealed, /^v1\./);
    const asked = await seal.seal({ confirmAsked: true, rounds: 1 }, binding(), context());
    assert.deepEqual(await seal.open(asked, binding(), context()), {
      ok: true,
      payload: { confirmAsked: true, rounds: 1 },
    });
    assert.ok(!sealed.includes('alice') && !sealed.includes('tok-1'));
    assert.deepEqual(await seal.open(sealed, binding(), context()), {
      ok: true,
      payload: { state: { step: 2, tags: ['a'] }, confirmed: true, rounds: 2 },
    });
    const reordered = binding({ args: { replicas: 3, env: 'prod' } });
    assert.equal((await seal.open(sealed, reordered, context())).ok, true);
  });

  it('refuses a state under any other binding', async () => {
    const seal = createStateSeal({ key: KEY });
    const sealed = await seal.seal({ state: 1, rounds: 1 }, binding(), context());
    for (const other of [
      binding({ actor: { kind: 'user', id: 'bob', scopes: [] } }),
      binding({ actor: { kind: 'service', id: 'alice', scopes: [] } }),
      binding({ credential: 'tok-2' }),
      binding({ method: 'resources/read' }),
      binding({ target: 'other' }),
      binding({ args: { env: 'prod', replicas: 4 } }),
    ]) {
      assert.deepEqual(await seal.open(sealed, other, context()), { ok: false, reason: 'bind' });
    }
  });

  it('always refuses byte flips, truncation, and re-encoding', async () => {
    const seal = createStateSeal({ key: KEY });
    const sealed = await seal.seal({ state: { secret: 'value' }, rounds: 1 }, binding(), context());
    const lastBody = sealed.lastIndexOf('.') - 1;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
    await forAll(0x5747_0003, 150, async (gen) => {
      // The final character of each base64url segment carries unused padding
      // bits, so some substitutions there decode to identical bytes; every
      // other position changes the decoded bytes.
      let position = gen.int(0, sealed.length - 2);
      while (position === lastBody) {
        position = gen.int(0, sealed.length - 2);
      }
      const replacement = gen.pick([...alphabet].filter((char) => char !== sealed[position]));
      const flipped = `${sealed.slice(0, position)}${replacement}${sealed.slice(position + 1)}`;
      assert.equal((await seal.open(flipped, binding(), context())).ok, false);
      const truncated = sealed.slice(0, gen.int(0, sealed.length - 1));
      assert.equal((await seal.open(truncated, binding(), context())).ok, false);
    });
    const [prefix, body, mac] = sealed.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forgedBody = Buffer.from(
      JSON.stringify({ ...decoded, p: { state: { secret: 'forged' }, rounds: 1 } }),
    ).toString('base64url');
    assert.deepEqual(await seal.open(`${prefix}.${forgedBody}.${mac}`, binding(), context()), {
      ok: false,
      reason: 'mac',
    });
    assert.equal((await seal.open('not a state', binding(), context())).ok, false);
  });

  it('never accepts a state sealed under another key', async () => {
    const mine = createStateSeal({ key: KEY });
    const theirs = createStateSeal();
    const sealed = await theirs.seal({ state: 1, rounds: 1 }, binding(), context());
    assert.deepEqual(await mine.open(sealed, binding(), context()), { ok: false, reason: 'mac' });
  });

  it('refuses an expired state', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const seal = createStateSeal({ key: KEY, ttlSeconds: 60 });
    const sealed = await seal.seal({ state: 1, rounds: 1 }, binding(), context());
    t.mock.timers.tick(59_000);
    assert.equal((await seal.open(sealed, binding(), context())).ok, true);
    t.mock.timers.tick(2_000);
    assert.deepEqual(await seal.open(sealed, binding(), context()), {
      ok: false,
      reason: 'expired',
    });
  });

  it('accepts only the payload shape the serving layer writes', () => {
    for (const payload of [
      { state: 1, rounds: 1, extra: true },
      { confirmed: 'yes', rounds: 1 },
      { confirmAsked: false, rounds: 1 },
      { state: 1 },
      { rounds: 0 },
      { rounds: 1.5 },
      { rounds: 101 },
      'text',
      null,
    ]) {
      assert.equal(checkPayload(payload), undefined);
    }
    assert.deepEqual(checkPayload({ confirmAsked: true, rounds: 3 }), {
      confirmAsked: true,
      rounds: 3,
    });
  });

  it('encrypts the payload, so the wire value never shows the state', async () => {
    const seal = createStateSeal({ key: KEY });
    const sealed = await seal.seal(
      { state: { secret: 'hunter2' }, confirmed: true, rounds: 1 },
      binding(),
      context(),
    );
    const [, body] = sealed.split('.');
    const envelope = Buffer.from(body!, 'base64url').toString('utf8');
    assert.ok(!envelope.includes('hunter2'));
    assert.ok(!envelope.includes('confirmed'));
    assert.ok(!envelope.includes('rounds'));
    const again = await seal.seal(
      { state: { secret: 'hunter2' }, confirmed: true, rounds: 1 },
      binding(),
      context(),
    );
    assert.notEqual(again, sealed, 'a fresh IV per seal');
  });

  it('refuses an authentic envelope whose ciphertext does not open', async () => {
    const seal = createStateSeal({ key: KEY });
    const macKey = hkdfSync('sha256', KEY, new Uint8Array(0), 'jsails-mcp-state-mac-v1', 32);
    const codec = createRequestStateCodec({
      key: new Uint8Array(macKey),
      bind: () => bindingValue(binding()),
    });
    for (const payload of [
      { state: 1, rounds: 1 },
      { c: 'AAAA' },
      { c: Buffer.alloc(64, 1).toString('base64url') },
      { c: 7 },
      'text',
      null,
    ]) {
      const minted = await codec.mint(payload, context());
      assert.deepEqual(await seal.open(minted, binding(), context()), {
        ok: false,
        reason: 'payload',
      });
    }
    const raw = createRequestStateCodec({ key: KEY, bind: () => bindingValue(binding()) });
    assert.deepEqual(
      await seal.open(await raw.mint({ rounds: 1 }, context()), binding(), context()),
      { ok: false, reason: 'mac' },
      'the serving key itself never signs; only its derived MAC key does',
    );
  });

  it('rejects short keys and out-of-range lifetimes', () => {
    for (const options of [
      { key: new Uint8Array(31) },
      { key: 'a'.repeat(40) as unknown as Uint8Array },
      { ttlSeconds: 0 },
      { ttlSeconds: 1.5 },
      { ttlSeconds: 86_401 },
    ]) {
      assert.throws(
        () => createStateSeal(options),
        (error: unknown) => error instanceof McpDefinitionError && error.code === 'invalid_option',
      );
    }
  });

  it('builds the frozen refusal the SDK hook would send', () => {
    const error = invalidRequestState();
    assert.deepEqual(
      [error.code, error.message, error.data],
      [-32602, 'Invalid or expired requestState', { reason: 'invalid_request_state' }],
    );
  });
});
