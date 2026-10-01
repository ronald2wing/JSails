/**
 * Tests for the boundary table and the problem+json encoder: every kind in
 * both audiences answers the status, exit code, retry and log level its row
 * states; operator errors leak nothing; foreign errors (Zod, a unique
 * violation, a client abort) answer as the error kernel's design says.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import '../../src/extensions/index.js';
import { BOUNDARY_TABLE, boundaryOutcome } from '../../src/errors/boundary-table.server.js';
import type { ContextKind } from '../../src/errors/context-schema.js';
import { JsailsError } from '../../src/errors/jsails-error.js';
import { conflict, invalid, rateLimited } from '../../src/errors/kernel.js';
import {
  ERROR_KINDS,
  isRetryableKind,
  type ErrorAudience,
  type ErrorKind,
} from '../../src/errors/kinds.js';
import { registerErrorTranslator } from '../../src/errors/normalize.js';
import {
  PROBLEM_CONTENT_TYPE,
  problemResponse,
  toProblem,
} from '../../src/errors/problem.server.js';
import { defineErrors, registeredErrorCodes } from '../../src/errors/registry.js';

class KindError extends JsailsError {
  readonly code = 'test_kind';
  constructor(kind: ErrorKind, audience: ErrorAudience) {
    super('kind error message', { kind, audience, context: { secretish: 'ctx-value-zz' } });
  }
}

/** A seeded generator, so a failing property run is reproducible. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function contextValue(kind: ContextKind, next: () => number): string | number {
  if (kind === 'count') return 1_000_003 + Math.floor(next() * 1_000_000);
  if (Array.isArray(kind)) return kind[Math.floor(next() * kind.length)] ?? '';
  let id = 'v';
  for (let index = 0; index < 12; index += 1)
    id += 'abcdefghjkmnpqrstuvwxyz'[Math.floor(next() * 23)];
  return kind === 'relative-path' ? `dir/${id}.ts` : id;
}

describe('the boundary table', () => {
  it('has a row for every kind', () => {
    assert.deepEqual(Object.keys(BOUNDARY_TABLE).sort(), [...ERROR_KINDS].sort());
  });

  it('retries exactly the transient kinds, internal included', () => {
    assert.deepEqual(
      ERROR_KINDS.filter((kind) => isRetryableKind(kind)),
      ['rate_limited', 'unavailable', 'timeout', 'aborted', 'internal'],
    );
  });

  it('reads its retry column from isRetryableKind', () => {
    for (const kind of ERROR_KINDS) {
      assert.equal(BOUNDARY_TABLE[kind].retryable, isRetryableKind(kind), kind);
    }
  });

  it('answers every kind in both audiences as its row says', () => {
    for (const kind of ERROR_KINDS) {
      const row = BOUNDARY_TABLE[kind];
      const client = boundaryOutcome(new KindError(kind, 'client'));
      assert.deepEqual(
        [client.status, client.exitCode, client.retryable, client.logLevel, client.exposed],
        [row.status, row.exitCode, row.retryable, row.logLevel, true],
        kind,
      );
      const operator = boundaryOutcome(new KindError(kind, 'operator'));
      assert.deepEqual(
        [operator.status, operator.exitCode, operator.retryable, operator.logLevel],
        [row.operatorStatus, row.exitCode, row.retryable, row.operatorLogLevel],
        kind,
      );
      assert.equal(operator.exposed, false);
      const problem = toProblem(new KindError(kind, 'operator'));
      assert.equal(problem.status, row.operatorStatus, kind);
    }
  });

  it('answers operator errors 500 except unavailable, timeout, rate limit and abort', () => {
    const statuses = Object.fromEntries(
      ERROR_KINDS.map((kind) => [kind, BOUNDARY_TABLE[kind].operatorStatus]),
    );
    for (const kind of ERROR_KINDS) {
      const expected =
        kind === 'unavailable' || kind === 'rate_limited'
          ? 503
          : kind === 'timeout'
            ? 504
            : kind === 'aborted'
              ? 499
              : 500;
      assert.equal(statuses[kind], expected, kind);
    }
  });

  it('treats an error whose kind this copy does not know as internal', () => {
    const odd = new KindError('internal', 'client');
    Object.defineProperty(odd, 'kind', { value: 'from_the_future' });
    assert.equal(boundaryOutcome(odd).status, 500);
  });
});

describe('the problem+json encoder', () => {
  it('encodes a client error with detail, code, exposed members and trace id', () => {
    const problem = toProblem(conflict('email_taken'), { traceId: 'abc123' });
    assert.equal(problem.status, 409);
    assert.equal(problem.headers['content-type'], PROBLEM_CONTENT_TYPE);
    assert.deepEqual(problem.body, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'The request conflicts with the current state of the resource.',
      code: 'request.conflict',
      reason: 'email_taken',
      traceId: 'abc123',
    });
  });

  it('derives Retry-After from a rate limit, rounded up to whole seconds', () => {
    const problem = toProblem(rateLimited(1001));
    assert.equal(problem.status, 429);
    assert.equal(problem.headers['retry-after'], '2');
    assert.equal(problem.body?.retryAfterMs, undefined);
  });

  it('encodes an operator error with nothing but status, title and trace id', () => {
    const problem = toProblem(new Error('db password is hunter2'), { traceId: 't-1' });
    assert.deepEqual(problem.body, {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      traceId: 't-1',
    });
  });

  it('leaks no message, context or code of any registered operator code (property)', () => {
    defineErrors('test_boundary', {
      everything: {
        kind: 'unavailable',
        message: 'backend {name} at {file} failed {times} times in {mode} mode',
        context: {
          name: 'identifier',
          file: 'relative-path',
          times: 'count',
          mode: ['eager_mode_x', 'lazy_mode_x'],
        },
      },
    });
    const next = generator(0xbad5eed);
    const operatorCodes = registeredErrorCodes().filter((entry) => entry.audience === 'operator');
    assert.ok(operatorCodes.length > 10);
    for (const entry of operatorCodes) {
      for (let round = 0; round < 20; round += 1) {
        const context: Record<string, string | number> = {};
        for (const [slot, kind] of Object.entries(entry.context)) {
          context[slot] = contextValue(kind, next);
        }
        const [domain = '', code = ''] = entry.code.split('.');
        const registry = defineErrorsLookup(domain);
        const error = registry(code, context);
        const problem = toProblem(error, { traceId: 'trace' });
        if (problem.body === undefined) {
          assert.equal(error.kind, 'aborted');
          continue;
        }
        const body = JSON.stringify(problem.body);
        assert.ok(!body.includes(error.message), `${entry.code} leaks its message`);
        assert.ok(!body.includes(entry.code), `${entry.code} leaks its code`);
        for (const value of Object.values(context)) {
          if (typeof value === 'string' && value.length < 6) continue;
          assert.ok(!body.includes(String(value)), `${entry.code} leaks context`);
        }
        assert.deepEqual(Object.keys(JSON.parse(body) as object).sort(), [
          'status',
          'title',
          'traceId',
          'type',
        ]);
      }
    }
  });
});

/**
 * Rebuild a registered code's error through a fresh registry with the same
 * declaration, so the property covers every code without importing each
 * registry's module by name.
 */
