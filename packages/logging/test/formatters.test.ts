/**
 * Formatter tests: stable key order, line format, bounded serialization with
 * circular and throwing values, dropped function/symbol/undefined, and Error
 * in context.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jsonFormatter, lineFormatter } from '../src/formatters.js';
import { record } from './fixtures.js';

const UNSERIALIZABLE = '[unserializable]';

describe('jsonFormatter', () => {
  it('produces stable key order: level, message, context, at', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(
      record({ level: 'warn', message: 'uh oh', context: { a: 1, b: 'x' }, at: 1700000000000 }),
    );

    const parsed = JSON.parse(out);
    // Object.keys preserves insertion order; verify the serialized key order.
    assert.deepEqual(Object.keys(parsed), ['level', 'message', 'context', 'at']);
    assert.equal(parsed.level, 'warn');
    assert.equal(parsed.message, 'uh oh');
    assert.deepEqual(parsed.context, { a: 1, b: 'x' });
    assert.equal(parsed.at, 1700000000000);
  });

  it('serializes empty context as {}', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(record({ context: {} }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, {});
  });

  it('serializes context with nested objects', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(record({ context: { user: { id: 1, name: 'alice' } } }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, { user: { id: 1, name: 'alice' } });
  });
});

describe('lineFormatter', () => {
  it('formats as ISO LEVEL message', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ at: 1700000000000, level: 'info', message: 'started' }));

    assert.ok(out.startsWith('2023-11-14T22:13:20.000Z'));
    assert.ok(out.includes(' INFO started'));
  });

  it('uppercases the level', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ level: 'debug' }));

    assert.ok(out.includes(' DEBUG '));
    const outWarn = fmt.format(record({ level: 'warn' }));
    assert.ok(outWarn.includes(' WARN '));
  });

  it('omits context segment when context is empty', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ context: {} }));

    // Should contain exactly: ISO LEVEL hello (no trailing space or json).
    const parts = out.split(' ');
    assert.equal(parts.length, 3); // ISO, LEVEL, message
  });

  it('appends JSON context when context is non-empty', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ context: { key: 'val' } }));

    assert.ok(out.endsWith(' {"key":"val"}'));
  });

  it('includes numeric and boolean context values', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ context: { count: 42, enabled: true } }));

    assert.ok(out.includes('{"count":42,"enabled":true}'));
  });
});

describe('bounded serialization', () => {
  it('drops functions from context', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(record({ context: { keep: 1, drop: () => {} } }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, { keep: 1 });
  });

  it('drops symbols from context', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(record({ context: { keep: 'a', sym: Symbol('x') } }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, { keep: 'a' });
  });

  it('drops undefined from context', () => {
    const fmt = jsonFormatter();
    const out = fmt.format(record({ context: { keep: 1, gone: undefined } }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, { keep: 1 });
  });

  it('replaces circular references with "[unserializable]" without throwing', () => {
    const fmt = jsonFormatter();
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;

    const out = fmt.format(record({ context: circular }));
    const parsed = JSON.parse(out);
    // The circular object can't be serialized but the formatter must not throw.
    assert.equal(parsed.level, 'info');
    // context should be the placeholder string, not an object.
    assert.equal(parsed.context, '[unserializable]');
  });

  it('replaces toJSON-throwing value with "[unserializable]"', () => {
    const fmt = jsonFormatter();
    const toxic = {
      toJSON() {
        throw new Error('boom');
      },
    };

    const out = fmt.format(record({ context: { toxic } }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.context, '[unserializable]');
  });

  it('formatter never throws on any input', () => {
    const fmt = jsonFormatter();

    // Values that could cause issues.
    const out = fmt.format(record({ context: { bigint: BigInt(123) } }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.context, '[unserializable]');
  });

  it('replaces a throwing getter with "[unserializable]" in both formatters', () => {
    const context = Object.freeze({
      get secret(): string {
        throw new Error('getter boom');
      },
    });
    assert.equal(JSON.parse(jsonFormatter().format(record({ context }))).context, UNSERIALIZABLE);
    assert.ok(lineFormatter().format(record({ context })).endsWith(` "${UNSERIALIZABLE}"`));
  });

  it('line formatter also survives circular context', () => {
    const fmt = lineFormatter();
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;

    const out = fmt.format(record({ context: circular }));
    assert.ok(out.includes(UNSERIALIZABLE));
  });
});

describe('Error in context', () => {
  it('serializes name and message, never the stack or cause', () => {
    const fmt = jsonFormatter();
    const err = new TypeError('test message', { cause: new Error('inner') });
    const out = fmt.format(record({ context: { err } }));

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, { err: { name: 'TypeError', message: 'test message' } });
    assert.equal(out.includes('inner'), false);
    assert.equal(out.includes('at '), false);
  });

  it('keeps a string or numeric code and drops other own properties', () => {
    const fmt = jsonFormatter();
    const err: Error & { code?: string; detail?: string } = new Error('msg');
    err.code = 'E_TEST';
    err.detail = 'internal';

    const out = fmt.format(record({ context: { nested: { err } } }));
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.context, {
      nested: { err: { name: 'Error', message: 'msg', code: 'E_TEST' } },
    });
  });
});

describe('lineFormatter escaping', () => {
  it('escapes newlines so a message cannot forge a second record', () => {
    const fmt = lineFormatter();
    const forged = 'login failed for x\n2026-11-19T00:00:00.000Z INFO login ok for admin';
    const out = fmt.format(record({ level: 'warn', message: forged, at: 0 }));

    assert.equal(out.includes('\n'), false);
    assert.equal(
      out,
      '1970-01-01T00:00:00.000Z WARN login failed for x\\n2026-11-19T00:00:00.000Z INFO login ok for admin',
    );
  });

  it('escapes carriage returns, tabs, ANSI escapes, C1 controls, and line separators', () => {
    const fmt = lineFormatter();
    const out = fmt.format(record({ message: 'a\rb\tc\u001b[31md\u0085e\u2028f', at: 0 }));

    assert.ok(out.endsWith('a\\rb\\tc\\u001b[31md\\u0085e\\u2028f'));
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(out), false);
  });
});
