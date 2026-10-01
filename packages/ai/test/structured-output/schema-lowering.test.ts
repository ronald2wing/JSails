/**
 * Schema lowering tests: targeted cases per profile, plus seeded property
 * tests over generated Zod schemas proving subset membership (every lowered
 * schema stays inside the profile's keyword subset), soundness (every value
 * Zod accepts is accepted by the lowered schema, after the profile's
 * encoding), and the OpenAI restore round trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { AiError } from '../../src/errors/ai-error.js';
import {
  lowerJsonSchema,
  lowerZodSchema,
  zodInputJsonSchema,
  type AiSchemaProfile,
} from '../../src/structured-output/schema-lowering.js';
import { matchesLowered, type JsonSchema } from '../../src/structured-output/schema-restore.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENAI_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

const ANTHROPIC_FORMATS = new Set([...OPENAI_FORMATS, 'uri']);

/** The constraint keywords OpenAI strict mode enforces on the wire. */
const OPENAI_CONSTRAINTS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'minItems',
  'maxItems',
];

/** Assert `schema` uses only the keywords and shapes `profile` allows. */
function assertInSubset(
  schema: unknown,
  profile: 'anthropic-strict' | 'openai-strict',
  isRoot = true,
): void {
  assert.ok(typeof schema === 'object' && schema !== null && !Array.isArray(schema), 'schema node');
  const node = schema as Record<string, unknown>;
  const allowed = new Set([
    'type',
    'enum',
    'const',
    'anyOf',
    'description',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'format',
    '$ref',
  ]);
  if (profile === 'anthropic-strict') allowed.add('minItems');
  else for (const keyword of OPENAI_CONSTRAINTS) allowed.add(keyword);
  if (isRoot) allowed.add('$defs');
  for (const key of Object.keys(node))
    assert.ok(allowed.has(key), `keyword ${key} outside ${profile}`);
  const formats = profile === 'openai-strict' ? OPENAI_FORMATS : ANTHROPIC_FORMATS;
  if (node.format !== undefined) assert.ok(formats.has(node.format as string));
  if (profile === 'anthropic-strict' && node.minItems !== undefined) {
    assert.equal(node.minItems, 1);
  }
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false);
    const properties = node.properties as Record<string, unknown>;
    const required = node.required as string[];
    for (const key of required) assert.ok(Object.hasOwn(properties, key));
    if (profile === 'openai-strict') assert.deepEqual(required, Object.keys(properties));
    for (const child of Object.values(properties)) assertInSubset(child, profile, false);
  }
  if (node.type === 'array') assertInSubset(node.items, profile, false);
  if (Array.isArray(node.anyOf))
    for (const branch of node.anyOf) assertInSubset(branch, profile, false);
  if (isRoot && node.$defs !== undefined) {
    for (const definition of Object.values(node.$defs as Record<string, unknown>))
      assertInSubset(definition, profile, false);
  }
}

