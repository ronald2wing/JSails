/**
 * Tests for the editable tenant fields: name and plan vectors, and the
 * settings round trip through an app parser with its size limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseTenantName,
  parseTenantPlan,
  readTenantSettings,
  serializeTenantSettings,
} from '../src/tenant-profile.js';
import { TenancyError } from '../src/tenancy-error.js';
import { plainTenantSettings } from '../src/tenancy-lifecycle-options.js';
import { thrownCode } from './thrown-code.js';

const char = (code: number): string => String.fromCodePoint(code);

describe('parseTenantName', () => {
  it('normalises and accepts printable names, emoji sequences included', () => {
    assert.equal(parseTenantName('  Acme  '), 'Acme');
    assert.equal(parseTenantName(`Cafe${char(0x301)}`), 'Café');
    const family = `${char(0x1f468)}${char(0x200d)}${char(0x1f469)}`;
    assert.equal(parseTenantName(`Team ${family}`), `Team ${family}`);
  });

  it('refuses blank, overlong, control, separator and bidi-override names', () => {
    for (const value of [
      '',
      ' ',
      'a'.repeat(201),
      `a${char(0)}b`,
      `a${char(0x2028)}b`,
      `a${char(0x202e)}b`,
      `a${char(0x2066)}b`,
      `a${char(0x200f)}b`,
      42,
    ]) {
      assert.equal(
        thrownCode(() => parseTenantName(value)),
        'invalid_name',
        String(value),
      );
    }
  });
});

describe('parseTenantPlan', () => {
  it('accepts opaque identifiers and null', () => {
    for (const value of ['pro', 'team-2026', 'stripe:price_123', 'x'.repeat(64)]) {
      assert.equal(parseTenantPlan(value), value);
    }
    assert.equal(parseTenantPlan(null), null);
    for (const value of ['', ' pro', '-pro', 'pro plan', 'x'.repeat(65), 'plän', undefined]) {
      assert.equal(
        thrownCode(() => parseTenantPlan(value)),
        'invalid_plan',
        String(value),
      );
    }
  });
});

describe('tenant settings', () => {
  it('round-trips through the parser, applying defaults on read', () => {
    const parse = (raw: unknown) => ({ locale: 'en', ...plainTenantSettings(raw) });
    const written = serializeTenantSettings(parse, { seats: 3 });
    assert.deepEqual(written.value, { locale: 'en', seats: 3 });
    assert.equal(written.json, '{"locale":"en","seats":3}');
    assert.deepEqual(readTenantSettings(parse, '{"seats":3}'), { locale: 'en', seats: 3 });
  });

  it('refuses non-object results, unserialisable values and oversized JSON', () => {
    const identity = (raw: unknown): unknown => raw;
    for (const raw of [[], 'text', null, { big: 1n }, { blob: 'x'.repeat(65_536) }]) {
      assert.equal(
        thrownCode(() => serializeTenantSettings(identity, raw)),
        'invalid_settings',
      );
    }
    assert.equal(
      thrownCode(() => readTenantSettings(identity, '{')),
      'invalid_settings',
    );
  });

  it('refuses values JSON cannot store and passes schema errors through', () => {
    const identity = (raw: unknown): unknown => raw;
    assert.equal(
      thrownCode(() => serializeTenantSettings(identity, { when: new Date(0) })),
      'invalid_settings',
    );
    const schemaFault = (): never => {
      throw new TenancyError('invalid_settings_schema');
    };
    assert.equal(
      thrownCode(() => serializeTenantSettings(schemaFault, {})),
      'invalid_settings_schema',
    );
    assert.equal(
      thrownCode(() => readTenantSettings(schemaFault, '{}')),
      'invalid_settings_schema',
    );
  });
});
