/**
 * `definePlugin` tests: definition validation, option parsing with value-free
 * issues, token declarations computed from options, contribution slots, and
 * type fixtures (a wrong option does not compile; a service read is typed).
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { z } from 'zod';

import { createServiceToken, type ServiceToken } from '../../../src/extensions/services.js';
import {
  definePlugin,
  isPluginFactory,
  parseOptions,
  type PluginFactory,
} from '../../../src/plugins/contract/define-plugin.js';
import { loadPluginContribution } from '../../../src/plugins/contract/contributions.js';
import { ConfigErrors, PluginErrors } from '../../../src/plugins/contract/errors.js';
import {
  isPluginInstance,
  lazy,
  type PluginInstance,
  type PluginSetup,
} from '../../../src/plugins/contract/instance.js';
import { tokenRef } from '../../../src/plugins/contract/option-schemas.js';
import { testPlugin } from '../../../src/testing/plugin-harness.js';

const SECRET = 'zz-input-secret';

/** Assert `fn` throws `config.invalid_options` and echoes no `SECRET`; returns the issues. */
function invalidOptions(fn: () => unknown): readonly unknown[] {
  let issues: readonly unknown[] = [];
  assert.throws(fn, (error: unknown) => {
    assert.ok(ConfigErrors.is(error, 'invalid_options'), String(error));
    const rendered = `${String(error)}\n${error.stack ?? ''}\n${JSON.stringify(error.payload)}`;
    assert.ok(!rendered.includes(SECRET), rendered);
    issues = error.payload.issues;
    return true;
  });
  return issues;
}

describe('definePlugin: the definition', () => {
  it('returns a frozen factory whose definition is readable without options', () => {
    const factory = definePlugin({ name: 'probe', setup() {} });
    assert.ok(isPluginFactory(factory));
    assert.ok(Object.isFrozen(factory));
    assert.equal(factory.definition.name, 'probe');
    assert.equal(factory.definition.options, undefined);
    assert.deepEqual(factory.definition.contributes, []);
    assert.equal(
      isPluginFactory(() => undefined),
      false,
    );
  });

  it('refuses a name that is not an identifier', () => {
    for (const name of ['', 'has space', 42]) {
      assert.throws(
        () => definePlugin({ name: name as string, setup() {} }),
        (error: unknown) => PluginErrors.is(error, 'invalid_name'),
      );
    }
  });

  const definitions: readonly { readonly problem: string; readonly spec: object }[] = [
    { problem: 'unknown_field', spec: { setup() {}, describe: () => ({}) } },
    { problem: 'invalid_options_schema', spec: { setup() {}, options: { parse() {} } } },
    { problem: 'invalid_key', spec: { setup() {}, key: 'media' } },
    { problem: 'invalid_token_list', spec: { setup() {}, provides: 'token' } },
    { problem: 'invalid_substrate', spec: { setup() {}, substrate: [] } },
    { problem: 'invalid_setup', spec: { setup: 'run' } },
    { problem: 'invalid_contribution', spec: { setup() {}, jobs: [] } },
    { problem: 'invalid_env', spec: { setup() {}, env: [] } },
    { problem: 'invalid_env_name', spec: { setup() {}, env: { lower: z.string() } } },
    { problem: 'invalid_env_variable', spec: { setup() {}, env: { RAW: z.string() } } },
  ];
  for (const { problem, spec } of definitions) {
    it(`refuses a definition with ${problem}`, () => {
      assert.throws(
        () => definePlugin({ name: 'probe', ...spec } as never),
        (error: unknown) =>
          PluginErrors.is(error, 'invalid_definition') && error.context['problem'] === problem,
      );
    });
  }

  it('refuses a token list entry that is not a service token', () => {
    assert.throws(
      () => definePlugin({ name: 'probe', requires: [{ name: 'fake' } as never], setup() {} }),
      (error: unknown) => PluginErrors.is(error, 'invalid_token'),
    );
  });
});

