/**
 * The shared usage-failure report for CLI commands and Jamal subcommands: one
 * value-free body, each caller's own help line, exit code 2.
 */

/** The output sink a usage failure is reported to. */
export interface UsageErrorSink {
  stderr(text: string): void;
}

/**
 * Report a usage failure to `write` and return the exit code (2). `helpHint` is
 * the caller's command-specific help line, so the shared body stays identical
 * while each command keeps its own help text.
 */
export function usageError(
  write: (line: string) => void,
  helpHint: string,
  message: string,
): number {
  write(`jsails: ${message}`);
  write(helpHint);
  return 2;
}

/** {@link usageError} over a dependency seam's `stderr` sink. */
export function usageFailure(deps: UsageErrorSink, helpHint: string, message: string): number {
  return usageError((line) => deps.stderr(line), helpHint, message);
}
