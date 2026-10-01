/**
 * `JsailsError`: the `name` follows the subclass and `code` is a stable string.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsailsError } from '../../src/errors/jsails-error.js';

class DemoError extends JsailsError {
  readonly code = 'demo_code';
}

describe('JsailsError', () => {
  it("sets name to the subclass's own class name", () => {
    const err = new DemoError('boom');
    assert.equal(err.name, 'DemoError');
  });

  it('is an instance of JsailsError and Error', () => {
    const err = new DemoError('boom');
    assert.ok(err instanceof JsailsError);
    assert.ok(err instanceof Error);
  });

  it('has the stable code from the subclass', () => {
    const err = new DemoError('boom');
    assert.equal(err.code, 'demo_code');
    assert.ok(typeof err.code === 'string' && err.code.length > 0);
  });

  it('round-trips cause when passed', () => {
    const original = new Error('inner');
    const err = new DemoError('boom', { cause: original });
    assert.equal(err.cause, original);
  });

  it('preserves the exact message (value-free — no input interpolation)', () => {
    const err = new DemoError('operation_failed');
    assert.equal(err.message, 'operation_failed');
    assert.ok(!err.message.includes('secret'));
  });

  it('has correct prototype chain', () => {
    assert.ok(Object.getPrototypeOf(DemoError.prototype) === JsailsError.prototype);
  });
});
