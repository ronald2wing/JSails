/**
 * The one secret jamal delivers itself: the key ring the deployed app opens
 * its sealed credentials with.
 *
 * An app that keeps its secrets in `config/credentials/<env>.enc` ships that
 * document in its image and opens it when it starts, so the server needs the
 * key ring, which the image never carries (`.dockerignore` and the
 * Dockerfile's runtime copy keep `config/credentials/*.key` out). A server
 * verb's environment resolution has just opened the same document with that
 * ring, from `JSAILS_CREDENTIALS_KEY` (a CI job) or the key file (a developer
 * machine), and keeps it on the resolution, never in the process environment.
 * {@link withCredentialsKey} puts the whole ring (current and, during a
 * rotation, previous key) on the app's secret channel, so a server still
 * running the old document and one running the new both open theirs. It
 * reaches the server only inside the release's secrets file
 * (`production/secrets-file.ts`), written over ssh stdin beside the app's
 * other secrets in a directory only the ssh user can reach, from which the
 * app's environment resolver lifts it to open the sealed document; it never
 * appears in an argv, the plan, the output, a container's environment, or a
 * file on this machine. An environment with no sealed document gets nothing.
 *
 * Because jamal owns this secret, the secrets files and `config.env` may not
 * name it (`secrets.ts`, `config/safety.ts`): no `$(...)` command reads the
 * key file, and no second value competes with the delivered one. Accessories
 * draw only their own named entries and never receive it. A rotated ring
 * (`jsails credentials rotate`) reaches the server with the next deploy, which
 * writes its release's secrets file.
 */

import {
  CREDENTIALS_KEY_ENV,
  ENVIRONMENT_NAME_ENV,
  isEnvironmentName,
  type KeyRing,
  type ResolvedEnvironment,
} from 'jsails/internal';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import { withSecretEntry, type ResolvedEnv } from './env-resolve.js';
import { JamalConfigError } from './error.js';

/**
 * The `JSAILS_ENV` of an app container whose config sets none: the release's
 * `docker run` passes `-e JSAILS_ENV=production` ahead of the config's clear
 * entries (`production/plan.ts`).
 */
const RELEASE_ENVIRONMENT = 'production';

/**
 * What a server verb's resolution found of the deployed environment's sealed
 * credentials:
 *
 * - `none`: the environment has no sealed document, so the app needs no key.
 * - `sealed`: the document opened with `ring`, the ring the app needs. Hand it
 *   to the app's secret channel only; never print it or put it in an argv.
 * - `unavailable`: the document is sealed but this process holds no ring for
 *   it (a parent JSails process resolved the environment and consumed it).
 */
export type DeploymentCredentials =
  | { readonly status: 'none' }
  | { readonly status: 'sealed'; readonly environment: string; readonly ring: KeyRing }
  | { readonly status: 'unavailable'; readonly environment: string };

/** What a deploy delivers of the server verb's `resolved` environment. */
export function deploymentCredentialsOf(resolved: ResolvedEnvironment): DeploymentCredentials {
  const { credentials, name } = resolved;
  switch (credentials.status) {
    case 'absent':
      return { status: 'none' };
    case 'loaded':
      return { status: 'sealed', environment: name, ring: credentials.ring };
    case 'skipped':
    case 'inherited':
      return { status: 'unavailable', environment: name };
  }
}

const CREDENTIALS_DELIVERY_ERRORS = {
  credentials_key_unavailable: {
    kind: 'unavailable',
    message:
      'config/credentials/{environment}.enc is sealed, but this process holds no key ring to deliver to the app: a parent JSails process resolved the environment and consumed it',
    context: { environment: 'identifier' },
    suggestion:
      'run the verb from a shell that has not resolved an environment, with JSAILS_CREDENTIALS_KEY set or the key file present',
  },
  environment_mismatch: {
    kind: 'invalid',
    message:
      'this deploy acts for {environment} and delivers the key ring of config/credentials/{environment}.enc, but the app container runs as another JSAILS_ENV (production unless config.env sets it in the clear)',
    context: { environment: 'identifier' },
    suggestion:
      'set JSAILS_ENV as a clear config.env entry to the environment you deploy, or deploy with the JSAILS_ENV the container runs as',
  },
} as const;

/**
 * `jamal_credentials.*`: a deploy cannot deliver the credentials key ring,
 * because this process holds none or the container would run as another
 * environment than the one the ring belongs to.
 */
export const CredentialsDeliveryErrors: ErrorRegistry<
  'jamal_credentials',
  typeof CREDENTIALS_DELIVERY_ERRORS
> = defineErrors('jamal_credentials', CREDENTIALS_DELIVERY_ERRORS);

/**
 * `env` with the credentials key ring added to its secret channel when the
 * deployment's environment has sealed credentials, and `env` itself when it
 * has none or nothing was resolved (`credentials` undefined: no server-verb
 * resolution ran, as in a caller that injects its own seams).
 *
 * Throws `jamal_credentials.credentials_key_unavailable` when the document is
 * sealed but this process holds no ring for it, and
 * `jamal_credentials.environment_mismatch` when the app container would run
 * as another `JSAILS_ENV` than the one the ring belongs to, since the app
 * would then open another environment's document and refuse to start.
 */
export function withCredentialsKey(
  env: ResolvedEnv,
  credentials: DeploymentCredentials | undefined,
): ResolvedEnv {
  if (credentials === undefined || credentials.status === 'none') return env;
  const { environment } = credentials;
  if (credentials.status === 'unavailable') {
    throw new CredentialsDeliveryErrors.Error('credentials_key_unavailable', { environment });
  }
  if (containerEnvironmentOf(env) !== environment) {
    throw new CredentialsDeliveryErrors.Error('environment_mismatch', { environment });
  }
  return withSecretEntry(env, CREDENTIALS_KEY_ENV, credentials.ring.toVariable());
}

/**
 * The `JSAILS_ENV` the app container of a release runs as: a clear `config.env`
 * entry's, else production. Only a clear entry can change it: it follows the
 * release's own `-e` on the command line and wins, and the config refuses
 * `JSAILS_ENV` on any other channel (`config/safety.ts`). `env` undefined is a
 * plan previewed without resolving the config's env.
 */
export function containerEnvironmentOf(env: ResolvedEnv | undefined): string {
  const chosen = env?.clear.findLast((entry) => entry.name === ENVIRONMENT_NAME_ENV)?.value;
  if (chosen === undefined) return RELEASE_ENVIRONMENT;
  // The config checks a literal when it loads; a clear secret is known only
  // once resolved, and an invalid one would stop every container at boot.
  if (!isEnvironmentName(chosen)) {
    throw new JamalConfigError(
      `config.env ${ENVIRONMENT_NAME_ENV} resolved to a value that is not an environment name: 1 to 64 letters, digits, "-" or "_", starting with a letter or a digit`,
      {
        suggestion: `make the secret behind ${ENVIRONMENT_NAME_ENV} hold a name such as production or staging`,
      },
    );
  }
  return chosen;
}

/**
 * Whether a deploy in this process delivers the credentials key ring: the
 * resolution found the environment's sealed document and opened it.
 */
export function deliversCredentialsKey(credentials: DeploymentCredentials | undefined): boolean {
  return credentials?.status === 'sealed';
}
