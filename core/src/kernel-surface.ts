/**
 * `jsails/internal`: the kernel's surface for first-party packages, with no
 * compatibility promise between versions. A package that imports it pins
 * `jsails` to the exact lockstep version (the declared-deps gate enforces
 * that), so it always runs against the kernel it was built with. Applications
 * never import it.
 *
 * `resolveEnvironment` and `applyEnvironment` are the environment bootstrap of
 * the `jsails` CLI; the `jamal` bin runs them too, so `npx jamal ...` and
 * `jsails jamal ...` resolve one environment the same way. A deploy reads the
 * key ring that opened the sealed credentials from the resolution
 * (`CredentialsResolution`, `KeyRing.toVariable`) and delivers it to the
 * deployed app as `CREDENTIALS_KEY_ENV`; `ENVIRONMENT_NAME_ENV` names the
 * variable the app container's environment is chosen by, and
 * `SECRETS_FILE_ENV` the `{ "v": 1, "values": {...} }` file a deploy mounts
 * into the container, which the resolution records as consumed
 * (`ResolvedEnvironment.secretsFile`). `RESERVED_KEYS` are the variables only
 * a real environment may set, which jamal's config refuses as container
 * variables, and `deriveNodeEnv` the `NODE_ENV` a deploy gives the container
 * for the environment it runs as. `TRUSTED_PROXIES_ENV` names the variable a
 * deploy states its proxy topology in, and `formatTrustedProxies` writes a
 * `server.trustedProxies` setting as its value (refusing one the app would
 * refuse); jamal derives the setting from the proxies it builds and owns the
 * variable.
 *
 * `currentRequestFrame` reads the request frame from a module that loads only
 * the execution context, for a first-party route handler (the mail preview's
 * loopback check) whose package entry must not load the request pipeline.
 *
 * `jobsToken` and `broadcastToken` are the tokens of the jobs and broadcast
 * services, from the contracts, which load neither runtime, so a first-party
 * plugin on the kernel contract can declare them as optional services while
 * its config entry stays free of BullMQ and Socket.IO.
 *
 * `runCommandUnattended` runs a `defineCommand` command with no terminal, as
 * a command job does (`cli/run-unattended.ts`), so `@jsails/jobs` reads its
 * argv, environment and exit code as `jsails/jobs` and the dispatcher do.
 *
 * `renderFailureReport` and `renderCauseChain` are the CLI's failure report,
 * shared so the `jamal` bin reports a failure the way `jsails` does, and
 * `explainModuleImportFailure` names the place of a syntax error in a module
 * a loader imported, so its config loader keeps that as the `cause`.
 */

import type { DefinedCommand } from './cli/define-command.js';
import type { CommandOptions } from './cli/descriptor.js';
import type { UnattendedOutcome, UnattendedRun } from './cli/run-unattended.js';
import type { CauseChainOptions, FailureReportRenderOptions } from './errors/cause-chain.server.js';

export { broadcastToken, type BroadcastService } from './contracts/broadcast-service.js';
export type { UnattendedOutcome, UnattendedRun } from './cli/run-unattended.js';
export { environmentFailureLines } from './environment/errors.js';
export { KeyRing } from './environment/key-ring.js';
export {
  CREDENTIALS_KEY_ENV,
  deriveNodeEnv,
  ENVIRONMENT_NAME_ENV,
  isEnvironmentName,
  RESERVED_KEYS,
  SECRETS_FILE_ENV,
  type DerivedNodeEnv,
} from './environment/names.js';
export {
  applyEnvironment,
  resolveEnvironment,
  type CredentialsResolution,
  type EnvironmentSource,
  type ResolveEnvironmentOptions,
  type ResolvedEnvironment,
  type SecretsRequirement,
} from './environment/resolve.js';
export type { CauseChainOptions, FailureReportRenderOptions } from './errors/cause-chain.server.js';
export { jobsToken, type JobsService } from './contracts/jobs-service.js';
export { formatTrustedProxies, TRUSTED_PROXIES_ENV } from './security/request-origin.js';
export { currentRequestFrame } from './server/current-frame.js';
export type { FailureHeadOptions } from './errors/registry.js';

/**
 * The lines a CLI prints under a failure's top message: its cause chain,
 * value-free unless `options.env` sets `JSAILS_DEBUG=1`, as the `jsails`
 * CLI prints it. The renderer is imported on the first call, so a bin that
 * imports this surface loads it only once something has failed.
 *
 * @internal
 */
export async function renderCauseChain(
  thrown: unknown,
  options: CauseChainOptions,
): Promise<readonly string[]> {
  const renderer = await import('./errors/cause-chain.server.js');
  return renderer.renderCauseChain(thrown, options);
}

/**
 * A whole failure report, as the `jsails` CLI prints it: the top line (a
 * framework error's message, a fixed line for anything else), its `hint:`
 * line, and the cause chain. Imported on the first call, like
 * {@link renderCauseChain}.
 *
 * @internal
 */
export async function renderFailureReport(
  thrown: unknown,
  options: FailureReportRenderOptions,
): Promise<readonly string[]> {
  const renderer = await import('./errors/cause-chain.server.js');
  return renderer.renderFailureReport(thrown, options);
}

/**
 * The error to keep as `cause` for `error`, thrown importing the module file
 * at `filePath`: a syntax error wrapped in a `module_syntax.*` error naming
 * its file, line and column when Node can say where it is, else `error`
 * unchanged. Imported on the first call: it runs only on that failure path.
 *
 * @internal
 */
export async function explainModuleImportFailure(
  filePath: string,
  error: unknown,
  cwd?: string,
): Promise<unknown> {
  const syntax = await import('./support/syntax-location.server.js');
  return syntax.explainModuleImportFailure(filePath, error, cwd);
}

/**
 * Run `command` once with `run.args`, non-interactively, against the
 * environment the process applied, and say how it ended; a throw from the
 * command propagates. Imported on the first call, so a package that declares
 * command jobs loads no argument parser until one runs.
 *
 * @internal
 */
export async function runCommandUnattended(
  command: DefinedCommand<CommandOptions, 'environment'>,
  run: UnattendedRun,
): Promise<UnattendedOutcome> {
  const runner = await import('./cli/run-unattended.js');
  return runner.runUnattended(command, run);
}
