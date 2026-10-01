/**
 * Loaded-set scenario: `jsails serve` in the current directory, then one
 * request. It runs the real CLI as the main module, waits for the line it
 * prints once the server listens, sends `GET <path>` over loopback, checks the
 * status, and stops the server through its SIGTERM handler, as a process
 * manager would.
 * Everything the process loaded until it exits is the scenario's loaded set:
 * CLI bootstrap, config loading, assembly, and the first request.
 *
 * Arguments: <cli entry file> <request path> [expected status]
 */
import { pathToFileURL } from 'node:url';

const LISTEN_TIMEOUT_MS = 30_000;

export default async function serveFirstRequest([cli, path, expected = '200']) {
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('jsails serve did not listen in time')),
      LISTEN_TIMEOUT_MS,
    );
    // A CLI that fails before listening ends the process instead of waiting.
    timer.unref();
    const log = console.log;
    console.log = (...values) => {
      const match = /^Serving at (\S+)/.exec(String(values[0]));
      if (match === null) return log(...values);
      clearTimeout(timer);
      console.log = log;
      resolve(match[1]);
    };
  });
  process.argv = [process.execPath, cli, 'serve'];
  await import(pathToFileURL(cli).href);
  const url = await listening;
  const response = await fetch(new URL(path, url));
  await response.arrayBuffer();
  if (String(response.status) !== expected) {
    throw new Error(`GET ${path} answered ${response.status}, expected ${expected}`);
  }
  // The CLI's own SIGTERM handler shuts the server down; emitting the event
  // runs it the same way on every platform (a real signal to oneself ends a
  // Windows process outright).
  process.emit('SIGTERM', 'SIGTERM');
}
