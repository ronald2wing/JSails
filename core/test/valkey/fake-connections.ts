/**
 * A recording stand-in for the app's `ValkeyConnections`, for tests of the
 * provider's consumers that never reach a server: each role hands out a stub
 * client (or the one a test supplies), and every request and disconnect is
 * recorded.
 */

import type {
  DedicatedValkeyRole,
  SharedValkeyRole,
  ValkeyClient,
  ValkeyConnections,
  ValkeyScriptDefinition,
} from '../../src/valkey/connections.js';

/** A stub client: counts disconnects, answers nothing else. */
export interface StubValkeyClient {
  readonly label: string;
  disconnects: number;
  disconnect(): void;
}

/** A dedicated client a consumer asked for. */
export interface DedicatedRequest {
  readonly role: DedicatedValkeyRole;
  readonly name: string;
  readonly client: StubValkeyClient;
}

/** The fake provider and what it recorded. */
export interface FakeConnections {
  readonly connections: ValkeyConnections;
  readonly sharedRequests: SharedValkeyRole[];
  readonly dedicatedRequests: DedicatedRequest[];
  readonly scripts: ValkeyScriptDefinition[];
  /** The stub shared client of each role, created on first request. */
  readonly sharedClients: Map<SharedValkeyRole, StubValkeyClient>;
  closes: number;
}

function stubClient(label: string): StubValkeyClient {
  const client: StubValkeyClient = {
    label,
    disconnects: 0,
    disconnect() {
      client.disconnects += 1;
    },
  };
  return client;
}

/** Create a {@link FakeConnections} keyed under `prefix`. */
export function fakeConnections(prefix = 'test-app:test'): FakeConnections {
  const fake: FakeConnections = {
    sharedRequests: [],
    dedicatedRequests: [],
    scripts: [],
    sharedClients: new Map(),
    closes: 0,
    connections: Object.freeze({
      prefix,
      shared(role: SharedValkeyRole): Promise<ValkeyClient> {
        fake.sharedRequests.push(role);
        let client = fake.sharedClients.get(role);
        if (client === undefined) {
          client = stubClient(role);
          fake.sharedClients.set(role, client);
        }
        return Promise.resolve(client as unknown as ValkeyClient);
      },
      dedicated(role: DedicatedValkeyRole, name: string): Promise<ValkeyClient> {
        const client = stubClient(`${role}:${name}`);
        fake.dedicatedRequests.push({ role, name, client });
        return Promise.resolve(client as unknown as ValkeyClient);
      },
      script(definition: ValkeyScriptDefinition) {
        fake.scripts.push(definition);
        return { run: () => Promise.reject(new Error('the fake provider runs no scripts')) };
      },
      close() {
        fake.closes += 1;
        return Promise.resolve();
      },
    }),
  };
  return fake;
}
