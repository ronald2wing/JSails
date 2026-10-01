/**
 * The options rule and the environment helpers: `fn`, `tokenRef`,
 * `moduleOption`, `boundObject`, `moduleRef`, `checkOptionSchema`, `envVar`,
 * `describePluginEnv`, `parsePluginEnv` (value-free failures, empty means
 * unset, only declared names are read) and `readPluginMode`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { createServiceToken } from '../../../src/extensions/services.js';
import {
  describePluginEnv,
  parsePluginEnv,
  readPluginMode,
} from '../../../src/plugins/contract/env-variables.js';
import { ConfigErrors, PluginErrors } from '../../../src/plugins/contract/errors.js';
import { isModuleRef, moduleRef } from '../../../src/plugins/contract/module-ref.js';
import {
  boundObject,
  checkOptionSchema,
  envVar,
  fn,
  moduleOption,
  tokenRef,
} from '../../../src/plugins/contract/option-schemas.js';

describe('option schema helpers', () => {
  it('fn accepts functions only', () => {
    const schema = fn<() => void>();
    assert.equal(schema.safeParse(() => undefined).success, true);
    assert.equal(schema.safeParse('() => {}').success, false);
  });

  it('tokenRef accepts the family and its keyed members, nothing else', () => {
    const disk = createServiceToken<string>('disk');
    const other = createServiceToken<string>('disk');
    const schema = tokenRef(disk);
    assert.equal(schema.safeParse(disk).success, true);
    assert.equal(schema.safeParse(disk.named('media')).success, true);
    assert.equal(schema.safeParse(other).success, false);
    assert.equal(schema.safeParse(other.named('media')).success, false);
    assert.equal(schema.safeParse({ name: 'disk', live: false }).success, false);
  });

  it('moduleRef makes a frozen app-relative reference that moduleOption accepts', () => {
    const ref = moduleRef<() => boolean>('app/policies/post');
    assert.equal(ref.id, 'app/policies/post');
    assert.ok(Object.isFrozen(ref) && isModuleRef(ref));
    assert.equal(moduleOption().safeParse(ref).success, true);
    assert.equal(moduleOption().safeParse({ id: 'app/policies/post' }).success, false);
    assert.equal(moduleOption().safeParse('app/policies/post').success, false);
  });

  it('moduleRef refuses an id that is not a relative module path, without echoing it', () => {
    for (const id of [
      '',
      '/abs/path',
      '../escape',
      'app/../x',
      'app//x',
      'C:\\app',
      'a'.repeat(201),
    ]) {
      assert.throws(
        () => moduleRef(id),
        (error: unknown) =>
          PluginErrors.is(error, 'invalid_module_ref') &&
          (id === '' || !String(error).includes(id)),
      );
    }
  });
});

describe('checkOptionSchema', () => {
  it('accepts data, functions, tokens and module references', () => {
    const disk = createServiceToken<string>('disk');
    const schema = z
      .object({
        name: z.string(),
        count: z.number().int().default(1),
        tags: z.array(z.enum(['a', 'b'])),
        map: z.record(z.string(), z.boolean()),
        nested: z.object({ deep: z.union([z.literal('x'), z.null()]) }).optional(),
        tuple: z.tuple([z.string(), z.number()]),
        disk: tokenRef(disk),
        handler: fn<() => void>(),
        policy: moduleOption<() => boolean>(),
        piped: z.string().transform((value) => value.length),
      })
      .strict();
    assert.deepEqual(checkOptionSchema(schema), []);
  });

  it('reports each forbidden construct with its schema path', () => {
    class Client {}
    const schema = z.object({
      client: z.instanceof(Client),
      anything: z.any(),
      later: z.unknown().optional(),
      list: z.array(z.custom<string>(() => true)),
      either: z.union([z.string(), z.promise(z.string())]),
      upload: z.file(),
      record: z.record(z.string(), z.any()),
    });
    assert.deepEqual(checkOptionSchema(schema), [
      { path: ['client'], construct: 'custom' },
      { path: ['anything'], construct: 'any' },
      { path: ['later'], construct: 'unknown' },
      { path: ['list', '[]'], construct: 'custom' },
      { path: ['either', '|'], construct: 'promise' },
      { path: ['upload'], construct: 'file' },
      { path: ['record', '*'], construct: 'any' },
    ]);
  });

  it('walks a recursive schema once', () => {
    interface Node {
      readonly children: readonly Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node) }));
    assert.deepEqual(checkOptionSchema(node), []);
  });
});

describe('plugin environment variables', () => {
  const env = {
    APP_TOKEN: envVar.secret({ minLength: 8, generate: true }),
    APP_URL: envVar.url(),
    APP_PORT: envVar.integer().default(8080),
    APP_DEBUG: envVar.boolean().optional(),
    APP_NAME: envVar.string().optional(),
  };

  it('describes each declared variable in the manifest terms', () => {
    assert.deepEqual(describePluginEnv('probe', env), [
      { name: 'APP_TOKEN', kind: 'secret', required: true, generate: true },
      { name: 'APP_URL', kind: 'url', required: true, generate: false },
      { name: 'APP_PORT', kind: 'integer', required: false, generate: false },
      { name: 'APP_DEBUG', kind: 'boolean', required: false, generate: false },
      { name: 'APP_NAME', kind: 'string', required: false, generate: false },
    ]);
  });

  it('parses declared variables only, treating empty as unset', () => {
    const values = parsePluginEnv('probe', env, {
      APP_TOKEN: 'a-long-secret',
      APP_URL: 'https://example.test/',
      APP_PORT: '',
      APP_DEBUG: '1',
      UNDECLARED: 'ignored',
    });
    assert.deepEqual(values, {
      APP_TOKEN: 'a-long-secret',
      APP_URL: 'https://example.test/',
      APP_PORT: 8080,
      APP_DEBUG: true,
      APP_NAME: undefined,
    });
    assert.ok(Object.isFrozen(values));
  });

  it('reports every issue by variable name and rule, never the value', () => {
    const secret = 'leaky-secret-value';
    assert.throws(
      () =>
        parsePluginEnv('probe', env, {
          APP_TOKEN: 'short',
          APP_URL: secret,
          APP_PORT: `${secret}1`,
          APP_DEBUG: secret,
        }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'invalid_env'), String(error));
        assert.equal(error.context['variable'], 'APP_TOKEN');
        assert.equal(error.context['count'], 4);
        const rendered = `${String(error)}\n${JSON.stringify(error.payload)}`;
        assert.ok(!rendered.includes(secret) && !rendered.includes('short'), rendered);
        assert.deepEqual(
          error.payload.issues.map((issue) => issue.path[0]),
          ['APP_TOKEN', 'APP_URL', 'APP_PORT', 'APP_DEBUG'],
        );
        return true;
      },
    );
  });

  it('refuses a blank value of a variable declared with refuseBlank, and reads it unset otherwise', () => {
    const selector = { APP_MODE: envVar.string({ refuseBlank: true }).optional() };
    assert.deepEqual(describePluginEnv('probe', selector), [
      { name: 'APP_MODE', kind: 'string', required: false, generate: false },
    ]);
    assert.deepEqual(parsePluginEnv('probe', selector, {}), { APP_MODE: undefined });
    assert.deepEqual(parsePluginEnv('probe', selector, { APP_MODE: 'fast' }), {
      APP_MODE: 'fast',
    });
    assert.throws(
      () => parsePluginEnv('probe', selector, { APP_MODE: '' }),
      (error: unknown) =>
        ConfigErrors.is(error, 'invalid_env') &&
        error.context['problem'] === 'blank' &&
        error.context['variable'] === 'APP_MODE',
    );
    assert.deepEqual(
      parsePluginEnv('probe', { APP_MODE: envVar.string().optional() }, { APP_MODE: '' }),
      { APP_MODE: undefined },
    );
  });

  it('reports a missing required variable', () => {
    assert.throws(
      () => parsePluginEnv('probe', { APP_TOKEN: envVar.secret() }, {}),
      (error: unknown) =>
        ConfigErrors.is(error, 'invalid_env') && error.context['problem'] === 'invalid_type',
    );
  });
});

describe('boundObject', () => {
  class Counter {
    readonly label = 'counter';
    #count = 0;
    increment(): number {
      this.#count += 1;
      return this.#count;
    }
  }
  const schema = boundObject({ label: z.string(), increment: fn<() => number>() });

  it('reads the shape from an instance, inherited methods bound to it', () => {
    const counter = new Counter();
    const parsed = schema.parse(counter);
    assert.deepEqual(Object.keys(parsed).sort(), ['increment', 'label']);
    assert.notEqual(parsed, counter);
    assert.equal(parsed.increment(), 1);
    assert.equal(counter.increment(), 2, 'the bound method reaches the private state');
  });

  it('ignores keys outside the shape and refuses a missing or mistyped member', () => {
    assert.equal(schema.safeParse({ label: 'x', increment: () => 1, extra: true }).success, true);
    assert.equal(schema.safeParse({ label: 'x' }).success, false);
    assert.equal(schema.safeParse({ label: 'x', increment: 'later' }).success, false);
    assert.equal(schema.safeParse(null).success, false);
    assert.equal(schema.safeParse([]).success, false);
  });

  it('follows the options rule', () => {
    assert.deepEqual(checkOptionSchema(schema), []);
  });
});

describe('readPluginMode', () => {
  it('reads development and test from NODE_ENV, production for anything else', () => {
    assert.equal(readPluginMode({ NODE_ENV: 'development' }), 'development');
    assert.equal(readPluginMode({ NODE_ENV: 'test' }), 'test');
    assert.equal(readPluginMode({ NODE_ENV: 'production' }), 'production');
    assert.equal(readPluginMode({ NODE_ENV: 'Development' }), 'production');
    assert.equal(readPluginMode({}), 'production');
  });
});
