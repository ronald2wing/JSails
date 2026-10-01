/**
 * The exit code a command's `run` resolved with, read one way by every runner
 * of a `defineCommand` command (the dispatcher, `runCommand` of
 * `jsails/testing`, a command job): nothing is 0, an integer from 0 to 255 is
 * itself, and anything else is no exit code at all, which each runner refuses
 * rather than hand the operating system a value it would truncate or reject.
 * The module imports nothing, so a runner loads it on the path that reads a
 * result without loading the error registry.
 */

/** The exit code `value` stands for, or `undefined` when it stands for none. */
export function commandExitCode(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
}
