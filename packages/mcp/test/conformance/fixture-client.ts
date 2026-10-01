/**
 * The conformance client wrapper: the command the official suite runs in
 * client mode. The suite starts a scenario server, appends its URL as the
 * last argument, and names the scenario in `MCP_CONFORMANCE_SCENARIO`; this
 * process connects with `connectMcp` (protocol `auto`, so the 2025 fallback
 * is what a 2025-only scenario server exercises), does what the scenario
 * expects, and exits 0 on success or 1 with the client error code on stderr.
 *
 * The elicitation handler accepts with an empty form, so a field the user
 * did not touch must be answered with the form's default by the client.
 */

import { connectMcp } from '../../src/remote-client.js';
import { McpClientError } from '../../src/errors.js';

const ARGUMENTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  add_numbers: { a: 5, b: 3 },
};

async function main(): Promise<void> {
  const url = process.argv.at(-1);
  if (url === undefined || !URL.canParse(url)) {
    throw new Error('missing server URL');
  }
  const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
  const remote = await connectMcp({
    transport: { kind: 'http', url },
    clientInfo: { name: 'jsails-conformance-client', version: '1.0.0' },
    timeoutMs: 10_000,
    elicit: () => ({ action: 'accept', content: {} }),
  });
  try {
    const tools = await remote.listTools();
    if (scenario !== 'initialize') {
      for (const tool of tools) {
        const outcome = await remote.callTool(tool.name, ARGUMENTS[tool.name] ?? {});
        if (outcome.status !== 'ok') {
          throw new Error(`tool ${tool.name} answered ${outcome.status}`);
        }
      }
    }
  } finally {
    await remote.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof McpClientError ? `McpClientError ${error.code}` : String(error)}\n`,
  );
  process.exitCode = 1;
}
