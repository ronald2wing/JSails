/**
 * Tests for the secrets file a release reads: format v1 byte for byte for any
 * string without NUL (a seeded property test over arbitrary Unicode, read back
 * through the JSails environment resolver the deployed app runs), the
 * value-free refusals, and the per-release mount convention.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { applyEnvironment, resolveEnvironment } from 'jsails/internal';

import {
  CONTAINER_SECRETS_FILE,
  SecretsFileErrors,
  encodeSecretsFile,
  releaseSecretsLayout,
} from '../../src/production/secrets-file.js';

/** A small seeded generator (mulberry32), so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One code point, drawn from the classes a secret may hold: ASCII with every
 * shell and JSON metacharacter, controls (newline, CR, tab, escape, DEL; never
 * NUL), Latin and CJK, combining marks, the BOM, and astral characters (emoji),
 * which JavaScript holds as surrogate pairs.
 */
function codePoint(next: () => number): number {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const range = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  switch (Math.floor(next() * 7)) {
    case 0:
      return range(0x20, 0x7e);
    case 1:
      return pick([0x0a, 0x0d, 0x09, 0x1b, 0x7f, 0x01, 0x22, 0x27, 0x5c, 0x24, 0x60, 0x3d, 0x23]);
    case 2:
      return range(0xa0, 0x24f);
    case 3:
      return range(0x4e00, 0x9fff);
    case 4:
      return range(0x300, 0x36f);
    case 5:
      return pick([0xfeff, 0x2028, 0x2029, 0xfffd, 0xe000]);
    default:
      return range(0x1f300, 0x1faff);
  }
}

function arbitraryValue(next: () => number): string {
  const length = Math.floor(next() * 64);
  let value = '';
  for (let at = 0; at < length; at += 1) value += String.fromCodePoint(codePoint(next));
  return value;
}

const root = mkdtempSync(join(tmpdir(), 'jamal-secrets-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The document's values, as JSON reads them. */
function readBack(bytes: Uint8Array): Record<string, string> {
  const document = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    v: number;
    values: Record<string, string>;
  };
  assert.equal(document.v, 1);
  return document.values;
}

/**
 * What a deployed app's process environment receives from the file: the
 * JSails environment resolver reads it as `JSAILS_SECRETS_FILE`, as the
 * container does, and the values it applies are returned.
 */
function readByApp(bytes: Uint8Array): Record<string, string> {
  const file = join(root, 'secrets.json');
  writeFileSync(file, bytes);
  const resolved = resolveEnvironment({
    rootDir: root,
    env: { JSAILS_SECRETS_FILE: file },
    name: 'production',
    secrets: 'unused',
  });
  const applied: Record<string, string | undefined> = {};
  applyEnvironment(resolved, applied);
  const values: Record<string, string> = {};
  for (const [name, source] of Object.entries(resolved.sources)) {
    if (source === 'secrets-file') values[name] = applied[name] ?? '';
  }
  assert.equal(resolved.secretsFile?.count, Object.keys(values).length);
  return values;
}

describe('encodeSecretsFile', () => {
  it('carries any string without NUL byte for byte (seeded property test)', () => {
    const next = random(0x5ec2e75);
    for (let round = 0; round < 500; round += 1) {
      const values: Record<string, string> = {};
      const count = 1 + Math.floor(next() * 4);
      for (let key = 0; key < count; key += 1) values[`K${key}`] = arbitraryValue(next);
      const bytes = encodeSecretsFile(values);
      // The file is valid UTF-8: decoding and re-encoding gives the same bytes.
      const text = Buffer.from(bytes).toString('utf8');
      assert.ok(Buffer.from(text, 'utf8').equals(Buffer.from(bytes)), `round ${round}: UTF-8`);
      assert.deepEqual(readByApp(bytes), values, `round ${round}`);
    }
  });

  it('carries the values a Docker env file cannot: a PEM block, quotes, $, non-ASCII', () => {
    const values = {
      PEM: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----\n',
      SHELL: 'back\\slash $HOME "double" \'single\' `tick` $(id)',
      UNICODE: 'ünïcødé ✓ 🚀',
      EMPTY: '',
    };
    assert.deepEqual(readByApp(encodeSecretsFile(values)), values);
  });

  it('writes sorted keys, so the same secrets give the same bytes', () => {
    assert.equal(
      Buffer.from(encodeSecretsFile({ B: '2', A: '1' })).toString('utf8'),
      '{"v":1,"values":{"A":"1","B":"2"}}\n',
    );
    assert.equal(Buffer.from(encodeSecretsFile({})).toString('utf8'), '{"v":1,"values":{}}\n');
  });

  for (const [label, value] of [
    ['a NUL', 's3cret\0tail'],
    ['an unpaired high surrogate', 's3cret\ud800tail'],
    ['an unpaired low surrogate', 's3cret\udc00'],
  ] as const) {
    it(`refuses a value containing ${label}, naming only the key`, () => {
      assert.throws(
        () => encodeSecretsFile({ OK: 'fine', API_TOKEN: value }),
        (error: unknown) => {
          assert.ok(SecretsFileErrors.is(error, 'unrepresentable_value'));
          assert.match(error.message, /API_TOKEN/);
          assert.ok(!error.message.includes('s3cret'), 'the value must not leak');
          return true;
        },
      );
    });
  }

  it('refuses a key the resolver reserves, but carries the credentials key ring', () => {
    for (const key of ['JSAILS_ENV', 'NODE_ENV', 'JSAILS_SECRETS_FILE', 'JSAILS_DEBUG']) {
      assert.throws(
        () => encodeSecretsFile({ [key]: 'v' }),
        (error: unknown) =>
          SecretsFileErrors.is(error, 'reserved_key') && error.message.includes(key),
        key,
      );
    }
    assert.deepEqual(readBack(encodeSecretsFile({ JSAILS_CREDENTIALS_KEY: 'ring' })), {
      JSAILS_CREDENTIALS_KEY: 'ring',
    });
  });

  it('refuses a key that is not a variable name, or a reserved object key', () => {
    for (const key of ['not-a-key', '1A', '', '__proto__', 'constructor']) {
      assert.throws(
        () =>
          encodeSecretsFile(JSON.parse(`{${JSON.stringify(key)}:"v"}`) as Record<string, string>),
        (error: unknown) =>
          SecretsFileErrors.is(error, 'invalid_key') && !error.message.includes(key || '\0'),
        key,
      );
    }
  });
});

describe('releaseSecretsLayout', () => {
  it('puts each release in its own directory, mounted read-only where the app looks', () => {
    const layout = releaseSecretsLayout(
      'myapp',
      'staging',
      '20261123100000-abcdef123456',
      '/srv/deploy',
    );
    assert.equal(
      layout.hostFile,
      '.jamal/apps/myapp.staging/releases/20261123100000-abcdef123456/secrets/secrets.json',
    );
    // The bind source is absolute: a CLI before Docker 23 sends a `./`
    // source to the daemon as a volume name, which it refuses.
    assert.deepEqual(layout.runFlags, [
      '-v',
      '/srv/deploy/.jamal/apps/myapp.staging/releases/20261123100000-abcdef123456/secrets:/run/jsails/secrets:ro',
      '-e',
      `JSAILS_SECRETS_FILE=${CONTAINER_SECRETS_FILE}`,
    ]);
    assert.equal(CONTAINER_SECRETS_FILE, '/run/jsails/secrets/secrets.json');
  });
});