function defineErrorsLookup(domain: string): (code: string, context: object) => JsailsError {
  const codes = Object.fromEntries(
    registeredErrorCodes()
      .filter((entry) => entry.code.startsWith(`${domain}.`))
      .map((entry) => [
        entry.code.slice(domain.length + 1),
        {
          kind: entry.kind,
          audience: entry.audience,
          message: entry.message,
          context: entry.context,
          ...(entry.suggestion === undefined ? {} : { suggestion: entry.suggestion }),
          ...(entry.exposes.length === 0 ? {} : { payload: { expose: entry.exposes } }),
        },
      ]),
  );
  const registry = (
    defineErrors as unknown as (
      d: string,
      c: object,
    ) => {
      Error: new (code: string, context: object, options: object) => JsailsError;
    }
  )(domain, codes);
  return (code, context) => new registry.Error(code, context, { payload: {} });
}

describe('foreign errors at the boundary', () => {
  it('answers a failed z.parse 422 with its issues', () => {
    let thrown: unknown;
    try {
      z.object({ title: z.string().min(3) }).parse({ title: 'x' });
    } catch (error) {
      thrown = error;
    }
    const problem = toProblem(thrown);
    assert.equal(problem.status, 422);
    assert.equal(problem.body?.code, 'request.invalid');
    assert.deepEqual(
      (problem.body?.issues as { path: unknown[]; code: string }[]).map((issue) => [
        issue.path,
        issue.code,
      ]),
      [[['title'], 'too_small']],
    );
  });

  it('answers a unique violation 500 by default and 409 when a resource opts in', () => {
    const violation = new QueryFailedError(
      'INSERT …',
      [],
      Object.assign(new Error('driver'), { code: '23505' }),
    );
    assert.equal(toProblem(violation).status, 500);
    assert.equal(toProblem(violation).body?.code, undefined);

    const optIn = registerErrorTranslator((error) =>
      error === violation ? conflict('email_taken') : undefined,
    );
    try {
      const problem = toProblem(violation);
      assert.equal(problem.status, 409);
      assert.equal(problem.body?.reason, 'email_taken');
    } finally {
      optIn();
    }
  });

  it('answers a client abort with no body and no log', async () => {
    const outcome = boundaryOutcome(new DOMException('client went away', 'AbortError'));
    assert.equal(outcome.logLevel, 'none');
    const response = problemResponse(new DOMException('client went away', 'AbortError'));
    assert.equal(response.status, 499);
    assert.equal(await response.text(), '');
  });

  it('writes a problem response with the problem media type', async () => {
    const response = problemResponse(invalid([{ path: ['a'], code: 'required' }]));
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('content-type'), PROBLEM_CONTENT_TYPE);
    const body = (await response.json()) as { issues: unknown[] };
    assert.deepEqual(body.issues, [{ path: ['a'], code: 'required' }]);
  });
});
