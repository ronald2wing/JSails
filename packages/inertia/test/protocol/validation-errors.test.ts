/**
 * Validation errors (P-17 Validation Errors; clause numbering as in
 * props.test.ts): issue paths to dotted keys, the failed-mutation `303` with
 * the errors carried, and error-bag wrapping at write time, when the failing
 * request still carries `X-Inertia-Error-Bag`
 * (inertia-laravel `MiddlewareTest::test_validation_errors_are_scoped_to_error_bag_header`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationError, type ValidationIssue } from 'jsails/api';

import {
  resolveInertia,
  toInertiaErrors,
  validationFailure,
  validationIssuesOf,
  FORM_ERROR_KEY,
} from '../../src/index.js';
import { cookieAfter, engine, facts, header, inertiaHeaders, TestClock } from './engine-fixture.js';

const ISSUES: readonly ValidationIssue[] = [
  { path: ['name'], code: 'required', message: 'The name field is required.' },
  { path: ['user', 'tags', 2], code: 'max', message: 'Too long.' },
  { path: ['user', 'tags', 2], code: 'pattern', message: 'Bad characters.' },
];

describe('toInertiaErrors', () => {
  it('keys errors by dotted path with the first message', () => {
    assert.deepEqual(toInertiaErrors(ISSUES), {
      name: 'The name field is required.',
      'user.tags.2': 'Too long.',
    });
  });

  it('keeps every message with allMessages', () => {
    assert.deepEqual(toInertiaErrors(ISSUES, { allMessages: true }), {
      name: ['The name field is required.'],
      'user.tags.2': ['Too long.', 'Bad characters.'],
    });
  });

  it('files root and prototype-key issues under the form-level key', () => {
    const errors = toInertiaErrors([
      { path: [], code: 'type', message: 'Expected an object.' },
      { path: ['__proto__'], code: 'unknown_field', message: 'Unknown field.' },
    ]);
    assert.deepEqual(Object.keys(errors), [FORM_ERROR_KEY]);
    assert.equal(errors[FORM_ERROR_KEY], 'Expected an object.');
    assert.equal(Object.getPrototypeOf(errors), Object.prototype);
  });

  it('reads the issues of a core ValidationError only', () => {
    assert.deepEqual(validationIssuesOf(new ValidationError(ISSUES)), ISSUES);
    assert.equal(validationIssuesOf(new Error('x')), null);
    assert.equal(validationIssuesOf({ issues: ISSUES }), null);
  });
});

describe('validationFailure', () => {
  const form = 'https://example.test/users/create';

  it('redirects a failed Inertia mutation back with 303 and the errors carried', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const outcome = await validationFailure(
      config,
      facts('/users', inertiaHeaders({ Referer: form }), { method: 'POST' }),
      ISSUES,
    );
    assert.ok(outcome !== null);
    assert.equal(outcome.status, 303);
    assert.equal(header(outcome, 'location'), '/users/create');
    assert.equal(header(outcome, 'cache-control'), 'private, no-store');
    const cookie = cookieAfter(outcome);
    assert.ok(cookie !== null);

    const page = await resolveInertia(
      config,
      facts('/users/create', inertiaHeaders({ Cookie: cookie })),
      {
        component: 'Users/Create',
        props: {},
      },
    );
    assert.ok(page.kind === 'page');
    assert.deepEqual(page.page.props.errors, {
      name: 'The name field is required.',
      'user.tags.2': 'Too long.',
    });
  });

  it('wraps the errors under the bag of the failing request, not of the next GET', async () => {
    const config = engine();
    const outcome = await validationFailure(
      config,
      facts('/users', inertiaHeaders({ Referer: form, 'X-Inertia-Error-Bag': 'createUser' }), {
        method: 'PUT',
      }),
      ISSUES.slice(0, 1),
    );
    const cookie = outcome === null ? null : cookieAfter(outcome);
    assert.ok(cookie !== null);
    const page = await resolveInertia(
      config,
      facts('/users/create', inertiaHeaders({ Cookie: cookie })),
      {
        component: 'Users/Create',
        props: {},
      },
    );
    assert.ok(page.kind === 'page');
    assert.deepEqual(page.page.props.errors, {
      createUser: { name: 'The name field is required.' },
    });
  });

  it('carries every message when configured with allMessages', async () => {
    const config = engine(undefined, { errors: { allMessages: true } });
    const outcome = await validationFailure(
      config,
      facts('/users', inertiaHeaders(), { method: 'PATCH' }),
      ISSUES,
    );
    assert.ok(outcome !== null);
    const cookie = cookieAfter(outcome);
    assert.ok(cookie !== null);
    assert.equal(header(outcome, 'location'), '/');
    const page = await resolveInertia(config, facts('/', inertiaHeaders({ Cookie: cookie })), {
      component: 'Home',
      props: {},
    });
    assert.ok(page.kind === 'page');
    assert.deepEqual(page.page.props.errors['user.tags.2'], ['Too long.', 'Bad characters.']);
  });

  it('leaves GET, HEAD, non-Inertia, Precognition, and issue-free failures to the caller', async () => {
    const config = engine();
    for (const requestFacts of [
      facts('/', inertiaHeaders()),
      facts('/', inertiaHeaders(), { method: 'HEAD' }),
      facts('/', {}, { method: 'POST' }),
      facts('/', inertiaHeaders({ Precognition: 'true' }), { method: 'POST' }),
    ]) {
      assert.equal(await validationFailure(config, requestFacts, ISSUES), null);
    }
    assert.equal(
      await validationFailure(config, facts('/', inertiaHeaders(), { method: 'POST' }), []),
      null,
    );
  });
});
