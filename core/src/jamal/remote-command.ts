/**
 * Run one remote command over ssh and forward its output.
 *
 * Shared by the production inspection, app, accessory, and domain verbs. A
 * spawn failure or timeout returns 1; a non-zero exit forwards stdout/stderr
 * and returns the command's exit code. The label is a fixed verb name, never
 * caller input.
 */

import { defaultRemoteRunner, formatError, type JamalDeps } from './plan-command.js';

export async function runRemoteCommand(
  deps: JamalDeps,
  server: string,
  argv: readonly string[],
  label: string,
): Promise<number> {
  const remote = deps.remoteRunner ?? defaultRemoteRunner;
  let result;
  try {
    result = await remote.run(server, argv);
  } catch (error) {
    deps.stderr(`jsails: ${label} failed: ${formatError(error)}`);
    return 1;
  }
  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}
