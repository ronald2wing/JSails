/**
 * Tests for the base error's `context` and `suggestion` fields, and for the
 * `hint:` line `formatError` renders from a suggestion.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsailsError } from '../../src/errors/jsails-error.js';
import { formatError } from '../../src/errors/inspect.js';

/** A minimal subclass, the shape every framework error follows. */
class SampleError extends JsailsError {
  constructor(
    readonly code: 'sample',
    message: string,
    options?: ConstructorParameters<typeof JsailsError>[1],
  ) {
    super(message, options);
  }
}

describe('JsailsError context and suggestion', () => {
  it('defaults to an empty context and no suggestion', () => {
    const error = new SampleError('sample', 'it failed');
    assert.deepEqual(error.context, {});
    assert.equal(error.suggestion, undefined);
    assert.equal(error.name, 'SampleError');
  });

  it('carries a context record and a suggestion', () => {
    const error = new SampleError('sample', 'it failed', {
      context: { route: '/blog', status: 500 },
      suggestion: 'check the database',
    });
    assert.deepEqual(error.context, { route: '/blog', status: 500 });
    assert.equal(error.suggestion, 'check the database');
  });

  it('keeps the cause when one is given', () => {
    const cause = new Error('inner');
    const error = new SampleError('sample', 'outer', { cause });
    assert.equal(error.cause, cause);
  });

  it('does not set a cause key when none is given', () => {
    const error = new SampleError('sample', 'outer');
    assert.equal('cause' in error, false);
  });
});

describe('formatError with a suggestion', () => {
  it('appends the suggestion as a hint line', () => {
    const error = new SampleError('sample', 'it failed', { suggestion: 'run the build' });
    assert.equal(formatError(error), 'it failed\n  hint: run the build');
  });

  it('renders the message alone when there is no suggestion', () => {
    assert.equal(formatError(new SampleError('sample', 'it failed')), 'it failed');
  });

  it('renders the message alone for an empty suggestion', () => {
    const error = new SampleError('sample', 'it failed', { suggestion: '' });
    assert.equal(formatError(error), 'it failed');
  });

  it('honours the allow predicate before rendering a hint', () => {
    const error = new SampleError('sample', 'it failed', { suggestion: 'run the build' });
    assert.equal(
      formatError(error, { allow: () => false, fallback: 'the command failed' }),
      'the command failed',
    );
  });

  it('reads a suggestion structurally, so a non-JsailsError gets the same rendering', () => {
    const error = Object.assign(new Error('it failed'), { suggestion: 'run the build' });
    assert.equal(formatError(error), 'it failed\n  hint: run the build');
  });
});
