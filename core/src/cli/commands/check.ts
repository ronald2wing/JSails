/**
 * `jsails check [--deploy] [--json] [--config <app-config>]`: whether the app
 * config loads, and with `--deploy`, whether it is ready to serve where it is
 * deployed.
 *
 * Without a flag the command loads and validates the app config the way
 * `jsails serve` would, which runs the config module and every plugin factory
 * it names, and reports a failure the way `serve` does. `--deploy` checks the
 * environment the app is deployed as: the CLI resolves it as `production`
 * unless `--env` or `JSAILS_ENV` names another. The rules read the variables
 * the app will see, so the check means something only where they are set:
 * `jamal deploy` runs it inside the release image, with the release's
 * environment, before it starts the release, and another pipeline runs it the
 * same way. Its rules:
 *
 * - `origin_missing` (error): `server.origin` is unset, so `jsails serve`
 *   would refuse to start.
 * - `proxy_untrusted` and `proxy_trust_overridden` (errors): the proxy
 *   topology the deploy states in `JSAILS_TRUSTED_PROXIES` against the
 *   `server.trustedProxies` the app resolved (`security/proxy-diagnostic.ts`).
 * - `proxy_trust_unstated` (info): the environment states no topology, so
 *   there was nothing to compare the trust setting with; said out loud, so a
 *   run outside the deploy environment cannot read as a passed proxy check.
 *
 * The exit code is 1 when the config does not load or a rule finds an error,
 * else 0; an info line is printed and does not fail the check. Findings are
 * value-free: they name config keys and variables, never their values.
 */

import { dirname, resolve } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import {
  parseTrustedProxies,
  TRUSTED_PROXIES_ENV,
  type TrustedProxies,
} from '../../security/request-origin.js';
import { proxyTrustFindings } from '../../security/proxy-diagnostic.js';
import { relativePathSlot } from '../../support/project-paths.server.js';
import type { CommandModule } from '../descriptor.js';
import type { CHECK_OPTIONS } from '../manifest.js';
import { renderResult, writeFailure } from '../report.js';
import { installGlobals } from '../stages.js';

/**
 * One problem a check found: a stable code, whether it fails the check, and
 * a value-free message naming the fix.
 */
export interface CheckFinding {
  readonly code:
    'origin_missing' | 'proxy_untrusted' | 'proxy_trust_overridden' | 'proxy_trust_unstated';
  readonly severity: 'error' | 'info';
  readonly message: string;
}

/** What `jsails check` prints with `--json`. */
export interface CheckResult {
  /** The app config, relative to the working directory. */
  readonly config: string;
  /** The environment the check ran as (`JSAILS_ENV`). */
  readonly environment: string | undefined;
  /** Whether the deploy rules ran. */
  readonly deploy: boolean;
  readonly findings: readonly CheckFinding[];
}

/** The arguments `jsails check` was given. */
export interface CheckInput {
  readonly configPath: string | undefined;
  readonly deploy: boolean;
  readonly json: boolean;
}

/** The seams `jsails check` reads through; each has a real default. */
export interface CheckDeps {
  /** Install the globals the config module may name, then load and resolve it. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  stdout(line: string): void;
  stderr(line: string): void;
}

/** The real seams, over the environment and directory the dispatcher gave the command. */
function defaultCheckDeps(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): CheckDeps {
  return {
    loadConfig: async (configPath) => {
      const { loadAppConfig } = await import('../config-loader.js');
      await installGlobals(dirname(resolve(cwd, configPath)));
      return loadAppConfig(configPath);
    },
    env,
    cwd,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/**
 * The deploy rules over a resolved config and the environment it was
 * resolved in. Pure: reads only its arguments. A malformed
 * `JSAILS_TRUSTED_PROXIES` never reaches here, because the config loader
 * refuses it first.
 */
export function deployFindings(
  config: Pick<ResolvedAppConfig, 'server'>,
  env: Readonly<Record<string, string | undefined>>,
): readonly CheckFinding[] {
  const findings: CheckFinding[] = [];
  if (config.server.origin === undefined) {
    findings.push({
      code: 'origin_missing',
      severity: 'error',
      message:
        'config.server.origin is not set: jsails serve refuses to start outside the development and test environments without it. Set it to the public origin the app is served at; when the config reads it from a variable, run the check with the variables the deployed app receives',
    });
  }
  const stated = statedTrust(env);
  if (stated === undefined) {
    findings.push({
      code: 'proxy_trust_unstated',
      severity: 'info',
      message: `${TRUSTED_PROXIES_ENV} is not set here, so server.trustedProxies was not compared with the proxies in front of the app. A deploy tool that states them (jamal deploy does) runs this check with the variable set`,
    });
  }
  findings.push(...proxyTrustFindings(stated, config.server.trustedProxies));
  return findings;
}

/** The proxy topology the deploy states, or `undefined` when it states none. */
function statedTrust(
  env: Readonly<Record<string, string | undefined>>,
): TrustedProxies | undefined {
  const raw = env[TRUSTED_PROXIES_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseTrustedProxies(raw);
}

/** Run `jsails check`; resolves the exit code. */
export async function runCheck(input: CheckInput, deps: CheckDeps): Promise<number> {
  const configPath = input.configPath ?? DEFAULT_APP_CONFIG_PATH;
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(configPath);
  } catch (error) {
    // A config error's message is value-free; anything else (a plugin
    // factory's own error) is summarised under the fixed line.
    const { isAppConfigError } = await import('../../app/config/errors.js');
    await writeFailure(error, (line) => deps.stderr(line), {
      allow: isAppConfigError,
      fallback: 'failed to load config',
      env: deps.env,
      cwd: deps.cwd,
    });
    return 1;
  }

  const result: CheckResult = {
    config: relativePathSlot(configPath, deps.cwd),
    environment: deps.env.JSAILS_ENV,
    deploy: input.deploy,
    findings: input.deploy ? deployFindings(config, deps.env) : [],
  };
  for (const line of renderResult(result, { json: input.json, render: renderHumanReadable })) {
    deps.stdout(line);
  }
  return result.findings.some((finding) => finding.severity === 'error') ? 1 : 0;
}

/** The human-readable report: what was checked, then one line per finding. */
function renderHumanReadable(result: CheckResult): string[] {
  const environment = result.environment ?? 'development';
  const lines = [`config ${result.config} loads (environment ${environment})`];
  if (!result.deploy) return lines;
  for (const finding of result.findings) {
    lines.push(`${finding.severity} ${finding.code}: ${finding.message}`);
  }
  const errors = result.findings.filter((finding) => finding.severity === 'error').length;
  lines.push(
    errors === 0
      ? 'deploy: no problems found'
      : `deploy: ${errors} error${errors === 1 ? '' : 's'}`,
  );
  return lines;
}

/** `jsails check [--deploy] [--json]`. */
export const checkCommand: CommandModule<typeof CHECK_OPTIONS, 'environment'> = {
  run: (context) =>
    runCheck(
      {
        configPath: context.values.config,
        deploy: context.values.deploy === true,
        json: context.values.json === true,
      },
      defaultCheckDeps(context.env, context.cwd),
    ),
};
