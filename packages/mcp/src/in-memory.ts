/**
 * The testing client: {@link connectInMemory} serves a defined server and
 * connects the real client to it over a linked in-memory transport, in one
 * process, with no socket and no child.
 *
 * The server side is the same dual-era entry `serveMcpStdio` uses, so the
 * opening message picks the era exactly as on stdio and one factory unit is
 * pinned for the connection: `protocol: 'modern'` exercises the 2026-07-28
 * revision (multi-round-trip input, sealed request state), `'legacy'` the
 * 2025 handshake (input through the SDK's legacy shim and real elicitation
 * requests), and `'auto'` the probe a deployed client runs. What a test sees
 * is what a remote client would see: the same listing, outcomes, and errors.
 */

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { parseActor, type McpActor } from './access.js';
import type { McpServerDefinition } from './definitions.js';
import { McpClientError } from './errors.js';
import {
  checkRemoteOptions,
  openRemote,
  type McpRemoteOptions,
  type McpRemoteServer,
} from './remote-client.js';
import { MessageGuard } from './remote-transport.js';
import {
  createMcpServerFactory,
  reporter,
  type McpServingOptions,
  type Site,
} from './server-factory.js';

/** Options for {@link connectInMemory}. */
export interface McpInMemoryOptions extends McpRemoteOptions {
  /** Who the server sees calling. Default: an anonymous actor with no scopes. */
  readonly actor?: McpActor;
  /** How the server is served (gate, error hook, limits), as for any transport. */
  readonly serving?: McpServingOptions;
}

const ANONYMOUS: McpActor = Object.freeze({ kind: 'anonymous', scopes: Object.freeze([]) });
const TRANSPORT: Site = Object.freeze({ kind: 'transport', name: 'in-memory' });

/**
 * Serve `server` and connect a client to it in this process. Throws
 * {@link McpClientError} for malformed client options or a failed connection,
 * and `McpDefinitionError` for every reason the server factory refuses the
 * definition or the serving options.
 */
export async function connectInMemory(
  server: McpServerDefinition,
  options: McpInMemoryOptions = {},
): Promise<McpRemoteServer> {
  const settings = checkRemoteOptions(options, ['actor', 'serving']);
  const actor = options.actor === undefined ? ANONYMOUS : parseActor(options.actor);
  if (actor === undefined) {
    throw new McpClientError(
      'invalid_option',
      'actor must be an actor with a known kind, a non-empty id when given, and string scopes or "*"',
    );
  }
  const serving = options.serving ?? {};
  const factory = createMcpServerFactory(server, serving);
  const report = reporter(serving.onError);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio((ctx) => factory({ actor, era: ctx.era, channel: 'connected' }), {
    legacy: 'serve',
    transport: serverSide,
    onerror: (error) => {
      report('transport_error', 'the in-memory transport reported an error', TRANSPORT, error);
    },
  });
  const guard = new MessageGuard(settings.maxResultBytes);
  return openRemote(clientSide, settings, guard, () => handle.close());
}
