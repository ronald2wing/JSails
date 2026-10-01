/**
 * The signed-download GET transport for the server-component runtime, mounted
 * only through {@link downloadRoute}.
 *
 * An action's `download()` result is minted into a signed reference by the
 * update pipeline, carrying the authorized snapshot's envelope. The download
 * lane boundary verifies that reference, its origin and subject against the
 * current request, and re-runs the component's `authorize` against the page
 * and route params it was minted on: a reference is a capability for five
 * minutes, so the component's access policy is decided again at download time
 * rather than trusted from the moment it was minted. This module only reads
 * the `ref` query parameter and streams the stored file; the stream holds the
 * lane slot until it ends.
 */

import { Readable } from 'node:stream';

import type { DownloadReferenceClaims } from '../downloads.js';
import { contentDisposition } from '../../support/content-disposition.js';
import type { UploadStore } from '../uploads.js';
import {
  componentRoute,
  jsonResponse,
  laneFailure,
  type BoundaryDeps,
  type ComponentRead,
  type ComponentRoute,
} from './boundary.js';
import { resolveUploadStore } from './upload-transport.js';

/** What the download transport reads from the assembled runtime. */
export interface DownloadTransportDeps {
  readonly boundary: BoundaryDeps;
  /** Present only when downloads are configured. */
  readonly store: UploadStore | ((storagePath: string) => UploadStore) | undefined;
}

function failure(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

/** The download route: the `download` lane. */
export function downloadRoute(deps: DownloadTransportDeps): ComponentRoute {
  const configured = deps.boundary.verifyDownload !== undefined && deps.store !== undefined;
  return componentRoute<'download-ref', null>(
    {
      credential: 'download-ref',
      lane: 'download',
      streams: true,
      async read(request): Promise<ComponentRead<null>> {
        // Like an unconfigured upload lane, a runtime without downloads answers
        // `unavailable` rather than judging the request.
        if (!configured) {
          return { ok: false, failure: laneFailure('unavailable', 'Service unavailable') };
        }
        const ref = new URL(request.url).searchParams.get('ref');
        if (ref === null || ref === '') {
          return { ok: false, failure: laneFailure('invalid_request', 'Bad request') };
        }
        return { ok: true, token: ref, input: null };
      },
      async handle(authorized) {
        const claims: DownloadReferenceClaims = authorized.credential;
        let store: UploadStore;
        try {
          store = resolveUploadStore(deps.store, authorized.context.storagePath);
        } catch {
          return failure(503, 'unavailable', 'Service unavailable');
        }
        // `claims.subject` is the same derived tag the upload path wrote into
        // storage, never the raw session id, so the store resolves the same
        // subject directory at read time as at put time.
        const file = await store.open(claims.downloadId, claims.subject);
        if (file === null) {
          return failure(404, 'not_found', 'Not found');
        }
        return new Response(Readable.toWeb(file) as ReadableStream<Uint8Array>, {
          status: 200,
          headers: {
            'content-type': claims.contentType,
            'content-disposition': contentDisposition(claims.filename),
            'cache-control': 'no-store',
          },
        });
      },
    },
    deps.boundary,
  );
}
