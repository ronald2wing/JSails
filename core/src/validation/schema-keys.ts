/**
 * Key agreement between a hand-written TSDoc interface and the Zod schema
 * that validates it.
 *
 * Annotating a schema `z.ZodType<T>` checks one direction only: the schema's
 * output must be assignable to `T`. When every key of `T` is optional, a key
 * the interface documents but the strict schema lacks still compiles, and
 * every value that sets it is refused at run time as an unrecognized key; a
 * key the schema accepts but the interface omits compiles too. A schema
 * checked with `satisfies AgreeingSchema<T, typeof schema>` also fails to
 * compile on either drift, and the error names the drifted key by its dotted
 * path. The check is types only: nothing here exists at run time.
 *
 * Keys are compared at every config block: a property whose type (without
 * `undefined`) is an object that is neither an array nor a function. Other
 * properties (a union with a literal, a list, a callback) are leaves, whose
 * types the `z.ZodType<T>` bound already checks.
 */

import type { z } from 'zod';

type Defined<T> = Exclude<T, undefined>;

/** Whether `T` is a config block: an object, not an array, not a function, not a union with a primitive. */
type IsBlock<T> = [T] extends [readonly unknown[]]
  ? false
  : [T] extends [(...args: never[]) => unknown]
    ? false
    : [T] extends [object]
      ? true
      : false;

/**
 * The dotted paths of the keys `A` and `B` disagree on, at any block depth:
 * a key only one of them has. `never` when they agree.
 */
export type KeyDrift<A, B, Path extends string = ''> =
  | `${Path}${Exclude<keyof A, keyof B> & string}`
  | `${Path}${Exclude<keyof B, keyof A> & string}`
  | {
      [K in keyof A & keyof B & string]: IsBlock<Defined<A[K]>> extends true
        ? IsBlock<Defined<B[K]>> extends true
          ? KeyDrift<Defined<A[K]>, Defined<B[K]>, `${Path}${K}.`>
          : never
        : never;
    }[keyof A & keyof B & string];

/** `unknown` when `T` and `O` agree on their keys, else a demand that names the drift. */
type KeyAgreement<T, O> = [KeyDrift<T, O>] extends [never]
  ? unknown
  : { readonly keyDrift: KeyDrift<T, O> };

/**
 * What a schema `S` written for the interface `T` must satisfy: its output
 * is assignable to `T`, and the two agree on every key. A drift fails with
 * `Property 'keyDrift' is missing`, whose type is the drifted path:
 *
 * ```ts
 * const shape = z.object({ ... }).strict();
 * export const schema: z.ZodType<Config> = shape satisfies AgreeingSchema<Config, typeof shape>;
 * ```
 */
export type AgreeingSchema<T, S extends z.ZodType> = z.ZodType<T> & KeyAgreement<T, z.output<S>>;
