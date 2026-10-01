/**
 * The signed-download GET transport for the server-component runtime.
 *
 * An action's `download()` result is minted into a signed reference by the
 * update pipeline; this module verifies that reference, re-derives the subject
 * from the current session, and opens the stored file. Every failure is a
 * value-free status/body pair.
 */

import type { Readable } from 'node:stream';

import type { JsonObject, RequestContext } from '../../contracts/http.js';
import { safeEqualStrings } from '../../security/constant-time.js';
import type { DownloadReferenceClaims, DownloadReferenceSigner } from '../downloads.js';
import type { ComponentSigner } from '../snapshot.js';
import type { UploadStore } from '../uploads.js';

/**
 * A download result from the runtime's `handleDownload`: a readable file
 * stream with its headers on success, or an error body.
 */
export interface ServerComponentDownloadResult {
  readonly status: number;
  readonly stream?: Readable;
  readonly contentType?: string;
  readonly filename?: string;
  readonly body?: JsonObject;
}

/** What the download transport reads from the assembled runtime. */
export interface DownloadTransportDeps {
  readonly signer: ComponentSigner;
  /** Both present only when uploads (and therefore downloads) are configured. */
  readonly downloadSigner: DownloadReferenceSigner | undefined;
  readonly store: UploadStore | ((storagePath: string) => UploadStore) | undefined;
}

function failure(status: number, code: string, message: string): ServerComponentDownloadResult {
  return { status, body: { error: { code, message } } };
}

/** Verify the `ref` query parameter and stream the stored file it names. */
export async function serveComponentDownload(
  context: RequestContext,
  deps: DownloadTransportDeps,
): Promise<ServerComponentDownloadResult> {
  if (deps.downloadSigner === undefined || deps.store === undefined) {
    return failure(400, 'bad_request', 'Bad request');
  }
  const ref = context.url.searchParams.get('ref');
  if (ref === null || ref === '') {
    return failure(400, 'bad_request', 'Bad request');
  }

  let claims: DownloadReferenceClaims;
  try {
    claims = deps.downloadSigner.verify(ref);
  } catch {
    return failure(403, 'forbidden', 'Forbidden');
  }

  // The token is bound to the derived subject tag at sign time; re-derive it
  // from the current session so a token minted for another subject (or a
  // session that has since changed) fails closed.
  const expectedSubject = deps.signer.subjectFor(context.session?.id ?? null);
  if (!safeEqualStrings(claims.subject ?? '', expectedSubject ?? '')) {
    return failure(403, 'forbidden', 'Forbidden');
  }

  const store =
    typeof deps.store === 'function' ? deps.store(context.storagePath ?? '') : deps.store;
  let stream: Readable;
  try {
    // `claims.subject` is the same derived tag the upload path wrote into
    // storage — never the raw session id — so the store resolves the same
    // subject directory at read time as at put time.
    const file = await store.open(claims.downloadId, claims.subject);
    if (file === null) {
      return failure(404, 'not_found', 'Not found');
    }
    stream = file;
  } catch {
    return failure(500, 'internal_error', 'Server error');
  }

  return { status: 200, stream, contentType: claims.contentType, filename: claims.filename };
}