interface Generated {
  readonly schema: z.ZodType;
  /** Whether the schema accepts null (so an optional wrapper would be ambiguous). */
  readonly nullable: boolean;
  /** A valid value and its openai-strict encoding. */
  sample(random: () => number): { value: unknown; encoded: unknown };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function generate(random: () => number, depth: number): Generated {
  const kinds =
    depth <= 0
      ? ['string', 'number', 'int', 'boolean', 'enum', 'literal', 'email', 'pattern']
      : [
          'pattern',
          'string',
          'number',
          'int',
          'boolean',
          'enum',
          'literal',
          'email',
          'nullable',
          'array',
          'object',
          'object',
          'union',
        ];
  const kind = pick(random, kinds);
  const same = (value: unknown): { value: unknown; encoded: unknown } => ({
    value,
    encoded: value,
  });
  switch (kind) {
    case 'string': {
      const min = Math.floor(random() * 3);
      const max = min + Math.floor(random() * 3);
      return {
        schema: z.string().min(min).max(max),
        nullable: false,
        sample: (r) => same('x'.repeat(min + Math.floor(r() * (max - min + 1)))),
      };
    }
    case 'number':
      return {
        schema: z.number().min(-5).max(5),
        nullable: false,
        sample: (r) => same(r() * 10 - 5),
      };
    case 'int':
      return {
        schema: z.int().positive(),
        nullable: false,
        sample: (r) => same(1 + Math.floor(r() * 100)),
      };
    case 'boolean':
      return { schema: z.boolean(), nullable: false, sample: (r) => same(r() < 0.5) };
    case 'enum':
      return {
        schema: z.enum(['red', 'green', 'blue']),
        nullable: false,
        sample: (r) => same(pick(r, ['red', 'green', 'blue'])),
      };
    case 'literal':
      return { schema: z.literal('fixed'), nullable: false, sample: () => same('fixed') };
    case 'email':
      return { schema: z.email(), nullable: false, sample: () => same('ada@example.com') };
    case 'pattern':
      return {
        schema: z.string().regex(/^ab+$/),
        nullable: false,
        sample: (r) => same(`a${'b'.repeat(1 + Math.floor(r() * 4))}`),
      };
    case 'nullable': {
      const inner = generate(random, depth - 1);
      return {
        schema: inner.schema.nullable(),
        nullable: true,
        sample: (r) => (r() < 0.3 ? same(null) : inner.sample(r)),
      };
    }
    case 'array': {
      const inner = generate(random, depth - 1);
      const min = Math.floor(random() * 3);
      return {
        schema: z
          .array(inner.schema)
          .min(min)
          .max(min + 2),
        nullable: false,
        sample: (r) => {
          const items = Array.from({ length: min + Math.floor(r() * 3) }, () => inner.sample(r));
          return {
            value: items.map((item) => item.value),
            encoded: items.map((item) => item.encoded),
          };
        },
      };
    }
    case 'object': {
      const count = 1 + Math.floor(random() * 4);
      const fields = Array.from({ length: count }, (_, index) => {
        const inner = generate(random, depth - 1);
        const optional = !inner.nullable && random() < 0.5;
        return { key: `f${index}`, inner, optional };
      });
      const shape: Record<string, z.ZodType> = {};
      for (const field of fields)
        shape[field.key] = field.optional ? field.inner.schema.optional() : field.inner.schema;
      return {
        schema: z.object(shape),
        nullable: false,
        sample: (r) => {
          const value: Record<string, unknown> = {};
          const encoded: Record<string, unknown> = {};
          for (const field of fields) {
            if (field.optional && r() < 0.5) {
              encoded[field.key] = null;
              continue;
            }
            const item = field.inner.sample(r);
            value[field.key] = item.value;
            encoded[field.key] = item.encoded;
          }
          return { value, encoded };
        },
      };
    }
    default: {
      const branches = ['a', 'b'].map((tag) => {
        const inner = generate(random, depth - 1);
        const optional = !inner.nullable && random() < 0.5;
        return { tag, inner, optional };
      });
      const schemas = branches.map((branch) =>
        z.object({
          kind: z.literal(branch.tag),
          body: branch.optional ? branch.inner.schema.optional() : branch.inner.schema,
        }),
      );
      return {
        schema: z.discriminatedUnion('kind', [
          schemas[0] as z.ZodObject<{ kind: z.ZodLiteral<string> }>,
          schemas[1] as z.ZodObject<{ kind: z.ZodLiteral<string> }>,
        ]),
        nullable: false,
        sample: (r) => {
          const branch = pick(r, branches);
          if (branch.optional && r() < 0.5)
            return { value: { kind: branch.tag }, encoded: { kind: branch.tag, body: null } };
          const item = branch.inner.sample(r);
          return {
            value: { kind: branch.tag, body: item.value },
            encoded: { kind: branch.tag, body: item.encoded },
          };
        },
      };
    }
  }
}

describe('schema lowering properties (seeded)', () => {
  it('stays in the subset, is sound, and restores exactly over generated schemas', () => {
    const random = mulberry32(20261119);
    for (let trial = 0; trial < 300; trial += 1) {
      const fields = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        generate(random, 3),
      );
      const shape: Record<string, z.ZodType> = {};
      fields.forEach((field, index) => {
        shape[`p${index}`] = field.schema;
      });
      const schema = z.object(shape);
      const anthropic = lowerZodSchema(schema, 'anthropic-strict');
      const openai = lowerZodSchema(schema, 'openai-strict');
      assertInSubset(anthropic.schema, 'anthropic-strict');
      assertInSubset(openai.schema, 'openai-strict');
      for (let sample = 0; sample < 5; sample += 1) {
        const value: Record<string, unknown> = {};
        const encoded: Record<string, unknown> = {};
        fields.forEach((field, index) => {
          const item = field.sample(random);
          value[`p${index}`] = item.value;
          encoded[`p${index}`] = item.encoded;
        });
        assert.ok(schema.safeParse(value).success, `zod accepts trial ${trial}`);
        assert.ok(matchesLowered(value, anthropic.schema), `anthropic soundness trial ${trial}`);
        assert.ok(matchesLowered(encoded, openai.schema), `openai soundness trial ${trial}`);
        assert.deepEqual(openai.restore(encoded), value, `openai restore trial ${trial}`);
        assert.ok(schema.safeParse(openai.restore(encoded)).success);
        assert.deepEqual(anthropic.restore(value), value);
      }
    }
  });
});

