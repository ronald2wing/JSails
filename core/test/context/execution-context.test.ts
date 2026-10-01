/**
 * The execution context: typed keys, immutability across callbacks and
 * concurrent work, one store shared by every loaded copy, and value-free key
 * errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contextEntry,
  createContextKey,
  createExecutionContext,
  currentContext,
  extendContext,
  getContext,
  isRequestId,
  runInContext,
  withContext,
} from '../../src/context/execution-context.js';
import { createRootTrace } from '../../src/context/trace-context.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createContextKey', () => {
  it('returns the declared key for a name declared again', () => {
    const first = createContextKey<number>('test.ec.same');
    const again = createContextKey<number>('test.ec.same');
    assert.equal(first, again);
    assert.equal(first.propagated, false);
    assert.ok(Object.isFrozen(first));
  });

  it('refuses a name declared with the other propagation', () => {
    createContextKey<string>('test.ec.conflict');
    assert.throws(
      () =>
        createContextKey<string>('test.ec.conflict', {
          propagate: { encode: (value) => value, decode: (text) => text },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'context.key_conflict');
        return true;
      },
    );
  });

  it('refuses a malformed name without echoing it', () => {
    for (const name of ['', 'Upper.case', '1digit', 'spa ce', 'x'.repeat(65), 'secret=hunter2']) {
      assert.throws(
        () => createContextKey(name),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'context.invalid_key_name');
          if (name.length > 0) assert.equal((error as Error).message.includes(name), false);
          return true;
        },
      );
    }
  });
});

describe('the ambient context', () => {
  const key = createContextKey<string>('test.ec.value');
  const other = createContextKey<number>('test.ec.other');

  it('is undefined outside every unit of work', () => {
    assert.equal(currentContext(), undefined);
    assert.equal(getContext(key), undefined);
  });

  it('follows the async path of runInContext and is replaced whole by it', async () => {
    const outer = createExecutionContext({ requestId: 'outer', values: [contextEntry(key, 'a')] });
    const inner = createExecutionContext({ requestId: 'inner' });
    await runInContext(outer, async () => {
      await tick();
      assert.equal(currentContext(), outer);
      await runInContext(inner, async () => {
        await tick();
        assert.equal(currentContext()?.requestId, 'inner');
        assert.equal(getContext(key), undefined);
      });
      assert.equal(getContext(key), 'a');
    });
  });

  it('withContext derives a new context and never changes the one a caller holds', async () => {
    const base = createExecutionContext({ requestId: 'r-1', values: [contextEntry(key, 'a')] });
    await runInContext(base, async () => {
      const held = currentContext();
      await withContext(other, 2, async () => {
        await tick();
        const derived = currentContext();
        assert.notEqual(derived, held);
        assert.equal(derived?.requestId, 'r-1');
        assert.equal(derived?.trace, base.trace);
        assert.equal(getContext(key), 'a');
        assert.equal(getContext(other), 2);
        await withContext(key, undefined, async () => {
          await tick();
          assert.equal(getContext(key), undefined);
        });
      });
      assert.equal(getContext(other), undefined);
      assert.equal(getContext(other, held), undefined);
    });
  });

  it('keeps concurrent units of work apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((value, index) =>
        withContext(key, value, async () => {
          await new Promise((resolve) => setTimeout(resolve, 3 - index));
          seen.push(`${value}:${String(getContext(key))}`);
        }),
      ),
    );
    assert.deepEqual(seen.sort(), ['a:a', 'b:b', 'c:c']);
  });

  it('starts a new trace for withContext outside any context', () => {
    const traces = [1, 2].map(() => withContext(key, 'x', () => currentContext()?.trace.traceId));
    assert.notEqual(traces[0], traces[1]);
  });

  it('reads a value from an explicit context', () => {
    const context = extendContext(createExecutionContext(), [contextEntry(other, 7)]);
    assert.equal(getContext(other, context), 7);
    assert.ok(Object.isFrozen(context));
  });

  it('keeps the trace and request id when extended, and returns the base for no entries', () => {
    const trace = createRootTrace();
    const base = createExecutionContext({ trace, requestId: 'r-2' });
    assert.equal(extendContext(base, []), base);
    const extended = extendContext(base, [contextEntry(key, 'v')]);
    assert.equal(extended.trace, trace);
    assert.equal(extended.requestId, 'r-2');
    assert.equal(getContext(key, base), undefined);
  });

  it('refuses a malformed request id without echoing it', () => {
    assert.throws(
      () => createExecutionContext({ requestId: 'id\r\nX-Injected: 1' }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'context.invalid_request_id');
        assert.equal((error as Error).message.includes('Injected'), false);
        return true;
      },
    );
  });
});

describe('isRequestId', () => {
  it('accepts the ids createApp accepts or generates', () => {
    assert.equal(isRequestId('client-1'), true);
    assert.equal(isRequestId('3f1c2b4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e'), true);
    assert.equal(isRequestId('a'.repeat(255)), true);
  });

  it('rejects anything else', () => {
    assert.equal(isRequestId(''), false);
    assert.equal(isRequestId('a'.repeat(256)), false);
    assert.equal(isRequestId('id with spaces'), false);
    assert.equal(isRequestId('id\nX-Injected: 1'), false);
    assert.equal(isRequestId(42), false);
    assert.equal(isRequestId(undefined), false);
  });
});

describe('two loaded copies', () => {
  it('share one store and one key registry', async () => {
    // A second evaluation of the module, as a plugin's nested copy of jsails
    // would load it: a distinct module instance with its own exports.
    const copy = (await import(
      `../../src/context/execution-context.js?copy=${Date.now()}`
    )) as typeof import('../../src/context/execution-context.js');
    assert.notEqual(copy.createContextKey, createContextKey);
    const ours = createContextKey<string>('test.ec.shared');
    const theirs = copy.createContextKey<string>('test.ec.shared');
    assert.equal(theirs, ours);
    await withContext(ours, 'set-here', async () => {
      await tick();
      assert.equal(copy.getContext(theirs), 'set-here');
      assert.equal(copy.currentContext(), currentContext());
    });
  });
});
