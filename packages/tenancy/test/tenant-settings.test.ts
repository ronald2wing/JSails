/**
 * Tests for typed tenant settings: defaults applied on write and on read,
 * deeply frozen fresh results, issues reported as path and code only with no
 * input in any error, the 64 KiB UTF-8 cap, values JSON cannot store, schemas
 * whose output does not survive storage, and the lifecycle using a bound
 * parser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';
import * as zm from 'zod/mini';

import { TenancyError } from '../src/tenancy-error.js';
import {
  MAX_SETTINGS_ISSUES,
  MAX_TENANT_SETTINGS_BYTES,
  parseTenantSettings,
  tenantSettingsJson,
  tenantSettingsParser,
} from '../src/tenant-settings.js';
import { lifecycleFixture, user } from './lifecycle-fixture.js';
import { rejectedCode, thrownCode } from './thrown-code.js';

const schema = z.object({
  theme: z.enum(['light', 'dark']).default('light'),
  locale: z.string().max(16).default('en'),
  features: z.array(z.string()).default([]),
  limits: z.object({ projects: z.number().int().min(0) }).optional(),
});

function refusal(fn: () => unknown): TenancyError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok('code' in error && 'issues' in error, 'expected a tenancy error');
    return error as TenancyError;
  }
  assert.fail('expected the call to throw');
}

describe('parseTenantSettings', () => {
  it('applies the schema defaults', () => {
    assert.deepEqual(parseTenantSettings(schema, {}), {
      theme: 'light',
      locale: 'en',
      features: [],
    });
    assert.deepEqual(parseTenantSettings(schema, { theme: 'dark', limits: { projects: 3 } }), {
      theme: 'dark',
      locale: 'en',
      features: [],
      limits: { projects: 3 },
    });
  });

  it('returns a deeply frozen value that shares nothing with the input', () => {
    const raw = { features: ['beta'], limits: { projects: 1 } };
    const parsed = parseTenantSettings(schema, raw);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.features));
    assert.ok(Object.isFrozen(parsed.limits));
    assert.notEqual(parsed.features, raw.features);
    assert.ok(!Object.isFrozen(raw.features));
    const open = z.record(z.string(), z.unknown());
    const nested = { a: { b: [1] } };
    const copy = parseTenantSettings(open, nested);
    assert.notEqual(copy.a, nested.a);
    assert.ok(!Object.isFrozen(nested.a));
  });

  it('reports refused input as path-and-code issues', () => {
    const error = refusal(() =>
      parseTenantSettings(schema, { theme: 'blue', features: ['ok', 7], limits: { projects: -1 } }),
    );
    assert.equal(error.code, 'invalid_settings');
    assert.deepEqual(
      error.issues.map((entry) => ({ path: entry.path, code: entry.code })),
      [
        { path: ['theme'], code: 'invalid_value' },
        { path: ['features', 1], code: 'invalid_type' },
        { path: ['limits', 'projects'], code: 'too_small' },
      ],
    );
    assert.ok(Object.isFrozen(error.issues));
    for (const entry of error.issues) {
      assert.deepEqual(Object.keys(entry).sort(), ['code', 'path']);
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.path));
    }
  });

  it('never carries the input or a message quoting it', () => {
    const secret = 'SECRET-VALUE-4711';
    const quoting = z.object({
      motto: z.string().refine((value) => value.length < 5, { message: `bad ${secret}` }),
    });
    const calls: readonly (() => unknown)[] = [
      () => parseTenantSettings(quoting, { motto: secret }),
      () => parseTenantSettings(schema, { locale: secret.repeat(2) }),
      () => parseTenantSettings(schema, { theme: secret }),
    ];
    for (const call of calls) {
      const error = refusal(call);
      const visible = JSON.stringify({
        message: error.message,
        issues: error.issues,
        context: error.context,
        stack: error.stack,
      });
      assert.ok(!visible.includes(secret), visible);
      assert.equal(error.cause, undefined);
    }
  });

  it('hides path segments that are not short printable keys', () => {
    const counts = z.record(z.string(), z.number());
    const long = 'k'.repeat(65);
    const error = refusal(() =>
      parseTenantSettings(counts, {
        ok: 'x',
        'line\nbreak': 'x',
        [long]: 'x',
        ['k'.repeat(64)]: 'x',
      }),
    );
    assert.deepEqual(
      error.issues.map((entry) => entry.path),
      [['ok'], ['*'], ['*'], ['k'.repeat(64)]],
    );
    const bidi = refusal(() => parseTenantSettings(counts, { 'a‮b': 'x' }));
    assert.deepEqual(bidi.issues[0]?.path, ['*']);
  });

  it(`reports at most ${MAX_SETTINGS_ISSUES} issues`, () => {
    const numbers = z.object({ values: z.array(z.number()) });
    const error = refusal(() =>
      parseTenantSettings(numbers, { values: Array.from({ length: 100 }, () => 'x') }),
    );
    assert.equal(error.issues.length, MAX_SETTINGS_ISSUES);
  });

  it('caps the stored JSON at 64 KiB of UTF-8', () => {
    const blob = z.object({ b: z.string() });
    // {"b":"…"} adds 8 bytes around the string.
    const fits = 'x'.repeat(MAX_TENANT_SETTINGS_BYTES - 8);
    assert.equal(parseTenantSettings(blob, { b: fits }).b.length, fits.length);
    const over = refusal(() => parseTenantSettings(blob, { b: `${fits}x` }));
    assert.equal(over.code, 'invalid_settings');
    assert.deepEqual(over.issues, [{ path: [], code: 'too_big' }]);
    // Two bytes per character: half as many characters reach the cap.
    const wide = 'é'.repeat((MAX_TENANT_SETTINGS_BYTES - 8) / 2);
    assert.equal(parseTenantSettings(blob, { b: wide }).b, wide);
    assert.equal(
      thrownCode(() => parseTenantSettings(blob, { b: `${wide}x` })),
      'invalid_settings',
    );
  });

  it('refuses input that JSON cannot store', () => {
    const open = z.record(z.string(), z.unknown());
    const cases: readonly [unknown, readonly (string | number)[]][] = [
      [{ when: new Date(0) }, ['when']],
      [{ n: 1n }, ['n']],
      [{ list: [1, undefined] }, ['list', 1]],
      [{ deep: { inf: Number.POSITIVE_INFINITY } }, ['deep', 'inf']],
      [{ map: new Map() }, ['map']],
      [{ fn: () => 1 }, ['fn']],
    ];
    for (const [raw, path] of cases) {
      const error = refusal(() => parseTenantSettings(open, raw));
      assert.equal(error.code, 'invalid_settings');
      assert.deepEqual(error.issues, [{ path, code: 'not_json' }]);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(
      thrownCode(() => parseTenantSettings(open, cyclic)),
      'invalid_settings',
    );
    assert.deepEqual(parseTenantSettings(open, { gone: undefined, kept: 1 }), { kept: 1 });
  });

  it('refuses results that are not JSON objects', () => {
    const list = z.array(z.number());
    const error = refusal(() => parseTenantSettings(list, [1]));
    assert.equal(error.code, 'invalid_settings');
    assert.deepEqual(error.issues, [{ path: [], code: 'invalid_type' }]);
  });

  it('refuses a schema whose output does not survive storage', () => {
    const dated = z.object({ since: z.coerce.date() });
    assert.equal(
      thrownCode(() => parseTenantSettings(dated, { since: '2026-01-01' })),
      'invalid_settings_schema',
    );
    const drifting = z.object({ n: z.number().transform((n) => n + 1) });
    assert.equal(
      thrownCode(() => parseTenantSettings(drifting, { n: 1 })),
      'invalid_settings_schema',
    );
    const strictInput = z.object({ tag: z.string().transform((tag) => tag.length) });
    assert.equal(
      thrownCode(() => parseTenantSettings(strictInput, { tag: 'abc' })),
      'invalid_settings_schema',
    );
    const stable = z.object({ name: z.string().trim().toLowerCase() });
    assert.deepEqual(parseTenantSettings(stable, { name: '  Acme ' }), { name: 'acme' });
  });

  it('refuses a schema that throws or is asynchronous', () => {
    const asyncSchema = z.object({ a: z.string().refine(async () => true) });
    assert.equal(
      thrownCode(() => parseTenantSettings(asyncSchema, { a: 'x' })),
      'invalid_settings_schema',
    );
    const throwing = z.object({
      a: z.string().transform(() => {
        throw new Error('boom');
      }),
    });
    assert.equal(
      thrownCode(() => parseTenantSettings(throwing, { a: 'x' })),
      'invalid_settings_schema',
    );
  });

  it('refuses something that is not a zod schema', () => {
    const fake = { safeParse: () => ({ success: true, data: {} }) } as unknown as typeof schema;
    assert.equal(
      thrownCode(() => parseTenantSettings(fake, {})),
      'invalid_settings_schema',
    );
    assert.equal(
      thrownCode(() => tenantSettingsParser(fake)),
      'invalid_settings_schema',
    );
  });

  it('accepts zod mini schemas', () => {
    const mini = zm.object({ theme: zm._default(zm.string(), 'light') });
    assert.deepEqual(parseTenantSettings(mini, {}), { theme: 'light' });
    assert.equal(
      thrownCode(() => parseTenantSettings(mini, { theme: 3 })),
      'invalid_settings',
    );
  });
});

describe('tenantSettingsJson', () => {
  it('serialises plain JSON objects and refuses everything else', () => {
    assert.equal(tenantSettingsJson({ a: [1, 'b', null, true] }), '{"a":[1,"b",null,true]}');
    assert.equal(tenantSettingsJson(Object.create(null)), '{}');
    for (const value of [null, [], 'x', 1, new Date(0), { a: Number.NaN }]) {
      assert.equal(
        thrownCode(() => tenantSettingsJson(value)),
        'invalid_settings',
        String(value),
      );
    }
  });
});

describe('tenantSettingsParser in the lifecycle', () => {
  it('applies defaults on write and on read, including defaults added later', async () => {
    const v1 = z.object({ theme: z.string().default('light') });
    const first = lifecycleFixture({ parseSettings: tenantSettingsParser(v1) });
    const tenant = await first.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.deepEqual(await first.lifecycle.settings(tenant.id, user('alice')), { theme: 'light' });

    const v2 = v1.extend({ seatsWarning: z.number().default(80) });
    const second = lifecycleFixture({
      store: first.store,
      parseSettings: tenantSettingsParser(v2),
    });
    assert.deepEqual(await second.lifecycle.settings(tenant.id, user('alice')), {
      theme: 'light',
      seatsWarning: 80,
    });
    assert.deepEqual(
      await second.lifecycle.updateSettings(tenant.id, { theme: 'dark' }, user('alice')),
      { theme: 'dark', seatsWarning: 80 },
    );
  });

  it('keeps refusals and schema errors distinct', async () => {
    const { lifecycle } = lifecycleFixture({
      parseSettings: tenantSettingsParser(z.object({ n: z.number().transform((n) => n + 1) })),
    });
    assert.equal(
      await rejectedCode(
        lifecycle.create({ name: 'Acme', slug: 'acme', settings: { n: 1 } }, user('a')),
      ),
      'invalid_settings_schema',
    );
    const strict = lifecycleFixture({
      parseSettings: tenantSettingsParser(z.strictObject({ n: z.number().default(1) })),
    });
    const tenant = await strict.lifecycle.create({ name: 'Acme', slug: 'acme' }, user('alice'));
    assert.equal(
      await rejectedCode(strict.lifecycle.updateSettings(tenant.id, { other: 1 }, user('alice'))),
      'invalid_settings',
    );
  });
});
