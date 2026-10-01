/**
 * Live reactivity engine and transport (`@jsails/live`).
 *
 * The contract it implements — publications, the registry, change capture, the
 * wire record and server message, the `ChangeLog` interface — is `jsails/live`.
 * This package supplies the live service, the two change logs, the Socket.IO
 * transport, and the `live` plugin that wires them onto an application. It is
 * server-only; browser islands import `@jsails/live/client`.
 */

export {
  createLiveService,
  type LiveService,
  type LiveServiceOptions,
  type LiveSubscribeRequest,
  type LiveSubscriptionHandle,
} from './live-service.js';
export { createInMemoryChangeLog, type InMemoryChangeLogOptions } from './in-memory-change-log.js';
export {
  attachLiveSocket,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from './socket-transport.js';
export { livePlugin, type LivePluginOptions } from './plugin.js';
export { livePlugin as default } from './plugin.js';
export {
  createValkeyChangeLog,
  ValkeyChangeLogError,
  type ValkeyChangeLog,
  type ValkeyChangeLogErrorCode,
  type ValkeyChangeLogOptions,
  type ValkeyLiveClient,
} from './valkey-change-log.js';
export {
  createStreamTailer,
  createValkeyChangeBus,
  type StreamTailer,
  type StreamTailerOptions,
  type ValkeyBusClient,
  type ValkeyChangeBus,
  type ValkeyChangeBusOptions,
} from './valkey-change-bus.js';
