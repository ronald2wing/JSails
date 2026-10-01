/**
 * The jamal command: one dispatcher over the local Compose verbs and the
 * single-host production verbs.
 *
 * The Sail-like local verbs (`up`, `down`, `ps`, `logs`, `exec`) and the
 * dev-container shortcuts (`jsails`, `npm`, `npx`, `node`, `test`, `shell`)
 * always drive the managed local Compose project (`.jamal/compose.yml`,
 * materialized from the jamal config), even when the config has a production
 * section. The server is reached only through verbs that name it (`deploy`,
 * `rollback`, `status`, `app`, `accessory`, `domain`, `lock`, `backup`,
 * `restore`); `verb-scope.ts` states the split, and the server verbs run in the
 * deployed app's environment and refuse on Windows. `deploy` and
 * `rollback` execute by default; `--dry-run` prints the plan.
 */

import { parseArgs } from 'node:util';

import { formatError } from './thrown-value.js';
import { reportFailure, defaultJamalDeps, type JamalDeps } from './deps.js';
import { assertVerbSupported } from './platform.js';
import { runAccessoryCommand } from './accessory.js';
import { runJamalAppCommand } from './app.js';
import { runBackupCommand, runRestoreCommand } from './backup-command.js';
import { runLockCommand } from './lock-command.js';
import { runCacheProxyCommand } from './cache-proxy-command.js';
import { runDomainCommand } from './domain.js';
import { isDockerVerb } from './docker.js';
import { isShortcutVerb, runDockerExec, runDockerVerb, runShortcut } from './compose-verbs.js';
import { runDeployCommand, runRollbackCommand } from './release-verbs.js';
import { runRemoteStatusVerb } from './remote-verbs.js';
import { usageFailure } from './usage-failure.js';
import { planPrune, formatPrunePlan, type ImageRef } from './prune.js';
import { JAMAL_DEPLOY_USAGE, JAMAL_USAGE } from './usage.js';
import { isSecretsVerb, runSecretsCommand } from './secrets-command.js';

export { defaultJamalDeps, type JamalDeps } from './deps.js';

const JAMAL_OPTIONS = {
  detach: { type: 'boolean', default: false },
  follow: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'allow-dirty': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  keep: { type: 'string' },
  images: { type: 'string', multiple: true },
  destination: { type: 'string' },
  'secrets-path': { type: 'string' },
  volumes: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
} as const;

/** The verbs dispatched on the first token, before the shared flag parse. */
const PRE_PARSE_VERBS: ReadonlySet<string> = new Set([
  'accessory',
  'domain',
  'app',
  'cache-proxy',
  'lock',
  'backup',
  'restore',
]);

/** Parses the tokens of a verb that goes through the shared flag set. */
function parseJamalArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: JAMAL_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
}

/** One post-parse verb invocation, as its runner receives it. */
interface ParsedVerbCall {
  readonly deps: JamalDeps;
  readonly values: ReturnType<typeof parseJamalArgs>['values'];
  /** The positionals after the verb. */
  readonly rest: readonly string[];
  /** Whether the tokens hold a `--` terminator. */
  readonly terminated: boolean;
}

type ParsedVerbRunner = (call: ParsedVerbCall) => Promise<number>;

/** Wraps a runner for a verb that takes no positional after its name. */
function withoutArguments(run: ParsedVerbRunner): ParsedVerbRunner {
  return async (call) =>
    call.rest.length > 0
      ? usageFailure(call.deps, `unexpected argument: ${call.rest.join(' ')}`)
      : run(call);
}

/**
 * The verbs dispatched after the shared flag parse, besides the `docker
 * compose` verbs. This table is the one list of
 * them: a verb is known exactly when `parsedVerbRunner` finds its runner.
 */
const PARSED_VERB_RUNNERS: Readonly<Record<string, ParsedVerbRunner>> = Object.freeze({
  deploy: withoutArguments(({ deps, values }) => runDeployCommand(deps, values)),
  // `rollback` executes by default; `--dry-run` previews it.
  rollback: withoutArguments(({ deps, values }) => runRollbackCommand(deps, values)),
  // `status` inspects the remote server; it requires a production config.
  status: withoutArguments(({ deps }) => runRemoteStatusVerb(deps)),
  // `exec` takes a service name plus a verbatim command after `--`.
  exec: ({ deps, rest, terminated }) => runDockerExec(rest, terminated, deps),
  // `prune` plans image removal; it never executes Docker or opens a connection.
  prune: withoutArguments(({ deps, values }) => runPruneCommand(deps, values)),
  secrets: ({ deps, values, rest }) => runSecretsSubcommand(deps, rest, values),
});

