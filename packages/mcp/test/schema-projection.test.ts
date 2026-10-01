/**
 * Schema projection: JSON Schema emission and checks, the pass-through wire
 * schema, value-free validation paths, the x-mcp-header rules, and a seeded
 * property that projected zod schemas compile and agree with zod on random
 * values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { z } from 'zod';

import { McpDefinitionError } from '../src/errors.js';
import {
  EMPTY_INPUT_JSON,
  isMcpSchema,
  projectSchema,
  scanHeaderDeclarations,
  validateValue,
  wireSchema,
} from '../src/schema-projection.js';
import { forAll, type Gen } from './fixtures.js';

describe('projectSchema', () => {
  it('projects a zod object once into a frozen 2020-12 document', () => {
    const projected = projectSchema(
      z.object({ a: z.string(), b: z.number().optional() }),
      'input',
      't',
    );
    assert.equal(projected.json.type, 'object');
    assert.deepEqual(projected.json.required, ['a']);
    assert.ok(Object.isFrozen(projected.json));
    assert.ok(Object.isFrozen(projected.json.properties));
  });

  it('defaults a typeless input root to object and rejects a non-object input root', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ]);
    assert.equal(projectSchema(union, 'input', 't').json.type, 'object');
    assert.throws(() => projectSchema(z.number(), 'input', 't'), McpDefinitionError);
    assert.equal(projectSchema(z.number(), 'output', 't').json.type, 'number');
  });

  it('rejects a schema that cannot be projected or is not a schema', () => {
    assert.throws(
      () => projectSchema(z.object({ d: z.date() }), 'output', 't'),
      McpDefinitionError,
    );
    assert.throws(
      () => projectSchema({ '~standard': { version: 1 } }, 'input', 't'),
      McpDefinitionError,
    );
    const lying = {
      '~standard': {
        version: 1,
        vendor: 'x',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: 'object', properties: { a: { type: 'nonsense' } } }),
          output: () => ({}),
        },
      },
    };
    assert.throws(() => projectSchema(lying, 'input', 't'), /does not compile/);
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    const cyclicSchema = {
      '~standard': {
        version: 1,
        vendor: 'x',
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => cyclic, output: () => cyclic },
      },
    };
    assert.throws(() => projectSchema(cyclicSchema, 'input', 't'), /not plain JSON/);
  });

  it('recognises Standard JSON schemas only', () => {
    assert.equal(isMcpSchema(z.object({})), true);
    assert.equal(isMcpSchema({ type: 'object' }), false);
    assert.equal(isMcpSchema(null), false);
  });
});

describe('wireSchema', () => {
  it('advertises the document and accepts every value', async () => {
    const wire = wireSchema(EMPTY_INPUT_JSON);
    const emitted = wire['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    assert.deepEqual(emitted, { type: 'object', properties: {}, additionalProperties: false });
    assert.notEqual(emitted, EMPTY_INPUT_JSON);
    assert.deepEqual(await wire['~standard'].validate({ anything: 1 }), { value: { anything: 1 } });
  });
});

describe('validateValue', () => {
  it('returns the parsed value', async () => {
    const result = await validateValue(z.object({ n: z.coerce.number() }), { n: '4' });
    assert.deepEqual(result, { ok: true, value: { n: 4 } });
  });

  it('reports failing paths without echoing caller-chosen keys or values', async () => {
    const schema = z.object({
      items: z.array(z.object({ id: z.string() })),
      tags: z.record(z.string(), z.number()),
    });
    const result = await validateValue(schema, {
      items: [{ id: 5 }],
      tags: { 'SECRET token=abc': 'not-a-number' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.paths, ['items.0.id', 'tags.*']);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    }
  });

  it('reports a root failure', async () => {
    const result = await validateValue(z.object({}), 'nope');
    assert.deepEqual(result, { ok: false, paths: ['(root)'] });
  });
});

describe('scanHeaderDeclarations', () => {
  it('accepts reachable primitive declarations', () => {
    const json = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        nested: {
          type: 'object',
          properties: { count: { type: 'integer', 'x-mcp-header': 'Count' } },
        },
      },
    };
    assert.equal(scanHeaderDeclarations(json), undefined);
  });

  it('rejects every rule violation', () => {
    const cases: Record<string, unknown>[] = [
      { type: 'object', 'x-mcp-header': 'Root' },
      { type: 'object', properties: { a: { type: 'number', 'x-mcp-header': 'A' } } },
      { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': '' } } },
      { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Bad\r\nName' } } },
      {
        type: 'object',
        properties: {
          a: { type: 'string', 'x-mcp-header': 'X' },
          b: { type: 'string', 'x-mcp-header': 'x' },
        },
      },
      {
        type: 'object',
        properties: { a: { type: 'array', items: { type: 'string', 'x-mcp-header': 'A' } } },
      },
      { type: 'object', anyOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] },
      { type: 'object', $defs: { a: { type: 'string', 'x-mcp-header': 'A' } } },
    ];
    for (const json of cases) {
      assert.equal(typeof scanHeaderDeclarations(json), 'string', JSON.stringify(json));
    }
  });
});

/** A random zod field and a value generator that sometimes violates it. */
function randomField(gen: Gen): { schema: z.ZodType; sample: () => unknown } {
  switch (gen.int(0, 5)) {
    case 0: {
      const min = gen.int(0, 3);
      return { schema: z.string().min(min), sample: () => gen.pick(['', 'a', 'abcd', 7, null]) };
    }
    case 1:
      return {
        schema: z.number().int().min(-2).max(5),
        sample: () => gen.pick([0, 3, 9, -3, 1.5, 'x']),
      };
    case 2:
      return { schema: z.boolean(), sample: () => gen.pick([true, false, 'true', 0]) };
    case 3:
      return {
        schema: z.enum(['red', 'blue']),
        sample: () => gen.pick(['red', 'blue', 'green', 1]),
      };
    case 4:
      return {
        schema: z.array(z.string()).max(2),
        sample: () => gen.pick([[], ['a'], ['a', 'b', 'c'], [1], 'a']),
      };
    default:
      return { schema: z.string().optional(), sample: () => gen.pick([undefined, 'v', 3]) };
  }
}

describe('projection property', () => {
  it('projects random zod objects to schemas Ajv compiles and agrees with zod on random values', async () => {
    const ajv = new AjvJsonSchemaValidator();
    await forAll(0x6d63_7001, 300, async (gen) => {
      const fields: Record<string, ReturnType<typeof randomField>> = {};
      for (let index = 0; index < gen.int(0, 4); index += 1) {
        fields[`f${index}`] = randomField(gen);
      }
      const schema = z.strictObject(
        Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])),
      );
      const projected = projectSchema(schema, 'input', 'property');
      const check = ajv.getValidator(structuredClone(projected.json));
      for (let sample = 0; sample < 5; sample += 1) {
        const value: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(fields)) {
          const entry = field.sample();
          if (entry !== undefined) {
            value[key] = entry;
          }
        }
        const zodAccepts = schema.safeParse(value).success;
        const outcome = await validateValue(schema, value);
        assert.equal(outcome.ok, zodAccepts);
        assert.equal(
          check(value).valid,
          zodAccepts,
          `ajv and zod disagree on ${JSON.stringify(value)}`,
        );
      }
    });
  });
});
