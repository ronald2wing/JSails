/**
 * Live reactivity contract (`jsails/live`): the wire record and server message,
 * post-commit change capture, row projection, the publication contract and its
 * registry, and the change log interface. The server engine (live service,
 * write fence, change log backends) and the transport live in `@jsails/live`.
 * Server-only: these modules import TypeORM.
 */

export {
  isLiveChange,
  type LiveChange,
  type LiveChangeOperation,
  type LiveRow,
} from './change-record.js';
export type { LiveServerMessage } from './server-message.js';
export {
  createChangeCapture,
  type ChangeCaptureHandle,
  type ChangeCaptureOptions,
  type LiveChangeListener,
  type LiveErrorListener,
} from './change-capture.js';
export { fieldProjector, projectRow } from './projection.js';
export {
  assertPublicationShape,
  definePublication,
  PublicationDefinitionError,
  PublicationShapeError,
  type LiveRequestInfo,
  type LiveUser,
  type PublicationAuthContext,
  type PublicationDefinition,
  type PublicationField,
  type PublicationQueryContext,
  type PublicationShapeErrorCode,
} from './publication.js';
export {
  createPublicationRegistry,
  publicationRegistryToken,
  PublicationRegistryError,
  type ErasedPublication,
  type PublicationRegistry,
} from './publication-registry.js';
export type { ChangeLog, ChangeLogSlice } from './change-log.js';
