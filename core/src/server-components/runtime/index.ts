/**
 * Barrel for the server-components runtime: the runtime factory, its HTTP-facing
 * result types, the upload/download transports, and the value-free error class.
 */

export {
  createServerComponentsRuntime,
  type ServerComponentRenderOptions,
  type ServerComponentsRuntime,
  type ServerComponentsRuntimeOptions,
  type ServerComponentUpdateOptions,
} from './create-runtime.js';
export type { ServerComponentDownloadResult } from './download-transport.js';
export type {
  ResolveUploadOptions,
  ResolvedUpload,
  ServerComponentUploadOptions,
} from './upload-transport.js';
export {
  ServerComponentRuntimeError,
  type ServerComponentUpdateResult,
  type ServerComponentUploadResult,
} from './value-errors.js';
