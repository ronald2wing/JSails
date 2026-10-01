// Live reactivity layer barrel (`jsails/live`).
//
// Phase 1 exposes the wire record and the metadata-driven projection; Phase 2
// adds the publication contract and its name-keyed registry; Phase 4 adds the
// change log, the write fence, the multiplexer, and canonical params; Phase 5
// adds the live service. This barrel is server-only (its modules import
// TypeORM), so it is profiled like `jsails/database`.
export {
  isLiveChange,
  type LiveChange,
  type LiveChangeOperation,
  type LiveRow,
} from './change-record.js';
export {
  createChangeCapture,
  type ChangeCaptureHandle,
  type ChangeCaptureOptions,
  type LiveChangeListener,
  type LiveErrorListener,
} from './change-capture.js';
export { projectRow } from './projection.js';
export {
  definePublication,
  PublicationDefinitionError,
  type LiveRequestInfo,
  type LiveUser,
  type PublicationAuthContext,
  type PublicationDefinition,
  type PublicationQueryContext,
} from './publication.js';
export {
  createPublicationRegistry,
  publicationRegistryToken,
  PublicationRegistryError,
  type ErasedPublication,
  type PublicationRegistry,
} from './publication-registry.js';
export {
  createInMemoryChangeLog,
  type ChangeLog,
  type InMemoryChangeLogOptions,
  type ChangeLogSlice,
} from './change-log.js';
export { createWriteFence, type WriteFence } from './write-fence.js';
export { createMultiplexer, type Multiplexer, type LiveChangeHandler } from './multiplexer.js';
export { canonicalParams, type CanonicalParamsValue } from './canonical-params.js';
export {
  assertPublicationShape,
  createLiveService,
  PublicationShapeError,
  type LiveServerMessage,
  type LiveService,
  type LiveServiceOptions,
  type LiveSubscribeRequest,
  type LiveSubscriptionHandle,
  type PublicationShapeErrorCode,
} from './live-service.js';
