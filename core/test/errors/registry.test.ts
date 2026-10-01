/**
 * Tests for `defineErrors`: definition validation, construction (context
 * validation, message rendering, payload exposure), identity by brand and code,
 * `invariant`, and the process-wide table the registry gate reads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_BRAND } from '../../src/errors/brand.js';
import { isJsailsError, JsailsError } from '../../src/errors/jsails-error.js';
import {
  defineErrors,
  errorRegistryConflicts,
  invariant,
  isRegistryError,
  KernelErrors,
  registeredErrorCodes,
  type ErrorRegistry,
  type Payload,
} from '../../src/errors/registry.js';

const WIDGET_ERRORS = {
  missing_widget: {
    kind: 'not_found',
    message: 'widget {widget} is not registered',
    context: { widget: 'identifier' },
    suggestion: 'register the widget in setup',
  },
  too_many: {
    kind: 'too_large',
    audience: 'client',
    message: 'at most {limit} widgets',
    context: { limit: 'count' },
  },
  bad_file: {
    kind: 'invalid',
    message: 'widget file {file} uses mode {mode}',
    context: { file: 'relative-path', mode: ['fast', 'slow'] },
  },
  locked: {
    kind: 'conflict',
    audience: 'client',
    message: 'the widget is locked',
    payload: { expose: ['holder'] } as Payload<{ holder: string; secret: string }>,
  },
  plain: { kind: 'internal', message: 'something broke' },
} as const;

const WidgetErrors: ErrorRegistry<'test_widget', typeof WIDGET_ERRORS> = defineErrors(
  'test_widget',
  WIDGET_ERRORS,
);

function kernelCode(error: unknown): string {
  assert.ok(isJsailsError(error));
  return error.code;
}

describe('defineErrors construction', () => {
  it('renders the message from validated context and fills every field', () => {
    const error = new WidgetErrors.Error('missing_widget', { widget: 'clock' });
    assert.equal(error.code, 'test_widget.missing_widget');
    assert.equal(error.domain, 'test_widget');
    assert.equal(error.message, 'widget clock is not registered');
    assert.deepEqual(error.context, { widget: 'clock' });
    assert.equal(error.kind, 'not_found');
    assert.equal(error.audience, 'operator');
    assert.equal(error.suggestion, 'register the widget in setup');
    assert.equal(error.name, 'TestWidgetError');
    assert.ok(Object.isFrozen(error.context));
    assert.ok(error instanceof JsailsError);
    assert.ok(error instanceof Error);
  });

  it('accepts each context value kind and rejects values outside it', () => {
    assert.equal(new WidgetErrors.Error('too_many', { limit: 3 }).message, 'at most 3 widgets');
    assert.equal(
      new WidgetErrors.Error('bad_file', { file: 'app/widgets/a.ts', mode: 'fast' }).message,
      'widget file app/widgets/a.ts uses mode fast',
    );
    const rejected: [string, Record<string, unknown>][] = [
      ['missing_widget', { widget: 'has space' }],
      ['missing_widget', { widget: '' }],
      ['missing_widget', { widget: 'x'.repeat(129) }],
      ['too_many', { limit: -1 }],
      ['too_many', { limit: 1.5 }],
      ['too_many', { limit: '3' }],
      ['bad_file', { file: '/etc/passwd', mode: 'fast' }],
      ['bad_file', { file: 'C:/x', mode: 'fast' }],
      ['bad_file', { file: 'a/../../b', mode: 'fast' }],
      ['bad_file', { file: 'a\nb', mode: 'fast' }],
      ['bad_file', { file: 'a.ts', mode: 'medium' }],
    ];
    for (const [code, context] of rejected) {
      assert.throws(
        () =>
          new (WidgetErrors.Error as unknown as new (c: string, x: unknown) => Error)(
            code,
            context,
          ),
        (error: unknown) => kernelCode(error) === 'errors.invalid_context',
      );
    }
  });

  it('never echoes a rejected value', () => {
    const secret = 'sk_live_abcdef 123';
    const error = (() => {
      try {
        new (WidgetErrors.Error as unknown as new (c: string, x: unknown) => Error)(
          'missing_widget',
          { widget: secret },
        );
      } catch (thrown) {
        return thrown as JsailsError;
      }
      return undefined;
    })();
    assert.ok(error !== undefined);
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error.context).includes(secret));
  });

  it('rejects missing and undeclared context slots and unknown codes', () => {
    const Loose = WidgetErrors.Error as unknown as new (c: string, x?: unknown) => Error;
    assert.throws(
      () => new Loose('missing_widget', {}),
      (error: unknown) => kernelCode(error) === 'errors.invalid_context',
    );
    assert.throws(
      () => new Loose('plain', { extra: 'x' }),
      (error: unknown) => kernelCode(error) === 'errors.unexpected_context',
    );
    assert.throws(
      () => new Loose('no_such_code'),
      (error: unknown) => kernelCode(error) === 'errors.unknown_code',
    );
  });

  it('requires a declared payload and exposes only its declared members to clients', () => {
    const error = new WidgetErrors.Error('locked', {}, { payload: { holder: 'w-1', secret: 's' } });
    assert.deepEqual(error.payload, { holder: 'w-1', secret: 's' });
    assert.deepEqual(error.clientFields, { holder: 'w-1' });
    const Loose = WidgetErrors.Error as unknown as new (c: string, x?: unknown) => Error;
    assert.throws(
      () => new Loose('locked', {}),
      (thrown: unknown) => kernelCode(thrown) === 'errors.missing_payload',
    );
  });

  it('keeps the cause', () => {
    const cause = new Error('driver');
    assert.equal(new WidgetErrors.Error('plain', {}, { cause }).cause, cause);
  });
});

describe('defineErrors identity', () => {
  it('recognizes its codes by brand and code, not by class', () => {
    const error = new WidgetErrors.Error('plain');
    assert.equal(WidgetErrors.is(error), true);
    assert.equal(WidgetErrors.is(error, 'plain'), true);
    assert.equal(WidgetErrors.is(error, 'locked'), false);
    assert.equal(KernelErrors.is(error), false);
    assert.equal(WidgetErrors.is(new Error('plain')), false);

    const foreign = Object.assign(Object.create(null) as object, {
      [ERROR_BRAND]: true,
      code: 'test_widget.plain',
    });
    assert.equal(isJsailsError(foreign), true);
    assert.equal(WidgetErrors.is(foreign, 'plain'), true);
    assert.equal(WidgetErrors.is({ code: 'test_widget.plain' }), false);
  });

  it('does not claim an unregistered code that shares its prefix', () => {
    const lookalike = Object.assign(Object.create(null) as object, {
      [ERROR_BRAND]: true,
      code: 'test_widget.other',
    });
    assert.equal(WidgetErrors.is(lookalike), false);
  });

  it('tells a registry error from a hand-written one', () => {
    class HandWritten extends JsailsError {
      readonly code = 'hand_written';
    }
    assert.equal(isRegistryError(new WidgetErrors.Error('plain')), true);
    assert.equal(isRegistryError(new KernelErrors.Error('internal')), true);
    assert.equal(isRegistryError(new HandWritten('token=secret')), false);
    assert.equal(isRegistryError(new Error('plain')), false);
    assert.equal(isRegistryError('plain'), false);
  });
});

describe('defineErrors declaration checks', () => {
  const define = defineErrors as unknown as (domain: unknown, codes: unknown) => unknown;
  const problem = (domain: unknown, codes: unknown): string | undefined => {
    try {
      define(domain, codes);
    } catch (error) {
      assert.ok(isJsailsError(error));
      return `${error.code}:${String(error.context.problem ?? '')}`;
    }
    return undefined;
  };

  it('rejects malformed domains and code names', () => {
    assert.equal(problem('Bad-Domain', {}), 'errors.invalid_domain:');
    assert.equal(problem('', {}), 'errors.invalid_domain:');
    assert.equal(
      problem('test_decl', { BadCode: { kind: 'internal', message: 'm' } }),
      'errors.invalid_code_name:',
    );
  });

  it('rejects each malformed definition field', () => {
    const cases: [unknown, string][] = [
      [null, 'shape'],
      [{ kind: 'nope', message: 'm' }, 'kind'],
      [{ kind: 'internal', audience: 'public', message: 'm' }, 'audience'],
      [{ kind: 'internal', message: '  ' }, 'message'],
      [{ kind: 'internal', message: 'a {missing} slot' }, 'slot'],
      [{ kind: 'internal', message: 'a stray } brace' }, 'slot'],
      [{ kind: 'internal', message: 'm', context: { x: 'free-text' } }, 'context_kind'],
      [{ kind: 'internal', message: 'm', context: { x: [] } }, 'context_kind'],
      [{ kind: 'internal', message: 'm', suggestion: '' }, 'suggestion'],
      [{ kind: 'internal', message: 'm', payload: 'x' }, 'payload'],
      [{ kind: 'internal', message: 'm', payload: { expose: ['code'] } }, 'expose'],
      [{ kind: 'internal', message: 'm', payload: { expose: 'issues' } }, 'expose'],
    ];
    for (const [definition, expected] of cases) {
      assert.equal(
        problem('test_decl', { broken: definition }),
        `errors.invalid_definition:${expected}`,
      );
    }
  });

  it('checks message slots against context at compile time', () => {
    assert.throws(() =>
      // @ts-expect-error: `{name}` names no context slot.
      defineErrors('test_compile', { a: { kind: 'internal', message: 'x {name}' } }),
    );
  });
});

describe('invariant', () => {
  it('passes through a true condition and throws the code otherwise', () => {
    const value: unknown = 3;
    invariant(typeof value === 'number', WidgetErrors, 'too_many', { limit: 1 });
    assert.equal(value + 1, 4);
    assert.throws(
      () => invariant(false, WidgetErrors, 'missing_widget', { widget: 'clock' }),
      (error: unknown) => WidgetErrors.is(error, 'missing_widget'),
    );
  });
});

describe('the registry table', () => {
  it('lists every defined code with its declaration', () => {
    const codes = registeredErrorCodes();
    const missing = codes.find((entry) => entry.code === 'test_widget.missing_widget');
    assert.deepEqual(missing, {
      code: 'test_widget.missing_widget',
      kind: 'not_found',
      audience: 'operator',
      message: 'widget {widget} is not registered',
      context: { widget: 'identifier' },
      suggestion: 'register the widget in setup',
      exposes: [],
    });
    assert.deepEqual(codes.find((entry) => entry.code === 'test_widget.locked')?.exposes, [
      'holder',
    ]);
    const names = codes.map((entry) => entry.code);
    assert.deepEqual(names, [...names].sort());
  });

  it('replaces an identical redefinition and records a differing one as a conflict', () => {
    defineErrors('test_widget', WIDGET_ERRORS);
    assert.ok(!errorRegistryConflicts().includes('test_widget'));
    defineErrors('test_redefined', { a: { kind: 'internal', message: 'one' } });
    defineErrors('test_redefined', { a: { kind: 'internal', message: 'two' } });
    assert.ok(errorRegistryConflicts().includes('test_redefined'));
    assert.equal(
      registeredErrorCodes().find((entry) => entry.code === 'test_redefined.a')?.message,
      'two',
    );
  });
});
