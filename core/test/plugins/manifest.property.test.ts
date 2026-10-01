/**
 * Seeded property tests for plugin manifest v1.
 *
 * A small deterministic PRNG (mulberry32) builds valid manifests for both
 * carriers from random ids, versions, compat ranges, and registry
 * permissions, then applies one mutation. The properties: every unmutated
 * manifest is accepted; a manifest with an unregistered permission, a bundle
 * manifest with an npm-only field, and an experimental manifest with a caret
 * range are each refused with their code; and no issue ever repeats a marker
 * string planted in the input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkPluginManifest,
  type PluginManifestSource,
} from '../../src/plugins/manifest/index.js';
import { getPermission, PERMISSIONS } from '../../src/plugins/permissions/index.js';

const BASE_SEED = 0x6d4b_0002;
const RUNS = 300;

/** mulberry32: a tiny, well-distributed 32-bit PRNG; same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  word(min: number, max: number): string;
}

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  const int = (max: number): number => Math.floor(next() * max);
  return {
    int,
    pick: (items) => items[int(items.length)]!,
    word(min, max) {
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const length = min + int(max - min + 1);
      let out = '';
      for (let i = 0; i < length; i += 1) out += letters[int(letters.length)];
      return out;
    },
  };
}

/** A registered permission, with a valid scope when it takes one. */
function registeredPermission(gen: Gen): string {
  const definition = gen.pick(PERMISSIONS);
  switch (definition.scoped) {
    case undefined:
      return definition.id;
    case 'host':
      return `${definition.id}:${gen.word(1, 8)}.${gen.word(2, 6)}`;
    case 'model':
      return `${definition.id}:${gen.word(1, 1).toUpperCase()}${gen.word(1, 10)}`;
    case 'disk':
      return `${definition.id}:${gen.word(1, 10)}`;
    case 'env':
      return `${definition.id}:APP_${gen.word(1, 10).toUpperCase()}`;
  }
}

function validManifest(gen: Gen, source: PluginManifestSource): Record<string, unknown> {
  const experimental = gen.int(2) === 0;
  const version = `${gen.int(5)}.${gen.int(20)}.${gen.int(20)}`;
  const permissions = [
    ...new Set(Array.from({ length: gen.int(6) }, () => registeredPermission(gen))),
  ];
  return {
    manifestVersion: 1,
    id: `${gen.word(1, 6)}-${gen.word(1, 10)}`,
    version,
    name: gen.word(1, 20),
    summary: `${gen.word(1, 30)}.`,
    publisher: gen.word(1, 12),
    jsailsCompat: `${experimental || gen.int(2) === 0 ? '~' : '^'}${gen.int(3)}.${gen.int(10)}.0`,
    apiTier: experimental ? 'experimental' : 'stable',
    permissions,
    entry: source === 'bundle' ? `./${gen.word(1, 8)}.mjs` : `@${gen.word(1, 6)}/${gen.word(1, 8)}`,
    ...(source === 'bundle' || gen.int(2) === 0 ? { marketplace: true } : {}),
  };
}

/** A dotted id the registry does not define. */
function unregisteredPermission(gen: Gen): string {
  for (;;) {
    const candidate = `${gen.word(2, 8)}.${gen.word(2, 8)}`;
    if (getPermission(candidate) === undefined) return candidate;
  }
}

const NPM_ONLY: Readonly<Record<string, (gen: Gen) => unknown>> = {
  commands: (gen) => [
    { name: gen.word(1, 8), summary: 'A command.', module: `@a/${gen.word(1, 6)}` },
  ],
  generators: (gen) => [
    { name: gen.word(1, 8), summary: 'A generator.', module: `@a/${gen.word(1, 6)}` },
  ],
  autoload: (gen) => gen.pick([{ mode: 'all' }, { mode: 'none' }]),
  env: (gen) => [{ name: `APP_${gen.word(1, 8).toUpperCase()}`, kind: 'string' }],
};

