/**
 * Child processes the starter verifier drives: bounded one-shot commands whose
 * output is captured, long-running servers resolved once they print their
 * listen line, a loopback port reservation, and the teardown of every server
 * still owned when the run ends.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** Budget for an npm or network step. */
export const NPM_TIMEOUT_MS = 300_000;

/** The last `max` characters of a command's output, for error messages. */
export const tail = (text, max = 4000) => (text.length > max ? text.slice(-max) : text);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The child's environment: the verifier's own, with `overrides` layered on top. */
function childEnv(overrides) {
  return overrides === undefined ? process.env : { ...process.env, ...overrides };
}

/**
 * Spawns `cmd` and resolves with `{ code, signal, stdout, stderr }` whatever
 * its exit status. Rejects only when the process could not be started or ran
 * past `timeoutMs`, in which case it is killed.
 */
export function runCommandResult(cmd, args, { cwd, env, timeoutMs = NPM_TIMEOUT_MS, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label}: timed out after ${timeoutMs} ms`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Spawns `cmd` and resolves with its output on exit 0; rejects with the output tails otherwise. */
export async function runCommand(cmd, args, options) {
  const { code, signal, stdout, stderr } = await runCommandResult(cmd, args, options);
  if (code !== 0) {
    throw new Error(
      `${options.label}: exit ${code}${signal ? ` (signal ${signal})` : ''}\n` +
        `--- stdout (tail) ---\n${tail(stdout)}\n--- stderr (tail) ---\n${tail(stderr)}`,
    );
  }
  return { stdout, stderr };
}

/** Reserves and releases a loopback TCP port, resolving with its number. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Long-running children the verifier owns, torn down by `stopOwnedChildren`. */
const owned = new Set();

/** Registers a long-running child so `stopOwnedChildren` reaches it. */
export function own(child) {
  owned.add(child);
}

/** SIGTERMs a child, escalating to SIGKILL after `graceMs`, and resolves once it has exited. */
export function stopChild(child, graceMs = 3000) {
  owned.delete(child);
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    killTimer.unref();
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** Stops every owned child that is still running. */
export async function stopOwnedChildren() {
  for (const child of [...owned]) {
    await stopChild(child);
  }
}

/**
 * Spawns a server and resolves with `{ url, stop }` once `match` (whose first
 * capture group is the URL) appears in its stdout. Rejects when the child
 * exits or stays silent past `timeoutMs`.
 */
export function spawnServer({ cmd, args, cwd, env, match, timeoutMs = 30_000, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    own(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const outputTails = () =>
      `stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-500))}`;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `${label}: timed out waiting for listen output (${timeoutMs} ms); ${outputTails()}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const found = stdout.match(match);
      if (found && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: found[1], stop: () => stopChild(child) });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `${label}: exited before listening (code=${code} signal=${signal}); ${outputTails()}`,
        ),
      );
    });
  });
}

/** Spawns a child with piped output; the dev-server driver reads its stream itself. */
export function spawnPiped(cmd, args, { cwd, env }) {
  const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  own(child);
  return child;
}
