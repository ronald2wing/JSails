/**
 * The `inputRequired` builder: wire shapes of form and URL requests, the
 * restricted elicitation shape, key, message, URL, and state rules, opaque
 * handles that cannot be forged, and form schemas projected once.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { McpDefinitionError } from '../src/errors.js';
import {
  CONFIRM_KEY,
  confirmationRequest,
  inputRequired,
  inputRequiredRecord,
  type McpInputRequiredSpec,
} from '../src/input-required.js';

function invalid(error: unknown): boolean {
  return error instanceof McpDefinitionError && error.code === 'invalid_input_request';
}

describe('inputRequired', () => {
  it('builds form and URL requests in their wire shape', () => {
    const handle = inputRequired({
      requests: {
        name: {
          mode: 'form',
          message: 'Your name?',
          schema: z.object({
            name: z.string().describe('Full name'),
            age: z.number().int().optional(),
          }),
        },
        login: { mode: 'url', message: 'Sign in', url: 'https://auth.example.com/start?x=1' },
      },
      state: { step: 1 },
    });
    assert.deepEqual(handle, { kind: 'input-required' });
    assert.ok(Object.isFrozen(handle));
    const record = inputRequiredRecord(handle);
    assert.ok(record);
    assert.deepEqual(record.state, { step: 1 });
    const name = record.requests?.name as { method: string; params: Record<string, unknown> };
    assert.equal(name.method, 'elicitation/create');
    assert.equal(name.params.message, 'Your name?');
    const requested = name.params.requestedSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(requested.type, 'object');
    assert.deepEqual(Object.keys(requested.properties).sort(), ['age', 'name']);
    assert.deepEqual(requested.required, ['name']);
    const login = record.requests?.login as { params: Record<string, unknown> };
    assert.deepEqual(
      [login.params.mode, login.params.url],
      ['url', 'https://auth.example.com/start?x=1'],
    );
  });

  it('carries state alone, copied so later edits do not leak in', () => {
    const state = { items: [1, 2] };
    const handle = inputRequired({ state });
    state.items.push(3);
    assert.deepEqual(inputRequiredRecord(handle), {
      requests: undefined,
      state: { items: [1, 2] },
    });
    assert.deepEqual(inputRequiredRecord(inputRequired({ requests: {}, state: 0 }))?.state, 0);
  });

  it('rejects malformed specs', () => {
    const form = { mode: 'form', message: 'm', schema: z.object({ a: z.string() }) } as const;
    const cases: unknown[] = [
      undefined,
      {},
      { requests: {} },
      { other: 1, state: 1 },
      { requests: [] },
      { requests: { 'bad key': form } },
      { requests: { [CONFIRM_KEY]: form } },
      { requests: { 'jsails.mine': form } },
      { requests: { ['k'.repeat(65)]: form } },
      { requests: { a: { ...form, message: '' } } },
      { requests: { a: { ...form, message: 'x'.repeat(4097) } } },
      { requests: { a: { ...form, mode: 'sampling' } } },
      { requests: { a: 'text' } },
      { requests: { a: { ...form, schema: z.object({ nested: z.object({ b: z.string() }) }) } } },
      { requests: { a: { ...form, schema: z.string() } } },
      { requests: { a: { ...form, schema: { not: 'a schema' } } } },
      { requests: { a: { mode: 'url', message: 'm', url: 'http://auth.example.com/' } } },
      { requests: { a: { mode: 'url', message: 'm', url: 'javascript:alert(1)' } } },
      { requests: { a: { mode: 'url', message: 'm', url: 'https://user:pw@auth.example.com/' } } },
      { requests: { a: { mode: 'url', message: 'm', url: '/relative' } } },
      { state: () => 1 },
      { state: Number.NaN },
      { state: 'x'.repeat(16_385) },
    ];
    for (const spec of cases) {
      assert.throws(
        () => inputRequired(spec as McpInputRequiredSpec),
        invalid,
        JSON.stringify(spec),
      );
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => inputRequired({ state: cyclic as never }), invalid);
  });

  it('allows http URLs on loopback hosts', () => {
    for (const url of ['http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://[::1]/cb']) {
      assert.ok(
        inputRequiredRecord(inputRequired({ requests: { a: { mode: 'url', message: 'm', url } } })),
      );
    }
  });

  it('cannot be forged and projects a form schema once', () => {
    assert.equal(inputRequiredRecord({ kind: 'input-required' }), undefined);
    assert.equal(inputRequiredRecord(null), undefined);
    const schema = z.object({ ok: z.boolean() });
    const original = schema['~standard'].jsonSchema.input;
    let projections = 0;
    const counted = {
      '~standard': {
        ...schema['~standard'],
        jsonSchema: {
          ...schema['~standard'].jsonSchema,
          input: (options: { readonly target: 'draft-2020-12' }) => {
            projections += 1;
            return original(options);
          },
        },
      },
    };
    for (let round = 0; round < 3; round += 1) {
      inputRequired({
        requests: { a: { mode: 'form', message: `round ${round}`, schema: counted } },
      });
    }
    assert.equal(projections, 1);
  });

  it('builds the confirmation request as one required boolean', () => {
    const request = confirmationRequest('Delete everything?') as {
      params: Record<string, unknown>;
    };
    assert.equal(request.params.message, 'Delete everything?');
    assert.deepEqual((request.params.requestedSchema as { required: string[] }).required, [
      'confirm',
    ]);
    assert.throws(() => confirmationRequest(''), invalid);
  });
});
