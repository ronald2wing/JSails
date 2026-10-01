/**
 * The control variables of environment resolution, the environment-name
 * grammar, and the one rule that derives `NODE_ENV` from the name.
 *
 * `JSAILS_ENV` names the environment; `NODE_ENV` follows from it
 * (`development`, `test`, otherwise `production`) so a library that reads
 * `NODE_ENV` sees the same choice. The other control variables belong to the
 * resolver: the credentials key ring, the secrets file the deploy mounts, and
 * the marker a resolved parent hands its children. None of them may come from
 * a file, since each decides what the files mean; nor may `JSAILS_DEBUG`,
 * which decides how much of a failure a report prints.
 */

import { isForbiddenKey } from '../json/shape.js';

/**
 * The variable that names the environment (the CLI's `--env`).
 *
 * @internal
 */
export const ENVIRONMENT_NAME_ENV = 'JSAILS_ENV';

/**
 * The variable that holds the credentials key ring of the environment the
 * process runs as.
 *
 * @internal
 */
export const CREDENTIALS_KEY_ENV = 'JSAILS_CREDENTIALS_KEY';

/**
 * The variable naming a `{ "v": 1, "values": { ... } }` secrets file, the
 * layer a deploy mounts read-only into the app container.
 *
 * @internal
 */
export const SECRETS_FILE_ENV = 'JSAILS_SECRETS_FILE';

/**
 * The marker a process that resolved its environment exports for its
 * children: `<name>:<keyId>:<sha256 of the sealed document>:<sha256 of the
 * project root's real path>`.
 *
 * @internal
 */
export const RESOLVED_MARKER_ENV = 'JSAILS_ENV_RESOLVED';

/**
 * The variable that makes a failure report print the underlying error
 * messages and stacks (`errors/cause-chain.server.ts`). Reserved like the
 * resolver's own variables, for another reason: a committed `.env` that set
 * it would turn full detail on for every run, CI logs and production
 * included, when it is meant for the one run an operator chose.
 *
 * @internal
 */
export const DEBUG_OUTPUT_ENV = 'JSAILS_DEBUG';

/** The environment when neither `--env` nor `JSAILS_ENV` names one. */
export const DEFAULT_ENVIRONMENT = 'development';

/**
 * Keys no file or sealed document may define: each one decides which layers
 * apply or how they are read, or (`JSAILS_DEBUG`) how much of a failure is
 * printed. A secrets file refuses them too, except `JSAILS_CREDENTIALS_KEY`,
 * which it may carry for the deployed container that has no other way to
 * receive it (`secrets-file.ts`). A deploy tool that writes an app's
 * environment from a committed config (`jamal`'s `config.env`) refuses them
 * for the same reason.
 *
 * @internal
 */
export const RESERVED_KEYS: readonly string[] = Object.freeze([
  ENVIRONMENT_NAME_ENV,
  'NODE_ENV',
  CREDENTIALS_KEY_ENV,
  SECRETS_FILE_ENV,
  RESOLVED_MARKER_ENV,
  DEBUG_OUTPUT_ENV,
]);

/**
 * What `NODE_ENV` an environment runs under.
 *
 * @internal
 */
export type DerivedNodeEnv = 'development' | 'test' | 'production';

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `name` can name an environment (and so a file name and an error identifier).
 *
 * @internal
 */
export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

/**
 * `NODE_ENV` for the environment `name`: itself for development and test, else production.
 *
 * @internal
 */
export function deriveNodeEnv(name: string): DerivedNodeEnv {
  return name === 'development' || name === 'test' ? name : 'production';
}

/**
 * Whether a process whose `NODE_ENV` is `nodeEnv` runs as production:
 * anything but development and test, unset included, as {@link deriveNodeEnv}
 * maps every other environment name to production.
 *
 * @internal
 */
export function isProductionNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

/** Whether `key` can be an environment variable a layer defines. */
export function isEnvKey(key: string): boolean {
  return ENV_KEY.test(key) && !isForbiddenKey(key);
}

/** The first reserved key among `keys`, or `undefined`. */
export function firstReservedKey(keys: Iterable<string>): string | undefined {
  for (const key of keys) {
    if (RESERVED_KEYS.includes(key)) return key;
  }
  return undefined;
}