/**
 * The runner for a post-parse verb, or undefined when `verb` is not one. The
 * `docker compose` verbs keep their own positional shape (`logs` may carry a
 * service name). Own-key
 * lookups, so a verb that spells an `Object.prototype` member is unknown.
 */
function parsedVerbRunner(verb: string): ParsedVerbRunner | undefined {
  if (Object.hasOwn(PARSED_VERB_RUNNERS, verb)) return PARSED_VERB_RUNNERS[verb];
  if (isDockerVerb(verb)) {
    return ({ deps, values, rest }) => runDockerVerb(verb, rest, values, deps);
  }
  return undefined;
}

/**
 * Whether a help flag precedes any `--`: tokens after `--` belong to the
 * command a verb runs, so they never turn a run into a help request.
 */
export function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  const own = end === -1 ? args : args.slice(0, end);
  return own.includes('--help') || own.includes('-h');
}

/**
 * The verb {@link runJamalCommand} runs for `args`, or undefined when it runs
 * none: a help request, a missing or unknown verb, or tokens the shared flag
 * parse rejects, each of which only prints. It routes exactly as the command
 * does, so the bin chooses the environment of the verb that then runs.
 */
export function invokedVerb(args: readonly string[]): string | undefined {
  const routed = args[0];
  // A shortcut passes every later token to its command, `--help` included.
  if (isShortcutVerb(routed)) return routed;
  if (asksForHelp(args)) return undefined;
  if (routed !== undefined && PRE_PARSE_VERBS.has(routed)) return routed;
  let positionals: readonly string[];
  try {
    ({ positionals } = parseJamalArgs(args));
  } catch {
    return undefined; // a usage error, which reads no environment.
  }
  const verb = positionals[0];
  return verb !== undefined && parsedVerbRunner(verb) !== undefined ? verb : undefined;
}

/**
 * Reports `unsupported_platform` and answers false when `verb` does not run
 * on this platform (Windows runs only the local-services verbs).
 */
async function platformAllows(verb: string, deps: JamalDeps): Promise<boolean> {
  try {
    assertVerbSupported(verb, deps.platform ?? process.platform);
    return true;
  } catch (error) {
    await reportFailure(deps, error);
    return false;
  }
}

/**
 * Run the `jamal` command over the tokens after the `jamal` command name.
 * Resolves to a process exit code: 0 on success (including a dry run and a
 * clean `docker compose` execution), 2 for usage errors, 1 for a failed
 * verb or a spawn failure, 127 when docker compose is unavailable, and the
 * child's own exit code when a compose verb fails. Help and usage paths never
 * load the config or spawn a process.
 */
