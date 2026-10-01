/**
 * Loaded-set scenario: `jsails mcp` in the current directory, from start to
 * the first answered `tools/list`. It runs the real CLI as the main module on
 * an in-memory stdin carrying an `initialize` handshake, its `initialized`
 * notification, and a `tools/list` request, waits for the `tools/list`
 * answer on stdout, then ends stdin so the server closes the way a client's
 * disconnect closes it.
 * Everything the process loaded until it exits is the scenario's loaded set:
 * CLI bootstrap, the server, and the tool definitions, but no tool call.
 *
 * Arguments: <cli entry file>
 */
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const READY_TIMEOUT_MS = 30_000;

const REQUESTS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'import-graph', version: '1.0.0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

export default async function mcpReady([cli]) {
  const stdin = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  const listed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('jsails mcp did not answer tools/list in time')),
      READY_TIMEOUT_MS,
    );
    // A CLI that fails before serving ends the process instead of waiting.
    timer.unref();
    let buffered = '';
    // The server's stdout guard captures this writer as the frame channel.
    process.stdout.write = (chunk, ...rest) => {
      buffered += String(chunk);
      for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        if (!Array.isArray(message.result?.tools) || message.result.tools.length === 0) {
          reject(new Error('jsails mcp answered tools/list without tools'));
        } else {
          resolve();
        }
      }
      const callback = rest.find((value) => typeof value === 'function');
      if (callback !== undefined) callback();
      return true;
    };
  });
  process.argv = [process.execPath, cli, 'mcp'];
  await import(pathToFileURL(cli).href);
  for (const request of REQUESTS) stdin.write(`${JSON.stringify(request)}\n`);
  await listed;
  stdin.end();
}