describe('definePlugin: options', () => {
  const store = createServiceToken<Map<string, string>>('probe.store');
  const probeOptions = z
    .object({
      label: z.string().min(2),
      limits: z.array(z.object({ max: z.number().int() }).strict()).optional(),
      headers: z.record(z.string(), z.string().max(3)).optional(),
      store: tokenRef(store).optional(),
    })
    .strict();

  it('parses options when the factory is called, and setup receives them', async () => {
    const seen: unknown[] = [];
    const factory = definePlugin({
      name: 'probe',
      options: probeOptions,
      setup({ options }) {
        seen.push(options.label);
      },
    });
    const run = await testPlugin(factory({ label: 'ok' }));
    await run.close();
    assert.deepEqual(seen, ['ok']);
  });

  it('raises config.invalid_options before any setup can run', () => {
    const setup = mock.fn<PluginSetup>();
    const factory = definePlugin({ name: 'probe', options: probeOptions, setup });
    invalidOptions(() => (factory as unknown as (input: unknown) => unknown)({ label: 1 }));
    assert.equal(setup.mock.callCount(), 0);
  });

  it('reports schema-declared paths only: an unknown or record key is cut from the path', () => {
    const factory = definePlugin({ name: 'probe', options: probeOptions, setup() {} });
    const call = factory as unknown as (input: unknown) => unknown;
    assert.deepEqual(
      invalidOptions(() => call({ label: 'ok', [SECRET]: 1 })),
      [{ path: [], code: 'unknown_field', message: 'unknown field' }],
    );
    assert.deepEqual(
      invalidOptions(() => call({ label: 'ok', headers: { [SECRET]: 'long value' } })),
      [{ path: ['headers'], code: 'too_big', message: 'must be at most 3' }],
    );
    assert.deepEqual(
      invalidOptions(() => call({ label: 'ok', limits: [{ max: 1 }, { max: 0.5 }] })),
      [{ path: ['limits', 1, 'max'], code: 'invalid_type', message: 'expected a number' }],
    );
  });

  it('reports a throwing refinement without its message', () => {
    const schema = z.string().refine(() => {
      throw new Error(SECRET);
    });
    const issues = invalidOptions(() => parseOptions('probe', schema, SECRET));
    assert.deepEqual(issues, [{ path: [], code: 'invalid' }]);
  });

  it('a plugin without an options schema takes nothing or an empty object', () => {
    const factory = definePlugin({ name: 'bare', setup() {} });
    assert.ok(isPluginInstance(factory()));
    assert.ok(isPluginInstance((factory as unknown as (input: unknown) => PluginInstance)({})));
    const call = factory as unknown as (input: unknown) => unknown;
    invalidOptions(() => call({ [SECRET]: true }));
    invalidOptions(() => call(SECRET));
  });

  it('type fixtures: a wrong option does not compile and a service read is typed', () => {
    const factory = definePlugin({
      name: 'probe',
      options: probeOptions,
      requires: (options) => [options.store],
      setup({ options, services }) {
        if (options.store === undefined) return;
        const value: Map<string, string> = services.get(options.store);
        // @ts-expect-error a service read is typed by its token
        const wrong: number = services.get(options.store);
        assert.equal(value, wrong);
      },
    });
    const call = (): unknown =>
      // @ts-expect-error `label` must be a string
      factory({ label: 7 });
    assert.throws(call);
    // @ts-expect-error `label` is required
    assert.throws(() => factory({}));
    // @ts-expect-error an unknown option does not compile
    assert.throws(() => factory({ label: 'ok', extra: true }));
  });
});

describe('definePlugin: tokens', () => {
  const disk = createServiceToken<string>('probe.disk');
  const index = createServiceToken<string>('probe.index');

  it('computes token lists from the parsed options, dropping undefined entries', () => {
    const factory = definePlugin({
      name: 'search',
      options: z.object({ disk: tokenRef(disk), mirror: tokenRef(disk).optional() }).strict(),
      requires: (options) => [options.disk],
      optional: (options) => [options.mirror],
      provides: [index],
      setup() {},
    });
    const instance = factory({ disk: disk.named('media') });
    assert.deepEqual(instance.requires, [disk.named('media')]);
    assert.deepEqual(instance.optional, []);
    assert.deepEqual(instance.provides, [index]);
    assert.ok(Object.isFrozen(instance) && Object.isFrozen(instance.provides));
  });

  it('refuses a token both provided and depended on', () => {
    const factory = definePlugin({
      name: 'loop',
      requires: [index],
      provides: [index],
      setup() {},
    });
    assert.throws(
      () => factory(),
      (error: unknown) => PluginErrors.is(error, 'conflicting_token'),
    );
  });

  it('refuses a computed list that is not tokens', () => {
    const factory = definePlugin({
      name: 'bad',
      requires: () => [{ name: 'x' } as unknown as ServiceToken<unknown>],
      setup() {},
    });
    assert.throws(
      () => factory(),
      (error: unknown) => PluginErrors.is(error, 'invalid_token'),
    );
  });
});