describe('lowerZodSchema', () => {
  it('moves unsupported constraints into a description hint and keeps supported formats', () => {
    const lowered = lowerZodSchema(
      z.object({
        name: z.string().min(1).max(5).describe('The name.'),
        age: z.int().min(0),
        tags: z.array(z.string()).min(3),
        email: z.email(),
      }),
      'anthropic-strict',
    );
    const properties = lowered.schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.name, {
      type: 'string',
      description: 'The name.\n\n{minLength: 1, maxLength: 5}',
    });
    assert.deepEqual(properties.age, { type: 'integer', description: '{minimum: 0}' });
    assert.equal(properties.tags?.minItems, undefined);
    assert.equal(properties.tags?.description, '{minItems: 3}');
    assert.equal(properties.email?.format, 'email');
    assert.match(String(properties.email?.description), /pattern/);
    assert.equal(lowered.schema.$schema, undefined);
  });

  it('keeps optional properties optional for Anthropic and makes them nullable-required for OpenAI', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string().optional(),
      c: z.string().nullable().optional(),
    });
    const anthropic = lowerZodSchema(schema, 'anthropic-strict');
    assert.deepEqual(anthropic.schema.required, ['a']);
    const openai = lowerZodSchema(schema, 'openai-strict');
    assert.deepEqual(openai.schema.required, ['a', 'b', 'c']);
    const properties = openai.schema.properties as Record<string, unknown>;
    assert.deepEqual(properties.b, { anyOf: [{ type: 'string' }, { type: 'null' }] });
    assert.deepEqual(openai.restore({ a: 'x', b: null, c: null }), { a: 'x', c: null });
    assert.deepEqual(openai.restore({ a: 'x', b: 'y', c: 'z' }), { a: 'x', b: 'y', c: 'z' });
  });

  it('keeps minItems 1 for Anthropic and every item bound for OpenAI', () => {
    const schema = z.object({ list: z.array(z.string()).min(1), many: z.array(z.string()).min(3) });
    const anthropic = lowerZodSchema(schema, 'anthropic-strict').schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const openai = lowerZodSchema(schema, 'openai-strict').schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(anthropic.list?.minItems, 1);
    assert.equal(anthropic.many?.minItems, undefined);
    assert.equal(anthropic.many?.description, '{minItems: 3}');
    assert.equal(openai.list?.minItems, 1);
    assert.equal(openai.many?.minItems, 3);
    assert.equal(openai.many?.description, undefined);
  });

  it('keeps the constraints OpenAI strict mode enforces on the wire and hints the rest', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 10 },
        x: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
        s: { type: 'string', minLength: 2, pattern: '^a' },
        a: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
        look: { type: 'string', pattern: '^(?!x)a' },
        back: { type: 'string', pattern: '(a)\\1' },
        u: { type: 'string', format: 'uri' },
      },
      required: ['n', 'x', 's', 'a', 'look', 'back', 'u'],
    };
    const openai = lowerJsonSchema(schema, 'openai-strict');
    assertInSubset(openai.schema, 'openai-strict');
    assert.deepEqual(openai.schema.properties, {
      n: { type: 'integer', minimum: 1, maximum: 10 },
      x: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
      s: { type: 'string', description: '{minLength: 2}', pattern: '^a' },
      a: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
      look: { type: 'string', description: '{pattern: "^(?!x)a"}' },
      back: { type: 'string', description: '{pattern: "(a)\\\\1"}' },
      u: { type: 'string', description: '{format: "uri"}' },
    });
    const anthropic = lowerJsonSchema(schema, 'anthropic-strict');
    assertInSubset(anthropic.schema, 'anthropic-strict');
    const anthropicProperties = anthropic.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(anthropicProperties.n, {
      type: 'integer',
      description: '{minimum: 1, maximum: 10}',
    });
    assert.deepEqual(anthropicProperties.u, { type: 'string', format: 'uri' });
  });

  it('chooses a union branch by the bounds kept on the wire', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        v: {
          anyOf: [
            {
              type: 'object',
              properties: { n: { type: 'integer', maximum: 5 }, extra: { type: 'string' } },
              required: ['n'],
            },
            { type: 'object', properties: { n: { type: 'integer', minimum: 6 } }, required: ['n'] },
          ],
        },
      },
      required: ['v'],
    };
    const openai = lowerJsonSchema(schema, 'openai-strict');
    assert.deepEqual(openai.restore({ v: { n: 3, extra: null } }), { v: { n: 3 } });
    assert.deepEqual(openai.restore({ v: { n: 9 } }), { v: { n: 9 } });
    assert.equal(matchesLowered({ v: { n: 9, extra: null } }, openai.schema), false);
    assert.equal(
      matchesLowered(
        { s: 'b' },
        { type: 'object', properties: { s: { type: 'string', pattern: '^a' } } },
      ),
      false,
    );
    assert.equal(
      matchesLowered([1, 2, 3], { type: 'array', items: { type: 'integer' }, maxItems: 2 }),
      false,
    );
    assert.equal(matchesLowered(0.3, { type: 'number', multipleOf: 0.1 }), true);
    assert.equal(matchesLowered(0.35, { type: 'number', multipleOf: 0.1 }), false);
  });

  it('rejects recursion for Anthropic and keeps it through $defs for OpenAI', () => {
    const Node: z.ZodType<{ name: string; next?: unknown; children: unknown[] }> = z.object({
      name: z.string(),
      get next() {
        return Node.optional();
      },
      get children() {
        return z.array(Node);
      },
    });
    assert.throws(
      () => lowerZodSchema(Node, 'anthropic-strict'),
      (error: unknown) => error instanceof AiError && error.context.reason === 'recursive',
    );
    const openai = lowerZodSchema(Node, 'openai-strict');
    assertInSubset(openai.schema, 'openai-strict');
    const encoded = {
      name: 'a',
      next: { name: 'b', next: null, children: [] },
      children: [{ name: 'c', next: null, children: [] }],
    };
    assert.ok(matchesLowered(encoded, openai.schema));
    assert.deepEqual(openai.restore(encoded), {
      name: 'a',
      next: { name: 'b', children: [] },
      children: [{ name: 'c', children: [] }],
    });
  });

  it('emits a recursive nested definition under $defs for OpenAI and restores through it', () => {
    const Node: z.ZodType<{ name: string; next?: unknown }> = z.object({
      name: z.string(),
      get next() {
        return Node.optional();
      },
    });
    const openai = lowerZodSchema(z.object({ tree: Node, other: z.string() }), 'openai-strict');
    assertInSubset(openai.schema, 'openai-strict');
    assert.ok(Object.hasOwn(openai.schema.$defs as object, '__schema0'));
    const encoded = { tree: { name: 'a', next: { name: 'b', next: null } }, other: 'x' };
    assert.ok(matchesLowered(encoded, openai.schema));
    assert.deepEqual(openai.restore(encoded), {
      tree: { name: 'a', next: { name: 'b' } },
      other: 'x',
    });
  });

  it('refuses what a strict profile cannot represent, value-free', () => {
    const cases: readonly (readonly [z.ZodType, string])[] = [
      [z.object({ map: z.record(z.string(), z.number()) }), 'open_object'],
      [z.object({ pair: z.tuple([z.string(), z.number()]) }), 'keyword'],
      [z.object({ anything: z.unknown() }), 'untyped'],
      [z.object({ list: z.array(z.unknown()) }), 'untyped_items'],
      [z.object({ never: z.never() }), 'keyword'],
    ];
    for (const [schema, reason] of cases) {
      for (const profile of ['anthropic-strict', 'openai-strict'] as const) {
        assert.throws(
          () => lowerZodSchema(schema, profile),
          (error: unknown) =>
            error instanceof AiError &&
            error.code === 'invalid_options' &&
            error.context.reason === reason,
        );
      }
      assert.doesNotThrow(() => lowerZodSchema(schema, 'loose'));
    }
  });

  it('closes a loose object and ignores Zod transforms on the input side', () => {
    const lowered = lowerZodSchema(z.object({ a: z.string() }).loose(), 'anthropic-strict');
    assert.equal(lowered.schema.additionalProperties, false);
    const transformed = lowerZodSchema(
      z.object({ n: z.string().transform(Number) }),
      'openai-strict',
    );
    assert.deepEqual(transformed.schema.properties, { n: { type: 'string' } });
  });

  it('throws for schemas Zod cannot represent', () => {
    assert.throws(() => zodInputJsonSchema(z.object({ when: z.date() })), AiError);
    assert.throws(
      () => zodInputJsonSchema(z.object({ big: z.bigint() }), 'invalid_tool'),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_tool',
    );
  });

  it('is memoized per schema and profile, and deterministic across equal schemas', () => {
    const make = (): z.ZodType =>
      z.object({ b: z.string().optional(), a: z.array(z.number().max(3)) });
    const schema = make();
    assert.equal(lowerZodSchema(schema, 'openai-strict'), lowerZodSchema(schema, 'openai-strict'));
    assert.notEqual(
      lowerZodSchema(schema, 'openai-strict'),
      lowerZodSchema(schema, 'anthropic-strict'),
    );
    for (const profile of [
      'anthropic-strict',
      'openai-strict',
      'loose',
    ] as const satisfies readonly AiSchemaProfile[]) {
      assert.equal(
        JSON.stringify(lowerZodSchema(make(), profile).schema),
        JSON.stringify(lowerZodSchema(make(), profile).schema),
      );
    }
    assert.deepEqual(
      Object.keys(lowerZodSchema(schema, 'openai-strict').schema.properties as object),
      ['b', 'a'],
    );
    assert.ok(Object.isFrozen(lowerZodSchema(schema, 'loose').schema));
  });

  it('only drops $schema for the loose profile', () => {
    const lowered = lowerZodSchema(z.object({ a: z.string().min(2) }), 'loose');
    assert.deepEqual(lowered.schema, {
      type: 'object',
      properties: { a: { type: 'string', minLength: 2 } },
      required: ['a'],
    });
    assert.deepEqual(lowered.restore({ a: null }), { a: null });
  });
});