export async function runJamalCommand(
  args: readonly string[],
  deps: JamalDeps = defaultJamalDeps,
): Promise<number> {
  // `accessory`, `domain`, `app`, `cache-proxy`, `lock`, `backup`, `restore`,
  // and the shortcuts own their own flag sets and positional shapes, so they
  // are routed on the first token, before the shared `parseArgs` gate (which
  // would reject their flags).
  // The platform check runs on that same token, so it judges exactly the verb
  // that is about to run.
  const routed = args[0];
  if (routed !== undefined && (PRE_PARSE_VERBS.has(routed) || isShortcutVerb(routed))) {
    if (!asksForHelp(args) && !(await platformAllows(routed, deps))) return 1;
    if (routed === 'accessory') return runAccessoryCommand(deps, args.slice(1));
    if (routed === 'domain') return runDomainCommand(deps, args.slice(1));
    if (routed === 'app') return runJamalAppCommand(deps, args.slice(1));
    if (routed === 'cache-proxy') return runCacheProxyCommand(deps, args.slice(1));
    if (routed === 'lock') return runLockCommand(deps, args.slice(1));
    if (routed === 'backup') return runBackupCommand(deps, args.slice(1));
    if (routed === 'restore') return runRestoreCommand(deps, args.slice(1));
    // The shortcuts pass every later token to the command they run, flags
    // included, so they bypass jamal's own flag parsing.
    if (isShortcutVerb(routed)) return runShortcut(routed, args.slice(1), deps);
  }

  let parsed;
  try {
    parsed = parseJamalArgs(args);
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(positionals[0] === 'deploy' ? JAMAL_DEPLOY_USAGE : JAMAL_USAGE);
    return 0;
  }

  if (positionals.length === 0 || positionals[0] === undefined) {
    return usageFailure(
      deps,
      'a subcommand is required (up | down | ps | logs | exec | jsails | npm | npx | node | test | shell | deploy | rollback | status | prune | secrets | domain | accessory | app | cache-proxy | lock | backup | restore)',
    );
  }
  const subcommand = positionals[0];
  // An unknown verb is a usage error on every platform, reported before the
  // platform check so Windows does not call a typo a refused command.
  const run = parsedVerbRunner(subcommand);
  if (run === undefined) {
    return usageFailure(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }
  // `--dry-run` previews the release plan; it is valid only for `deploy` and
  // `rollback`.
  if (values['dry-run'] && subcommand !== 'deploy' && subcommand !== 'rollback') {
    return usageFailure(deps, '--dry-run is only valid for `jamal deploy` and `jamal rollback`');
  }

  // `--allow-dirty` deploys uncommitted changes; only `deploy` builds.
  if (values['allow-dirty'] && subcommand !== 'deploy') {
    return usageFailure(deps, '--allow-dirty is only valid for `jamal deploy`');
  }

  // `--volumes` deletes the local project's data; `--yes` confirms that
  // without a prompt, so neither means anything elsewhere.
  if (values.volumes && subcommand !== 'down') {
    return usageFailure(deps, '--volumes is only valid for `jamal down`');
  }
  if (values.yes && !values.volumes) {
    return usageFailure(deps, '--yes is only valid for `jamal down --volumes`');
  }

  // Every other verb is the first positional after parsing, so a flag value
  // that spells a verb (`--destination up deploy`) is not mistaken for it.
  // Like an unknown verb, a flag used with the wrong verb is a usage error on
  // every platform, so the platform check comes after the flag checks.
  if (!(await platformAllows(subcommand, deps))) return 1;

  return run({ deps, values, rest: positionals.slice(1), terminated: args.includes('--') });
}

// ---------------------------------------------------------------------------
// prune / secrets subcommand runners
// ---------------------------------------------------------------------------

/** The parsed values the `jamal prune` / `jamal secrets` commands read. */
interface ExtraPlanValues {
  readonly keep?: string;
  readonly images?: string[] | undefined;
  readonly destination?: string;
  readonly 'secrets-path'?: string;
}

/** `jamal prune --keep <n> [--images <ref>...]`: plan image removal. Never executes. */
async function runPruneCommand(deps: JamalDeps, values: ExtraPlanValues): Promise<number> {
  if (values.keep === undefined) {
    return usageFailure(deps, '--keep <n> is required for `jamal prune`');
  }
  const keep = Number(values.keep);
  if (Number.isNaN(keep) || !Number.isFinite(keep) || !Number.isInteger(keep) || keep < 1) {
    return usageFailure(deps, '--keep must be a positive integer >= 1');
  }

  const images: ImageRef[] = values.images ?? [];
  if (images.length === 0) {
    deps.stdout('No images to prune.');
    return 0;
  }

  let plan: ReturnType<typeof planPrune>;
  try {
    plan = planPrune({ keep, images });
  } catch (error) {
    await reportFailure(deps, error);
    return 1;
  }

  deps.stdout(formatPrunePlan(plan));
  return 0;
}

/**
 * `jamal secrets <print|fetch|extract> [name]`: inspect the deploy secrets
 * files. `print` lists names only; `fetch`/`extract` write one value.
 */
async function runSecretsSubcommand(
  deps: JamalDeps,
  rest: readonly string[],
  values: ExtraPlanValues,
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || !isSecretsVerb(verb)) {
    return usageFailure(
      deps,
      'a secrets verb is required: `jamal secrets print|fetch|extract [name]`',
    );
  }
  if (rest.length > 2) {
    return usageFailure(deps, `unexpected argument: ${rest.slice(2).join(' ')}`);
  }
  return runSecretsCommand(deps, {
    verb,
    name: rest[1],
    secretsPath: values['secrets-path'],
    destination: values.destination,
  });
}
