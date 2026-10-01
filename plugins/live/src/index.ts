/** Live reactivity transport surface (`@jsails/live`). */

// The contract lives in core (`jsails/live`); the plugin re-exports it so an
// app config imports one specifier for both the contract and the transport.
export {
  assertPublicationShape,
  canonicalParams,
  createInMemoryChangeLog,
  createLiveService,
  createMultiplexer,
  createPublicationRegistry,
  createWriteFence,
  definePublication,
  isLiveChange,
  projectRow,
  publicationRegistryToken,
  PublicationDefinitionError,
  PublicationRegistryError,
  PublicationShapeError,
  type ChangeLog,
  type ChangeLogSlice,
  type ErasedPublication,
  type LiveChange,
  type LiveChangeOperation,
  type LiveRow,
  type LiveServerMessage,
  type LiveService,
  type LiveServiceOptions,
  type LiveSubscribeRequest,
  type LiveSubscriptionHandle,
  type LiveUser,
  type PublicationAuthContext,
  type PublicationDefinition,
  type PublicationQueryContext,
  type PublicationRegistry,
  type PublicationShapeErrorCode,
} from 'jsails/live';

export {
  attachLiveSocket,
  LIVE_PATH,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from './socket-adapter.js';
export { livePlugin, type LivePluginOptions } from './plugin.js';
export { livePlugin as default } from './plugin.js';
export {
  createValkeyChangeLog,
  parseEntries,
  readStreamSlice,
  ValkeyChangeLogError,
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
