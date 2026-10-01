/**
 * Schema helpers for plugin options and plugin environment variables, and the
 * structural rule first-party option schemas follow.
 *
 * Options are data, functions, service tokens and module references, never
 * instances: a database client, a disk or a logger is a service a plugin
 * provides under a token, and another plugin's options name that token. The
 * helpers are the only `z.custom` schemas the rule admits:
 *
 * - `fn<F>()`: a function (a callback that receives its context);
 * - `tokenRef(family)`: a token of `family` or one of its keyed members;
 * - `moduleOption<T>()`: a {@link ModuleRef} made by `moduleRef(id)`.
 *
 * `boundObject(shape)` is no `z.custom`: it reads an object of data and
 * functions (a log channel, a webhook verifier) from the caller's object,
 * binding each function to it, and checks the result against `shape`.
 *
 * `checkOptionSchema` walks a schema and reports every `z.custom` (and so
 * `z.instanceof`), `z.any`, `z.unknown`, `z.promise` and `z.file` it holds
 * outside those helpers; the `unconverted-plugins` gate runs it on every
 * converted first-party plugin.
 *
 * `envVar.*` builds the schema of one environment variable and records its
 * kind, so a declaration is readable as data (`describePluginEnv`).
 */

import { z } from 'zod';

import { isRecord } from '../../json/shape.js';
import type { ServiceToken, ServiceTokenFamily } from '../../extensions/services.js';
import { registerEnvVariable } from './env-variables.js';
import { isModuleRef, type ModuleRef } from './module-ref.js';
import { schemaDef } from './schema-def.js';

/** The `z.custom` schemas the helpers built: the only ones the rule admits. */
const SANCTIONED = new WeakSet<object>();

function sanctioned<S extends z.ZodType>(schema: S): S {
  SANCTIONED.add(schema);
  return schema;
}

/**
 * An option that holds a function.
 *
 * @public
 */
export function fn<F extends (...args: never[]) => unknown>(): z.ZodType<F> {
  return sanctioned(
    z.custom<F>((value) => typeof value === 'function', { message: 'must be a function' }),
  );
}

/**
 * An option that names a service of `family`: the family itself or one of its
 * keyed members (`diskToken.named('media')`).
 *
 * @public
 */
export function tokenRef<T>(family: ServiceTokenFamily<T>): z.ZodType<ServiceToken<T>> {
  return sanctioned(
    z.custom<ServiceToken<T>>(
      (value) => value === family || (isRecord(value) && value['family'] === family),
      { message: 'must be a service token of the expected family' },
    ),
  );
}

/**
 * An option that names an application module, made with
 * `moduleRef<T>('app/policies/post')`.
 *
 * @public
 */
export function moduleOption<T>(): z.ZodType<ModuleRef<T>> {
  return sanctioned(
    z.custom<ModuleRef<T>>((value) => isModuleRef(value), {
      message: 'must be a module reference made with moduleRef()',
    }),
  );
}

/**
 * An option that is an object of data and functions, such as a channel a
 * caller may write as a class instance: each key of `shape` is read from the
 * caller's object (inherited members included), a function bound to that
 * object so a method keeps its `this` and private fields, and the result is
 * checked against the strict `shape`. Keys outside `shape` are not read, so
 * the parsed value is plain data plus functions while the caller's object
 * keeps its own state.
 *
 * @public
 */
export function boundObject<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodType<z.output<z.ZodObject<Shape>>, z.input<z.ZodObject<Shape>>> {
  const keys = Object.keys(shape);
  return z.preprocess((value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const surface: Record<string, unknown> = {};
    for (const key of keys) {
      const member: unknown = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      surface[key] = typeof member === 'function' ? member.bind(value) : member;
    }
    return surface;
  }, z.object(shape).strict()) as unknown as z.ZodType<
    z.output<z.ZodObject<Shape>>,
    z.input<z.ZodObject<Shape>>
  >;
}

/**
 * Options for {@link envVar}'s `string`.
 *
 * @public
 */
export interface StringVariableOptions {
  /**
   * Whether a variable that is set but blank (`NAME=`) fails
   * `config.invalid_env` instead of reading as unset. Defaults to `false`.
   * For a selector whose unset default would quietly stand in for a value a
   * deployment meant to render.
   */
  readonly refuseBlank?: boolean;
}