describe('definePlugin: instance keys', () => {
  const keyed = definePlugin({
    name: 'disk',
    options: z.object({ disk: z.string().optional() }).strict(),
    key: ({ disk }) => disk,
    setup() {},
  });

  it('names a keyed instance <name>:<key> and an unkeyed one by the plugin name', () => {
    assert.equal(keyed.definition.keyed, true);
    assert.equal(definePlugin({ name: 'probe', setup() {} }).definition.keyed, false);
    const media = keyed({ disk: 'media' });
    assert.equal(media.name, 'disk:media');
    assert.equal(media.key, 'media');
    const plain = keyed({});
    assert.equal(plain.name, 'disk');
    assert.equal(plain.key, undefined);
  });

  it('refuses a key that is not an identifier, without echoing it', () => {
    for (const disk of [`has space ${SECRET}`, '', 'x'.repeat(130)]) {
      assert.throws(
        () => keyed({ disk }),
        (error: unknown) => {
          assert.ok(PluginErrors.is(error, 'invalid_instance_key'), String(error));
          assert.ok(!`${String(error)}\n${error.stack ?? ''}`.includes(SECRET));
          return error.context['plugin'] === 'disk';
        },
      );
    }
  });

  it('hands setup the instance name and key', async () => {
    let seen: readonly unknown[] = [];
    const factory = definePlugin({
      name: 'disk',
      options: z.object({ disk: z.string() }).strict(),
      key: ({ disk }) => disk,
      setup({ name, key }) {
        seen = [name, key];
      },
    });
    const run = await testPlugin(factory({ disk: 'media' }));
    await run.close();
    assert.deepEqual(seen, ['disk:media', 'media']);
  });
});

describe('definePlugin: lazy setup and contributions', () => {
  it('loads a lazy setup module only when setup runs', async () => {
    let loads = 0;
    const factory = definePlugin({
      name: 'lazy-setup',
      setup: lazy(async () => {
        loads += 1;
        return { default: (() => undefined) satisfies PluginSetup };
      }),
    });
    const instance = factory();
    assert.equal(loads, 0);
    const run = await testPlugin(instance);
    await run.close();
    assert.equal(loads, 1);
  });

  it('refuses a lazy setup module without a default function', async () => {
    const factory = definePlugin({
      name: 'lazy-bad',
      setup: lazy(async () => ({ default: 'nope' as unknown as PluginSetup })),
    });
    await assert.rejects(testPlugin(factory()), (error: unknown) =>
      PluginErrors.is(error, 'invalid_setup_module'),
    );
  });

  it('reads contribution slots without setup', async () => {
    const setup = mock.fn<PluginSetup>();
    const job = { name: 'probe.job' };
    const factory = definePlugin({
      name: 'contributor',
      setup,
      jobs: lazy(async () => ({ default: [job] })),
      schema: lazy(async () => ({ default: { tables: [{ name: 'probe_items' }] } })),
    });
    assert.deepEqual(factory.definition.contributes, ['schema', 'jobs']);
    assert.deepEqual(await loadPluginContribution(factory, 'jobs'), [job]);
    assert.deepEqual(await loadPluginContribution(factory(), 'schema'), {
      tables: [{ name: 'probe_items' }],
    });
    assert.equal(await loadPluginContribution(factory, 'release'), undefined);
    assert.equal(setup.mock.callCount(), 0);
  });

  it('refuses a contribution of the wrong shape', async () => {
    const factory = definePlugin({
      name: 'contributor',
      setup() {},
      schedules: lazy(async () => ({ default: ['not an object'] as unknown as object[] })),
      schema: lazy(async () => ({ default: { models: [], extra: [] } })),
    });
    for (const slot of ['schedules', 'schema'] as const) {
      await assert.rejects(
        loadPluginContribution(factory, slot),
        (error: unknown) =>
          PluginErrors.is(error, 'invalid_contribution') && error.context['slot'] === slot,
      );
    }
  });

  it('types the factory input from the schema', () => {
    const factory: PluginFactory<{ readonly level: number } | undefined> = definePlugin({
      name: 'typed',
      options: z.object({ level: z.number() }).optional(),
      setup() {},
    });
    assert.ok(isPluginInstance(factory()));
  });
});