function issueCodes(raw: unknown, source: PluginManifestSource): readonly string[] | undefined {
  const result = checkPluginManifest(raw, source);
  return result.ok ? undefined : result.issues.map((issue) => issue.code);
}

describe('plugin manifest v1 (seeded properties)', () => {
  it('accepts every generated valid manifest in both carriers', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      for (const source of ['package', 'bundle'] as const) {
        const raw = validManifest(gen, source);
        assert.equal(issueCodes(raw, source), undefined, `seed ${BASE_SEED + run} (${source})`);
      }
    }
  });

  it('refuses an unregistered permission wherever it appears in the list', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      const source = gen.pick(['package', 'bundle'] as const);
      const raw = validManifest(gen, source);
      const permissions = [...(raw['permissions'] as string[])];
      permissions.splice(gen.int(permissions.length + 1), 0, unregisteredPermission(gen));
      assert.deepEqual(
        issueCodes({ ...raw, permissions }, source),
        ['unknown_permission'],
        `seed ${BASE_SEED + run}`,
      );
    }
  });

  it('refuses a bundle manifest carrying any npm-only field', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      const raw = validManifest(gen, 'bundle');
      const field = gen.pick(Object.keys(NPM_ONLY));
      // Well formed or not, the field's presence alone refuses the bundle.
      const value = gen.pick([NPM_ONLY[field]!(gen), 42, 'all', null, [{}], { mode: 'x' }]);
      assert.deepEqual(
        issueCodes({ ...raw, [field]: value }, 'bundle'),
        ['npm_only_field'],
        `seed ${BASE_SEED + run} (${field})`,
      );
    }
  });

  it('refuses an experimental manifest with a caret range', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      const source = gen.pick(['package', 'bundle'] as const);
      const raw = {
        ...validManifest(gen, source),
        apiTier: 'experimental',
        jsailsCompat: `^${gen.int(3)}.${gen.int(10)}.${gen.int(10)}`,
      };
      assert.deepEqual(
        issueCodes(raw, source),
        ['experimental_requires_tilde'],
        `seed ${BASE_SEED + run}`,
      );
    }
  });

  it('never repeats a planted marker in an issue', () => {
    const fields = [
      'id',
      'version',
      'name',
      'publisher',
      'jsailsCompat',
      'entry',
      'apiTier',
      'extra',
    ];
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      const source = gen.pick(['package', 'bundle'] as const);
      const marker = `MARK${gen.word(12, 16)}`;
      const raw: Record<string, unknown> = { ...validManifest(gen, source) };
      raw[gen.pick(fields)] = gen.pick([
        marker,
        `https://${marker}.test`,
        `${marker}\n`,
        `../${marker}`,
      ]);
      raw['permissions'] = [gen.pick([marker, `net.fetch:${marker}`, `env.read:${marker}`])];
      const result = checkPluginManifest(raw, source);
      assert.equal(result.ok, false);
      if (!result.ok) {
        const printed = JSON.stringify(result.issues);
        assert.ok(!printed.includes(marker), `seed ${BASE_SEED + run}: ${printed}`);
      }
    }
  });

  it('never repeats an unknown key that is not a plain identifier', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const gen = generator(BASE_SEED + run);
      const source = gen.pick(['package', 'bundle'] as const);
      const marker = `MARK${gen.word(12, 16)}`;
      const key = gen.pick([
        `${marker}\n`,
        `../${marker}`,
        `${marker}-x`,
        `<${marker}>`,
        `${marker}${'x'.repeat(64)}`,
      ]);
      const raw = { ...validManifest(gen, source), [key]: marker };
      const result = checkPluginManifest(raw, source);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(
          result.issues.map((found) => [found.path.join('.'), found.code]),
          [['', 'unknown_field']],
          `seed ${BASE_SEED + run}`,
        );
        assert.ok(!JSON.stringify(result.issues).includes(marker), `seed ${BASE_SEED + run}`);
      }
    }
  });
});
