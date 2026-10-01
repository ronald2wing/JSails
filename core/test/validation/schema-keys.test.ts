/**
 * Tests for `AgreeingSchema`: a schema that satisfies it compiles only when
 * it and its interface agree on every key at every block. The drifts are
 * compile errors, asserted with `@ts-expect-error`, so this file stops
 * compiling if the check stops catching them. The app config schema
 * satisfies it, so `AppConfig` and `appConfigSchema` cannot drift.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { appConfigSchema } from '../../src/app/config/schema.js';
import type { AgreeingSchema, KeyDrift } from '../../src/validation/schema-keys.js';

interface Server {
  readonly origin?: string;
  readonly processPermissions?: boolean;
}

interface Config {
  readonly port?: number;
  readonly server?: Server;
  readonly guards?: readonly (() => void)[];
  readonly proxies?: 'none' | { readonly hops: number };
}

const server = z.object({
  origin: z.string().optional(),
  processPermissions: z.boolean().optional(),
});

const agreeing = z.object({
  port: z.number().optional(),
  server: server.strict().optional(),
  guards: z.array(z.custom<() => void>((value) => typeof value === 'function')).optional(),
  proxies: z.union([z.literal('none'), z.object({ hops: z.number() })]).optional(),
});

const missingNested = agreeing.extend({
  server: z.object({ origin: z.string().optional() }).strict().optional(),
});

const extraTopLevel = agreeing.extend({ storage: z.string().optional() });

/** Whether `A` and `B` are the same type. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('AgreeingSchema', () => {
  it('is satisfied when the keys agree', () => {
    const schema: z.ZodType<Config> = agreeing satisfies AgreeingSchema<Config, typeof agreeing>;
    assert.deepEqual(schema.parse({ port: 1, server: { origin: 'x' } }), {
      port: 1,
      server: { origin: 'x' },
    });
  });

  it('does not compile when the interface documents a key the schema lacks', () => {
    // @ts-expect-error server.processPermissions is documented but missing from the schema
    const schema = missingNested satisfies AgreeingSchema<Config, typeof missingNested>;
    assert.equal(schema, missingNested);
    const drift: Same<
      KeyDrift<Config, z.output<typeof missingNested>>,
      'server.processPermissions'
    > = true;
    assert.equal(drift, true);
  });

  it('does not compile when the schema accepts a key the interface omits', () => {
    // @ts-expect-error storage is accepted by the schema but undocumented
    const schema = extraTopLevel satisfies AgreeingSchema<Config, typeof extraTopLevel>;
    assert.equal(schema, extraTopLevel);
    const drift: Same<KeyDrift<Config, z.output<typeof extraTopLevel>>, 'storage'> = true;
    assert.equal(drift, true);
  });

  it('keeps the app config schema strict about the keys it declares', () => {
    assert.equal(appConfigSchema.safeParse({ server: { origin: 'https://x.test' } }).success, true);
    assert.equal(
      appConfigSchema.safeParse({ server: { processPermissions: true } }).success,
      false,
    );
  });
});