describe('lowerJsonSchema (raw JSON Schema, as from an MCP server)', () => {
  it('merges an object allOf, follows draft-7 definitions, and splits type arrays', () => {
    const schema: JsonSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: { Name: { type: 'string', maxLength: 10 } },
      allOf: [
        { type: 'object', properties: { a: { $ref: '#/definitions/Name' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: ['integer', 'null'], minimum: 1 } } },
      ],
    };
    const lowered = lowerJsonSchema(schema, 'anthropic-strict');
    assertInSubset(lowered.schema, 'anthropic-strict');
    assert.deepEqual(lowered.schema, {
      type: 'object',
      properties: {
        a: { type: 'string', description: '{maxLength: 10}' },
        b: { anyOf: [{ type: 'integer', description: '{minimum: 1}' }, { type: 'null' }] },
      },
      required: ['a'],
      additionalProperties: false,
    });
    const openai = lowerJsonSchema(schema, 'openai-strict');
    assert.deepEqual((openai.schema.properties as Record<string, unknown>).b, {
      anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
    });
    assert.deepEqual(openai.restore({ a: 'x', b: null }), { a: 'x', b: null });
  });

  it('refuses conflicting allOf branches, unknown keywords, and non-local refs', () => {
    const conflict: JsonSchema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { a: { type: 'number' } } },
      ],
    };
    const reasons: readonly (readonly [JsonSchema, string])[] = [
      [conflict, 'allof_conflict'],
      [{ type: 'object', properties: { a: { type: 'string', 'x-secret': 1 } } }, 'keyword'],
      [{ type: 'object', properties: { a: { $ref: 'https://example.com/s.json' } } }, 'ref'],
      [{ type: 'object', required: ['missing'] }, 'required'],
      [{ allOf: [{ type: 'string' }] }, 'allof'],
    ];
    for (const [schema, reason] of reasons) {
      assert.throws(
        () => lowerJsonSchema(schema, 'openai-strict', 'invalid_tool'),
        (error: unknown) =>
          error instanceof AiError &&
          error.code === 'invalid_tool' &&
          error.context.reason === reason,
      );
    }
  });

  it('keeps primitive enums and consts and refuses object ones', () => {
    const lowered = lowerJsonSchema(
      {
        type: 'object',
        properties: { e: { enum: ['a', 1, null] }, c: { const: true } },
        required: ['e', 'c'],
      },
      'openai-strict',
    );
    assert.deepEqual(lowered.schema.properties, {
      e: { enum: ['a', 1, null] },
      c: { const: true },
    });
    assert.throws(
      () =>
        lowerJsonSchema({ type: 'object', properties: { e: { enum: [{}] } } }, 'anthropic-strict'),
      AiError,
    );
  });
});
