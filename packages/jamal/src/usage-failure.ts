/**
 * The usage-failure report every jamal verb shares: one value-free line, the
 * help hint, exit code 2.
 */

/** The output sink a usage failure is reported to. */
export interface UsageFailureSink {
  stderr(text: string): void;
}

/** Report a usage failure to `deps.stderr` and return the exit code (2). */
export function usageFailure(deps: UsageFailureSink, message: string): number {
  deps.stderr(`jamal: ${message}`);
  deps.stderr('Run "jamal --help" for usage.');
  return 2;
}
