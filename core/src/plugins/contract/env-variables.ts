/**
 * A plugin's environment variables: what each declared variable is (its
 * kind, whether the plugin needs it, whether tooling may generate it), and the
 * one place a plugin's variables are read from the process environment.
 *
 * The schemas come from the `envVar.*` helpers (`option-schemas.ts`), which
 * record each variable's kind here, so a declaration is readable without
 * parsing anything: the manifest agreement gate compares it with the
 * package's `jsails.env`. Parsing reads only the declared names, treats an
 * empty value as unset (as `env.require` does) unless the variable was
 * declared with `refuseBlank` (a selector whose blank value is a deployment
 * mistake, not a request for the default), and reports issues by variable
 * name and rule, never by value.
 *
 * The same reader gives a host the process's mode (`readPluginMode`): the
 * `NODE_ENV` the environment resolver derived, which no plugin declares.
 */

import { mapZodIssues } from '../../validation/zod-issues.js';
import { isIdentifier } from '../../errors/context-schema.js';
import type { ErrorIssue } from '../../errors/kernel.js';
import type { PluginEnvKind } from '../manifest/schema.js';
import { ConfigErrors, PluginErrors } from './errors.js';
import type { PluginEnvSchema, PluginMode } from './instance.js';
import { schemaDef } from './schema-def.js';

/** A declared variable name: the manifest's `env[].name` rule. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/** What an `envVar.*` helper recorded about the schema it built. */
interface EnvVariableKind {
  readonly kind: PluginEnvKind;
  readonly generate: boolean;
  /** Whether a present-but-blank value is refused instead of read as unset. */
  readonly refuseBlank: boolean;
}

const KINDS = new WeakMap<object, EnvVariableKind>();

/** Record the kind of a schema an `envVar.*` helper built. */
export function registerEnvVariable(
  schema: object,
  kind: PluginEnvKind,
  generate: boolean,
  refuseBlank = false,
): void {
  KINDS.set(schema, Object.freeze({ kind, generate, refuseBlank }));
}

/**
 * One declared variable as tools read it, in the manifest's terms.
 *
 * @public
 */
export interface PluginEnvVariable {
  readonly name: string;
  readonly kind: PluginEnvKind;
  /** Whether the plugin refuses to start without it. */
  readonly required: boolean;
  /** Whether tooling may generate a value (secrets only). */
  readonly generate: boolean;
}

/** The variable a schema declares, or `undefined` when no helper built it. */
function describeSchema(
  schema: object,
): { readonly kind: EnvVariableKind; readonly required: boolean } | undefined {
  const direct = KINDS.get(schema);
  if (direct !== undefined) return { kind: direct, required: true };
  const def = schemaDef(schema);
  if ((def?.type === 'optional' || def?.type === 'default') && def.innerType !== undefined) {
    const inner = KINDS.get(def.innerType);
    if (inner !== undefined) return { kind: inner, required: false };
  }
  return undefined;
}

/**
 * The variables `env` declares, in declaration order. Throws
 * `plugin.invalid_definition` for a name that is not an environment variable
 * name or a schema no `envVar.*` helper built.
 *
 * @public
 */
export function describePluginEnv(
  plugin: string,
  env: PluginEnvSchema,
): readonly PluginEnvVariable[] {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new PluginErrors.Error('invalid_definition', { plugin, problem: 'invalid_env' });
  }
  return Object.freeze(
    Object.entries(env).map(([name, schema]) => {
      if (!ENV_NAME.test(name)) {
        throw new PluginErrors.Error('invalid_definition', { plugin, problem: 'invalid_env_name' });
      }
      const described =
        schema !== null && typeof schema === 'object' ? describeSchema(schema) : undefined;
      if (described === undefined) {
        throw new PluginErrors.Error('invalid_definition', {
          plugin,
          problem: 'invalid_env_variable',
        });
      }
      return Object.freeze({
        name,
        kind: described.kind.kind,
        required: described.required,
        generate: described.kind.generate,
      });
    }),
  );
}

/**
 * Parse plugin `plugin`'s declared variables from `source` (the process
 * environment unless a harness passes its own). Throws `config.invalid_env`
 * whose payload lists every issue as `{ path: [name, ...], code }`.
 */
export function parsePluginEnv(
  plugin: string,
  env: PluginEnvSchema | undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, unknown>> {
  if (env === undefined) return Object.freeze({});
  const values: Record<string, unknown> = {};
  const issues: ErrorIssue[] = [];
  for (const [name, schema] of Object.entries(env)) {
    const raw = source[name];
    if (raw === '' && describeSchema(schema)?.kind.refuseBlank === true) {
      issues.push({ path: [name], code: 'blank', message: 'must not be blank when set' });
      continue;
    }
    let result: ReturnType<typeof schema.safeParse>;
    try {
      result = schema.safeParse(raw === '' ? undefined : raw);
    } catch {
      // A throwing refinement may carry the value in its error, so only the
      // fact that it threw is kept.
      issues.push({ path: [name], code: 'invalid' });
      continue;
    }
    if (result.success) {
      values[name] = result.data;
      continue;
    }
    for (const issue of mapZodIssues(result.error)) {
      issues.push({ path: [name, ...issue.path], code: issue.code, message: issue.message });
    }
  }
  const first = issues[0];
  if (first !== undefined) {
    throw new ConfigErrors.Error(
      'invalid_env',
      {
        plugin,
        problem: isIdentifier(first.code) ? first.code : 'invalid',
        variable: String(first.path[0]),
        count: issues.length,
      },
      { payload: { issues: Object.freeze(issues.map((issue) => Object.freeze(issue))) } },
    );
  }
  return Object.freeze(values);
}

/**
 * The mode of a process whose environment is `source` (the process
 * environment unless a harness passes its own): `NODE_ENV` when it is
 * `development` or `test`, else `production`, the rule the environment
 * resolver derives `NODE_ENV` by.
 */
export function readPluginMode(
  source: Readonly<Record<string, string | undefined>> = process.env,
): PluginMode {
  const nodeEnv = source['NODE_ENV'];
  return nodeEnv === 'development' || nodeEnv === 'test' ? nodeEnv : 'production';
}
