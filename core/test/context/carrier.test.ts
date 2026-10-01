/**
 * The context carrier: what a dispatch writes, what a worker restores, and
 * that a carrier read back from a queue is validated as input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { restoreContext, serializeContext } from '../../src/context/carrier.js';
import {
  contextEntry,
  createContextKey,
  createExecutionContext,
  getContext,
  runInContext,
} from '../../src/context/execution-context.js';
import { continueTrace, parseTraceparent } from '../../src/context/trace-context.js';
import {
  currentTenantId,
  runWithTenant,
  withoutTenantScope,
} from '../../src/database/tenant-context.js';
import { currentAppScope, withAppScope } from '../../src/facades/app-scope.js';
import { currentLocale, withLocale } from '../../src/i18n/request-locale.js';
import { createServiceRegistry } from '../../src/extensions/services.js';

const plan = createContextKey<{ readonly tier: string }>('test.carrier.plan', {
  propagate: {
    encode: (value) => value.tier,
    decode: (text) => (text === 'free' || text === 'pro' ? { tier: text } : undefined),
  },
});
const local = createContextKey<string>('test.carrier.local');
const TRACEPARENT = '00-12345678901234567890123456789012-1234567890123456-01';

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

describe('serializeContext', () => {
  it('is undefined outside every context', () => {
    assert.equal(serializeContext(), undefined);
  });

  it('carries the span, request id, and propagated values only', () => {
    const trace = continueTrace(parseTraceparent(TRACEPARENT)!, [{ key: 'vendor', value: 'x' }]);
    const context = createExecutionContext({
      trace,
      requestId: 'req-1',
      values: [contextEntry(plan, { tier: 'pro' }), contextEntry(local, 'in-process')],
    });
    const carrier = serializeContext(context);
    assert.deepEqual(carrier, {
      v: 1,
      traceparent: `00-${trace.traceId}-${trace.spanId}-01`,
      tracestate: 'vendor=x',
      requestId: 'req-1',
      values: { 'test.carrier.plan': 'pro' },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(carrier)), carrier);
  });

  it('carries locale and tenant id, but neither the app scope nor a switched-off tenant scope', () => {
    const services = createServiceRegistry().services;
    const carrier = withAppScope(services, () =>
      withLocale('pt-BR', () =>
        runWithTenant(42, () => withoutTenantScope(() => serializeContext())),
      ),
    );
    assert.deepEqual(carrier?.values, { 'jsails.locale': 'pt-BR', 'jsails.tenant': '42' });
    const restored = restoreContext(carrier);
    runInContext(restored, () => {
      assert.equal(currentLocale(), 'pt-BR');
      assert.equal(currentTenantId(), 42);
      assert.equal(currentAppScope(), undefined);
    });
  });

  it('refuses a codec that returns text it cannot carry', () => {
    const broken = createContextKey<string>('test.carrier.broken', {
      propagate: { encode: (value) => value, decode: (text) => text },
    });
    for (const value of ['', 'x'.repeat(1025)]) {
      assert.throws(
        () => serializeContext(createExecutionContext({ values: [contextEntry(broken, value)] })),
        (error: unknown) => codeOf(error) === 'context.unencodable_value',
      );
    }
  });
});

describe('restoreContext', () => {
  it('continues the carried span as a child and restores request id and values', () => {
    const dispatcher = createExecutionContext({
      requestId: 'req-9',
      values: [contextEntry(plan, { tier: 'free' })],
    });
    const restored = restoreContext(serializeContext(dispatcher));
    assert.equal(restored.trace.traceId, dispatcher.trace.traceId);
    assert.equal(restored.trace.parentSpanId, dispatcher.trace.spanId);
    assert.notEqual(restored.trace.spanId, dispatcher.trace.spanId);
    assert.equal(restored.requestId, 'req-9');
    assert.deepEqual(getContext(plan, restored), { tier: 'free' });
  });

  it('skips a carried key this process does not declare with a codec', () => {
    const restored = restoreContext({
      v: 1,
      traceparent: TRACEPARENT,
      values: { 'test.carrier.unknown': 'x', 'test.carrier.local': 'y' },
    });
    assert.equal(getContext(local, restored), undefined);
  });

  it('drops a malformed tracestate without failing', () => {
    const restored = restoreContext({ v: 1, traceparent: TRACEPARENT, tracestate: 'BAD=1' });
    assert.deepEqual(restored.trace.traceState, []);
  });

  it('refuses another carrier version', () => {
    assert.throws(
      () => restoreContext({ v: 2, traceparent: TRACEPARENT }),
      (error: unknown) => codeOf(error) === 'context.unsupported_carrier',
    );
  });

  it('refuses a malformed carrier, naming only the field at fault', () => {
    const secret = 'sk_live_secret';
    const cases: readonly [unknown, string][] = [
      [null, 'shape'],
      ['carrier', 'shape'],
      [[], 'shape'],
      [{ v: '1', traceparent: TRACEPARENT }, 'shape'],
      [{ v: 1, traceparent: TRACEPARENT, extra: secret }, 'shape'],
      [{ v: 1 }, 'traceparent'],
      [{ v: 1, traceparent: secret }, 'traceparent'],
      [{ v: 1, traceparent: TRACEPARENT, requestId: `${secret}\r\n` }, 'requestId'],
      [{ v: 1, traceparent: TRACEPARENT, values: [secret] }, 'values'],
      [{ v: 1, traceparent: TRACEPARENT, values: { 'test.carrier.plan': 3 } }, 'values'],
      [{ v: 1, traceparent: TRACEPARENT, values: { 'test.carrier.plan': '' } }, 'values'],
    ];
    for (const [carrier, field] of cases) {
      assert.throws(
        () => restoreContext(carrier),
        (error: unknown) => {
          assert.equal(codeOf(error), 'context.invalid_carrier');
          assert.equal((error as { context?: { field?: unknown } }).context?.field, field);
          assert.equal((error as Error).message.includes(secret), false);
          return true;
        },
        JSON.stringify(carrier),
      );
    }
  });

  it('refuses a value its codec does not decode, naming the key only', () => {
    for (const values of [
      { 'test.carrier.plan': 'enterprise' },
      { 'jsails.tenant': 'not json' },
      { 'jsails.tenant': '""' },
      { 'jsails.tenant': 'true' },
      { 'jsails.locale': 'en US; drop' },
    ]) {
      assert.throws(
        () => restoreContext({ v: 1, traceparent: TRACEPARENT, values }),
        (error: unknown) => {
          assert.equal(codeOf(error), 'context.invalid_value');
          assert.equal((error as Error).message.includes(Object.values(values).join('')), false);
          return true;
        },
        JSON.stringify(values),
      );
    }
  });

  it('restores a string tenant id as a string and a numeric one as a number', () => {
    for (const tenant of ['acme', 7]) {
      const carrier = runWithTenant(tenant, () => serializeContext());
      assert.equal(
        runInContext(restoreContext(carrier), () => currentTenantId()),
        tenant,
      );
    }
  });
});
