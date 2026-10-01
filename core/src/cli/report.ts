/**
 * How a command's outcome reaches its reader: the one JSON-or-human switch of
 * the reporting commands (`--json` prints the result object as a single line
 * for machines, otherwise the command's own renderer lays it out for people),
 * and the failure report every command's thrown error goes through: the top
 * message, then the value-free cause chain (`errors/cause-chain.server.ts`).
 */

/** Options for {@link renderResult}. */
export interface RenderResultOptions<T> {
  /** True when the caller passed `--json`. */
  readonly json: boolean;
  /** The human-readable rendering, consulted only when `json` is false. */
  readonly render: (result: T) => readonly string[];
}

/** Render `result` as one JSON line, or as the human-readable lines. */
export function renderResult<T>(result: T, options: RenderResultOptions<T>): readonly string[] {
  return options.json ? [JSON.stringify(result)] : options.render(result);
}

/** Options for {@link writeFailure} and {@link reportFailure}. */
export interface FailureReportOptions {
  /**
   * Whether a thrown value that is no registry error may have its own message
   * printed (`failureHead` in `errors/registry.ts`). Defaults to any framework error. A
   * command whose errors may come from user code it does not own (a project
   * command, an extension) narrows it to the framework errors it knows.
   */
  readonly allow?: (error: unknown) => boolean;
  /** The top line when the message is withheld. Defaults to `the command failed`. */
  readonly fallback?: string;
  /** What the command was doing, printed ahead of the message (`failed to load db config`). */
  readonly label?: string;
  /**
   * The environment `JSAILS_DEBUG` is read from: the command's (its context's
   * `env`). No project file can put the variable there, since it is a
   * reserved key of the environment resolver.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory paths are shown relative to. Defaults to the working directory. */
  readonly cwd?: string;
}

/**
 * Whether the cause-chain renderer has anything to add: a cause or aggregate
 * members to explain, a withheld top message to summarise, or debug output
 * asked for. Checked before the renderer is imported, so a failure with
 * nothing below it (a missing config) loads no more than it did before.
 */
function hasMoreToSay(
  thrown: unknown,
  shown: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  // The same test as `isDebugEnabled` of the renderer, which is not loaded yet.
  if (!shown || env.JSAILS_DEBUG === '1') return true;
  if (typeof thrown !== 'object' || thrown === null) return false;
  try {
    const { cause, errors } = thrown as { readonly cause?: unknown; readonly errors?: unknown };
    return cause !== undefined || Array.isArray(errors);
  } catch {
    // A throwing getter still has something to explain; the renderer reads
    // every property defensively.
    return true;
  }
}

/**
 * Write `thrown`'s failure to `write`: the `jsails:` line with its message (or
 * the fallback, by the policy of `failureHead` in `errors/registry.ts`) and `hint:`, then
 * one line per link of its cause chain, value-free unless `JSAILS_DEBUG=1` is
 * set. Never throws once the top line is written: a chain that cannot be
 * rendered is left out rather than turning into a second report.
 */
export async function writeFailure(
  thrown: unknown,
  write: (line: string) => void,
  options: FailureReportOptions,
): Promise<void> {
  const { failureHead } = await import('../errors/registry.js');
  const head = failureHead(thrown, {
    ...(options.allow === undefined ? {} : { allow: options.allow }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  });
  const [first = '', ...rest] = head.lines;
  write(`jsails: ${options.label === undefined ? first : `${options.label}: ${first}`}`);
  for (const line of rest) write(line);
  const { env } = options;
  if (!hasMoreToSay(thrown, head.shown, env)) return;
  let lines: readonly string[];
  try {
    const { renderCauseChain } = await import('../errors/cause-chain.server.js');
    lines = renderCauseChain(thrown, {
      env,
      head: head.shown ? 'shown' : 'withheld',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch {
    // The renderer guards every read itself, so this is an install that
    // cannot load it: the top line already says what failed.
    return;
  }
  for (const line of lines) write(line);
}

/**
 * Report a command's failure to `write` and resolve with its exit code. The
 * report is {@link writeFailure}'s: a framework error's own message (and its
 * `hint:` line), whatever its audience, a fixed line for any other error, then
 * the value-free cause chain; the exit code
 * comes from the boundary table by the error's kind. An aborted command
 * prints nothing.
 *
 * The boundary table (and the normalizer and registries behind it) is loaded
 * here, on failure, because the commands import this module for
 * {@link renderResult}: a command that succeeds, or prints its help, loads none
 * of it.
 */
export async function reportFailure(
  thrown: unknown,
  write: (line: string) => void,
  options: FailureReportOptions,
): Promise<number> {
  const { boundaryOutcome } = await import('../errors/boundary-table.server.js');
  const outcome = boundaryOutcome(thrown);
  if (outcome.logLevel !== 'none') await writeFailure(thrown, write, options);
  return outcome.exitCode;
}
