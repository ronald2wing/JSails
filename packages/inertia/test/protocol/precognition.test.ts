/**
 * Precognition answers (P-6 Response Headers, P-18 HTTP Status Codes; clause
 * numbering as in props.test.ts), checked against the rules the
 * laravel-precognition client applies to a response, transcribed from its
 * shipped `dist`:
 *
 * - `client.js` `validatePrecognitionResponse`: `headers.precognition === 'true'`;
 * - `client.js` `successResolver`: `status === 204 && headers['precognition-success'] === 'true'`;
 * - `http/fetchClient.js`: the body is parsed only when the content type contains
 *   `application/json`;
 * - `validator.js` `onValidationError`: errors are read from `response.data.errors`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ValidationIssue } from 'jsails/api';

import {
  isPrecognitive,
  outcomeToResponse,
  precognition,
  precognitionValidateOnly,
  type InertiaOutcome,
} from '../../src/index.js';
import { facts, header } from './engine-fixture.js';

const ISSUES: readonly ValidationIssue[] = [
  { path: ['name'], code: 'required', message: 'The name field is required.' },
  { path: ['email'], code: 'email', message: 'The email must be valid.' },
  { path: ['email'], code: 'max', message: 'The email is too long.' },
  { path: ['items', 0, 'name'], code: 'required', message: 'Item name required.' },
  { path: ['tags', 2], code: 'max', message: 'Tag too long.' },
];

function precognitive(validateOnly?: string): ReturnType<typeof facts> {
  return facts(
    '/users',
    {
      Precognition: 'true',
      ...(validateOnly === undefined ? {} : { 'Precognition-Validate-Only': validateOnly }),
    },
    { method: 'POST' },
  );
}

/** The client's acceptance rules, as plain predicates over the response. */
async function clientView(outcome: InertiaOutcome): Promise<{
  readonly accepted: boolean;
  readonly success: boolean;
  readonly errors: unknown;
}> {
  const response = outcomeToResponse(outcome);
  const contentType = response.headers.get('content-type');
  const data: unknown =
    contentType?.includes('application/json') === true ? await response.json() : null;
  return {
    accepted: response.headers.get('precognition') === 'true',
    success: response.status === 204 && response.headers.get('precognition-success') === 'true',
    errors: typeof data === 'object' && data !== null && 'errors' in data ? data.errors : undefined,
  };
}

describe('precognition', () => {
  it('ignores a request that is not precognitive', () => {
    assert.equal(precognition(facts('/users', {}, { method: 'POST' }), ISSUES), null);
    assert.equal(isPrecognitive(new Headers({ Precognition: 'false' })), false);
    assert.equal(isPrecognitive(new Headers({ Precognition: ' TRUE ' })), true);
  });

  it('answers a passing validation with 204 and Precognition-Success', async () => {
    const outcome = precognition(precognitive(), null);
    assert.ok(outcome !== null);
    assert.equal(outcome.status, 204);
    assert.equal(outcome.body, null);
    assert.equal(header(outcome, 'vary'), 'X-Inertia, Precognition');
    assert.equal(header(outcome, 'cache-control'), 'private, no-store');
    assert.deepEqual(await clientView(outcome), {
      accepted: true,
      success: true,
      errors: undefined,
    });
    assert.equal(precognition(precognitive(), [])?.status, 204);
  });

  it('answers a failing validation with 422 application/json { message, errors[] }', async () => {
    const outcome = precognition(precognitive(), ISSUES);
    assert.ok(outcome !== null);
    assert.equal(outcome.status, 422);
    assert.equal(header(outcome, 'content-type'), 'application/json');
    assert.deepEqual(JSON.parse(outcome.body ?? ''), {
      message: 'The name field is required. (and 4 more errors)',
      errors: {
        name: ['The name field is required.'],
        email: ['The email must be valid.', 'The email is too long.'],
        'items.0.name': ['Item name required.'],
        'tags.2': ['Tag too long.'],
      },
    });
    const view = await clientView(outcome);
    assert.equal(view.accepted, true);
    assert.equal(view.success, false);
  });

  it('counts only Precognition-Validate-Only fields, with wildcards and descendants', async () => {
    const emailOnly = precognition(precognitive('email'), ISSUES);
    assert.ok(emailOnly !== null);
    assert.deepEqual(JSON.parse(emailOnly.body ?? ''), {
      message: 'The email must be valid. (and 1 more error)',
      errors: { email: ['The email must be valid.', 'The email is too long.'] },
    });
    const nested = precognition(precognitive('items.*.name, tags'), ISSUES);
    assert.ok(nested !== null);
    assert.deepEqual((await clientView(nested)).errors, {
      'items.0.name': ['Item name required.'],
      'tags.2': ['Tag too long.'],
    });
    const untouched = precognition(precognitive('password'), ISSUES);
    assert.equal(untouched?.status, 204);
  });

  it('reads the validate-only list, treating an empty one as everything', () => {
    assert.deepEqual(
      precognitionValidateOnly(new Headers({ 'Precognition-Validate-Only': 'a, b.c,' })),
      ['a', 'b.c'],
    );
    assert.equal(
      precognitionValidateOnly(new Headers({ 'Precognition-Validate-Only': ' , ' })),
      null,
    );
    assert.equal(precognitionValidateOnly(new Headers()), null);
  });
});
