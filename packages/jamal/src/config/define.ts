/**
 * `defineJamal`, the typed identity for a `jamal.config.ts` default export:
 * the editor checks the object against the same schema the loader validates
 * it with, and the call returns its argument unchanged.
 */

import type { z } from 'jsails/zod';

import type { jamalConfigSchema } from './schema.js';

/**
 * What a jamal config module default-exports, before normalization.
 *
 * @public
 */
export type JamalConfigInput = z.input<typeof jamalConfigSchema>;

/**
 * Types a jamal config. The config file is deploy tooling, so it imports only
 * `@jsails/jamal`, never app code: the CLI loads it without building the app.
 *
 * @public
 */
export function defineJamal<const T extends JamalConfigInput>(config: T): T {
  return config;
}
