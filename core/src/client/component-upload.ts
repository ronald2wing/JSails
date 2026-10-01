/**
 * XHR transport for a server-component file upload.
 *
 * Uploads go through `XMLHttpRequest` rather than `fetch` because only XHR
 * reports upload progress. This module performs one multipart POST to the
 * upload endpoint and classifies the outcome; the component controller owns
 * queueing, the dirty diff, and the value-free error it surfaces.
 *
 * Browser-safe and Node-import safe: the XHR surface is declared structurally
 * (no DOM lib) and never touched at import time.
 */

import { isPlainObject } from '../json/shape.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
} from '../server-components/protocol.js';
import { MAX_UPLOAD_RESPONSE_BODY_LENGTH } from './decoding/limits.js';

/** A file the client can upload: a Blob carrying a readable name. */
export type ComponentUploadFile = Blob & { readonly name: string };

/** Progress on an in-flight upload. */
export interface ComponentUploadProgress {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}

/**
 * The slice of `XMLHttpRequest` the upload transport touches. A real
 * `XMLHttpRequest` satisfies every member; `upload.onprogress` carries the
 * upload progress events.
 */
export interface ComponentUploadXhr {
  readonly upload: {
    onprogress: ((event: ComponentUploadProgress) => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  readonly status: number;
  readonly responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
}

/** Injectable XHR factory; defaults to the platform `XMLHttpRequest`. */
export type ComponentUploadXhrFactory = () => ComponentUploadXhr;

/** Why an upload did not produce a reference. */
type ComponentUploadFailure = 'failed' | 'unexpected_response' | 'aborted';

/** The classified result of one upload request. */
type ComponentUploadOutcome =
  | { readonly ok: true; readonly reference: string }
  | { readonly ok: false; readonly failure: ComponentUploadFailure };

/** One upload request: where to send it and what to send. */
interface ComponentUploadRequest {
  readonly endpoint: string;
  readonly csrfToken: string;
  /** Snapshot token the server verifies before accepting the file. */
  readonly snapshot: string;
  readonly file: ComponentUploadFile;
  /** Receives each progress event; its own failure never disturbs the upload. */
  readonly onProgress?: (progress: ComponentUploadProgress) => void;
}

/**
 * Send one upload over `xhr` and settle exactly once: with the signed
 * reference on a 201 carrying `{ reference }`, otherwise with the failure
 * kind. Never rejects.
 */
export function sendComponentUpload(
  xhr: ComponentUploadXhr,
  request: ComponentUploadRequest,
): Promise<ComponentUploadOutcome> {
  return new Promise<ComponentUploadOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ComponentUploadOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    const fail = (failure: ComponentUploadFailure): void => {
      settle({ ok: false, failure });
    };

    const { onProgress } = request;
    xhr.upload.onprogress = (progress) => {
      if (onProgress === undefined) {
        return;
      }
      try {
        onProgress(progress);
      } catch {
        // The observer's own failure must not disturb the upload.
      }
    };

    xhr.onload = () => {
      if (xhr.responseText.length > MAX_UPLOAD_RESPONSE_BODY_LENGTH) {
        fail('unexpected_response');
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(xhr.responseText);
      } catch {
        fail('unexpected_response');
        return;
      }
      if (xhr.status !== 201) {
        fail('failed');
        return;
      }
      const reference = isPlainObject(envelope) ? envelope.reference : undefined;
      if (typeof reference !== 'string' || reference.length === 0) {
        fail('unexpected_response');
        return;
      }
      settle({ ok: true, reference });
    };
    xhr.onerror = () => {
      fail('failed');
    };
    xhr.onabort = () => {
      fail('aborted');
    };

    const formData = new FormData();
    formData.append(COMPONENT_UPLOAD_SNAPSHOT_FIELD, request.snapshot);
    formData.append(COMPONENT_UPLOAD_FILE_FIELD, request.file, request.file.name);
    try {
      xhr.open('POST', request.endpoint);
      xhr.setRequestHeader(COMPONENT_CSRF_HEADER, request.csrfToken);
      xhr.send(formData);
    } catch {
      fail('failed');
    }
  });
}