/**
 * Options for {@link envVar}'s `secret`.
 *
 * @public
 */
export interface SecretVariableOptions {
  /** The fewest characters a value may have. Defaults to 1. */
  readonly minLength?: number;
  /** Whether tooling may generate a value. Defaults to `false`. */
  readonly generate?: boolean;
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Schemas for plugin environment variables. Each records its kind for the
 * manifest agreement; `.optional()` or `.default(value)` makes it not required.
 *
 * @public
 */
export const envVar: {
  /** Any non-empty text. */
  string(options?: StringVariableOptions): z.ZodType<string, string>;
  /** An absolute URL. */
  url(): z.ZodType<string, string>;
  /** A decimal integer, parsed to a number. */
  integer(): z.ZodType<number, string>;
  /** `true`, `false`, `1` or `0`, parsed to a boolean. */
  boolean(): z.ZodType<boolean, string>;
  /** A secret: never logged, never echoed, optionally generated by tooling. */
  secret(options?: SecretVariableOptions): z.ZodType<string, string>;
} = Object.freeze({
  string(options: StringVariableOptions = {}): z.ZodType<string, string> {
    const schema = z.string().min(1);
    registerEnvVariable(schema, 'string', false, options.refuseBlank === true);
    return schema;
  },
  url(): z.ZodType<string, string> {
    const schema = z.url();
    registerEnvVariable(schema, 'url', false);
    return schema;
  },
  integer(): z.ZodType<number, string> {
    const schema = z
      .string()
      .regex(INTEGER, { message: 'must be a decimal integer' })
      .transform((value) => Number(value))
      .pipe(z.number().int().safe());
    registerEnvVariable(schema, 'integer', false);
    return schema;
  },
  boolean(): z.ZodType<boolean, string> {
    const schema = z
      .enum(['true', 'false', '1', '0'])
      .transform((value) => value === 'true' || value === '1');
    registerEnvVariable(schema, 'boolean', false);
    return schema;
  },
  secret(options: SecretVariableOptions = {}): z.ZodType<string, string> {
    const schema = z.string().min(options.minLength ?? 1);
    registerEnvVariable(schema, 'secret', options.generate === true);
    return schema;
  },
});

/**
 * One place in an option schema that breaks the options rule.
 *
 * @public
 */
export interface OptionSchemaFinding {
  /** Where in the schema: object keys, `[]` for an array element, `|` for a union member. */
  readonly path: readonly string[];
  /** The forbidden construct. */
  readonly construct: 'custom' | 'any' | 'unknown' | 'promise' | 'file';
}

const FORBIDDEN = new Set<OptionSchemaFinding['construct']>([
  'custom',
  'any',
  'unknown',
  'promise',
  'file',
]);

/**
 * Every construct in `schema` that the options rule forbids, outside the
 * helpers above. An empty list means the schema follows the rule.
 *
 * @public
 */
export function checkOptionSchema(schema: z.ZodType): readonly OptionSchemaFinding[] {
  const findings: OptionSchemaFinding[] = [];
  const visiting = new Set<object>();
  const walk = (node: object | null | undefined, path: readonly string[]): void => {
    if (node === null || node === undefined || visiting.has(node)) return;
    if (SANCTIONED.has(node)) return;
    const def = schemaDef(node);
    if (def === undefined) return;
    const type = def.type as OptionSchemaFinding['construct'] | undefined;
    if (type !== undefined && FORBIDDEN.has(type)) {
      findings.push(Object.freeze({ path: Object.freeze([...path]), construct: type }));
      return;
    }
    visiting.add(node);
    for (const [key, child] of Object.entries(def.shape ?? {})) walk(child, [...path, key]);
    walk(def.catchall, [...path, '*']);
    walk(def.element, [...path, '[]']);
    for (const item of def.items ?? []) walk(item, [...path, '[]']);
    walk(def.rest, [...path, '[]']);
    for (const option of def.options ?? []) walk(option, [...path, '|']);
    walk(def.left, path);
    walk(def.right, path);
    walk(def.keyType, [...path, '<key>']);
    walk(def.valueType, [...path, '*']);
    walk(def.innerType, path);
    walk(def.in, path);
    walk(def.out, path);
    if (typeof def.getter === 'function') walk(def.getter(), path);
    visiting.delete(node);
  };
  walk(schema, []);
  return Object.freeze(findings);
}
