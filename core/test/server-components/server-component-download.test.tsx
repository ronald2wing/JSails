/**
 * Server-component download integration: an action returning `download()` maps
 * to a signed download reference in the update response, and the download route
 * streams the stored file back (subject-scoped, authority-checked).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Readable } from 'node:stream';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { createUploadReferenceSigner } from '../../src/server-components/uploads.js';
import { createDownloadReferenceSigner } from '../../src/server-components/downloads.js';
import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import { download } from '../../src/server-components/downloads.js';
import { COMPONENT_SNAPSHOT_ATTRIBUTE } from '../../src/server-components/protocol.js';
import { h } from 'preact';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import { callDownload, callUpdate, updateBody } from './lane-calls.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

const downloader = defineServerComponent<{ title: string }>({
  name: 'Downloader',
  stateSchema: z.object({ title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { title: 'report' };
  },
  authorize() {
    return true;
  },
  actions: {
    go: defineAction({
      run() {
        return download('file-1', {
          filename: 'report.pdf',
          contentType: 'application/pdf',
        });
      },
    }),
    noop: defineAction({
      run() {
        // Returns undefined — no download.
      },
    }),
  },
  render(state) {
    return h('p', null, state.title);
  },
});

/** In-memory stand-in for `UploadStore`, keyed by subject + id. */
function makeMemoryStore(): {
  store: import('../../src/server-components/uploads.js').UploadStore;
  put(id: string, subject: string | null, bytes: Buffer): void;
} {
  const files = new Map<string, Buffer>();
  return {
    store: {
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream) chunks.push(Buffer.from(chunk));
        files.set(`${input.subject ?? 'anon'}/${input.id}`, Buffer.concat(chunks));
        return { size: chunks.reduce((n, c) => n + c.length, 0) };
      },
      async open(id, subject) {
        const buf = files.get(`${subject ?? 'anon'}/${id}`);
        return buf === undefined ? null : Readable.from([buf]);
      },
      async delete(id, subject) {
        files.delete(`${subject ?? 'anon'}/${id}`);
      },
    },
    put(id, subject, bytes) {
      files.set(`${subject ?? 'anon'}/${id}`, bytes);
    },
  };
}

function makeRuntime(memory: ReturnType<typeof makeMemoryStore>): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components: componentRegistryFromMap({ Downloader: downloader }),
    signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
    store: memory.store,
    uploads: { signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }) },
    downloads: { signer: createDownloadReferenceSigner({ key: KEY, now: () => 0 }) },
  });
}

function makeRequest(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

function renderContext(): RequestContext {
  const url = new URL(`${ORIGIN}/downloader`);
  return { request: makeRequest(url.toString()), url, params: {}, session: null };
}

function updateContext(): RequestContext {
  const url = new URL(`${ORIGIN}/downloader`);
  return {
    request: makeRequest(url.toString(), { origin: ORIGIN }, 'POST'),
    url,
    params: {},
    session: null,
  };
}

/** Resolve the runtime's relative download path to an absolute URL. */
function downloadRequestUrl(url: string): string {
  return new URL(url, ORIGIN).toString();
}

/** Build a request context whose URL is the absolute download URL. */
function downloadContext(url: string): RequestContext {
  const absolute = downloadRequestUrl(url);
  return { request: makeRequest(absolute), url: new URL(absolute), params: {}, session: null };
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name}`);
  return match[1]!;
}

describe('server-component downloads', () => {
  it('maps a download() action to a signed download reference in the update response', async () => {
    const memory = makeMemoryStore();
    memory.put('file-1', null, Buffer.from('pdf-bytes'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);

    const result = await callUpdate(
      runtime,
      updateBody({ snapshot, updates: { title: 'changed' }, action: { name: 'go' } }),
      updateContext(),
    );

    assert.equal(result.status, 200);
    const downloadRef = result.body.effects?.download;
    assert.ok(downloadRef, 'download must be present in the response body');
    assert.equal(downloadRef.filename, 'report.pdf');
    assert.match(downloadRef.url, /\/_jsails\/components\/download\?ref=/);
  });

  it('omits download when the action returns undefined', async () => {
    const memory = makeMemoryStore();
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);

    const result = await callUpdate(
      runtime,
      updateBody({ snapshot, updates: {}, action: { name: 'noop' } }),
      updateContext(),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.effects?.download, undefined, 'body must not carry a download');
  });

  it('the download route streams the file with attachment headers for a valid reference', async () => {
    const memory = makeMemoryStore();
    memory.put('file-1', null, Buffer.from('pdf-bytes'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const result = await callUpdate(
      runtime,
      updateBody({ snapshot, updates: {}, action: { name: 'go' } }),
      updateContext(),
    );
    const url = result.body.effects!.download!.url;

    const handleResult = await callDownload(runtime, downloadContext(url));

    assert.equal(handleResult.status, 200);
    assert.equal(handleResult.response.headers.get('content-type'), 'application/pdf');
    assert.match(
      handleResult.response.headers.get('content-disposition') ?? '',
      /attachment; filename="report\.pdf"/,
    );
    assert.equal(handleResult.response.headers.get('cache-control'), 'no-store');
    assert.equal(await handleResult.response.text(), 'pdf-bytes');
  });

  it('the download route rejects a tampered reference', async () => {
    const memory = makeMemoryStore();
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const result = await callUpdate(
      runtime,
      updateBody({ snapshot, updates: {}, action: { name: 'go' } }),
      updateContext(),
    );
    const url = result.body.effects!.download!.url;
    const tampered = url.replace(/ref=[^&]+/, 'ref=tampered');

    const handleResult = await callDownload(runtime, downloadContext(tampered));

    assert.equal(handleResult.status, 403);
  });

  it('the download route returns 404 for an unknown file id', async () => {
    const memory = makeMemoryStore();
    memory.put('other', null, Buffer.from('x'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const result = await callUpdate(
      runtime,
      updateBody({ snapshot, updates: {}, action: { name: 'go' } }),
      updateContext(),
    );
    const url = result.body.effects!.download!.url;

    const handleResult = await callDownload(runtime, downloadContext(url));

    assert.equal(handleResult.status, 404);
  });

  it('the download route accepts a reference minted under a retired key for the same session', async () => {
    const PREVIOUS_KEY = 'fedcba9876543210fedcba9876543210';
    const session = { id: 'session-1', data: {}, expiresAt: 1 };
    const previous = new HmacComponentSigner({ key: PREVIOUS_KEY, now: () => 0 });
    const oldTag = previous.subjectFor(session.id);
    const memory = makeMemoryStore();
    memory.put('file-1', oldTag, Buffer.from('rotated'));
    const runtime = createServerComponentsRuntime({
      components: componentRegistryFromMap({ Downloader: downloader }),
      signer: new HmacComponentSigner({ key: KEY, previousKeys: [PREVIOUS_KEY], now: () => 0 }),
      store: memory.store,
      uploads: { signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }) },
      downloads: {
        signer: createDownloadReferenceSigner({
          key: KEY,
          previousKeys: [PREVIOUS_KEY],
          now: () => 0,
        }),
      },
    });
    const ref = createDownloadReferenceSigner({ key: PREVIOUS_KEY, now: () => 0 }).sign({
      downloadId: 'file-1',
      component: 'Downloader',
      subject: oldTag,
      filename: 'report.pdf',
      contentType: 'application/pdf',
      origin: ORIGIN,
      page: { path: '/downloader', params: {} },
    });
    const url = new URL('/_jsails/components/download', ORIGIN);
    url.searchParams.set('ref', ref);
    const context: RequestContext = {
      request: makeRequest(url.toString()),
      url,
      params: {},
      session,
    };
    const result = await callDownload(runtime, context);
    assert.equal(result.status, 200);

    const stranger: RequestContext = { ...context, session: { ...session, id: 'session-2' } };
    assert.equal((await callDownload(runtime, stranger)).status, 403);
  });

  it('the download route refuses a reference whose component is unknown or no longer authorizes', async () => {
    let allowed = true;
    const gated = defineServerComponent({
      name: 'Gated',
      stateSchema: z.object({}).strict(),
      initialState() {
        return {};
      },
      authorize(context) {
        return allowed && context.session !== null;
      },
      render() {
        return null;
      },
    });
    const session = { id: 'session-1', data: {}, expiresAt: 1 };
    const signer = new HmacComponentSigner({ key: KEY, now: () => 0 });
    const tag = signer.subjectFor(session.id);
    const memory = makeMemoryStore();
    memory.put('file-1', tag, Buffer.from('secret'));
    const runtime = createServerComponentsRuntime({
      components: componentRegistryFromMap({ Gated: gated }),
      signer,
      store: memory.store,
      uploads: { signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }) },
      downloads: { signer: createDownloadReferenceSigner({ key: KEY, now: () => 0 }) },
    });
    const downloadSigner = createDownloadReferenceSigner({ key: KEY, now: () => 0 });
    const contextFor = (component: string): RequestContext => {
      const url = new URL('/_jsails/components/download', ORIGIN);
      url.searchParams.set(
        'ref',
        downloadSigner.sign({
          downloadId: 'file-1',
          component,
          subject: tag,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          origin: ORIGIN,
          page: { path: '/gated', params: {} },
        }),
      );
      return { request: makeRequest(url.toString()), url, params: {}, session };
    };

    const ok = contextFor('Gated');
    assert.equal((await callDownload(runtime, ok)).status, 200);

    // A component the runtime does not know: the reference names nothing it can authorize.
    const ghost = contextFor('Ghost');
    const unknown = await callDownload(runtime, ghost);
    assert.equal(unknown.status, 404);
    assert.match(unknown.response.headers.get('content-type') ?? '', /application\/json/);

    // The reference is still valid, but the component's policy now refuses the request.
    allowed = false;
    const revoked = await callDownload(runtime, ok);
    assert.equal(revoked.status, 403);
    assert.match(revoked.response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('the download route refuses a factory store without a storage path', async () => {
    const memory = makeMemoryStore();
    memory.put('file-1', null, Buffer.from('pdf-bytes'));
    const requestedPaths: string[] = [];
    const runtime = createServerComponentsRuntime({
      components: componentRegistryFromMap({ Downloader: downloader }),
      signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
      store: (storagePath) => {
        requestedPaths.push(storagePath);
        return memory.store;
      },
      uploads: { signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }) },
      downloads: { signer: createDownloadReferenceSigner({ key: KEY, now: () => 0 }) },
    });
    const ref = createDownloadReferenceSigner({ key: KEY, now: () => 0 }).sign({
      downloadId: 'file-1',
      component: 'Downloader',
      subject: null,
      filename: 'report.pdf',
      contentType: 'application/pdf',
      origin: ORIGIN,
      page: { path: '/downloader', params: {} },
    });
    const url = new URL('/_jsails/components/download', ORIGIN);
    url.searchParams.set('ref', ref);
    const context: RequestContext = {
      request: makeRequest(url.toString()),
      url,
      params: {},
      session: null,
    };

    const refused = await callDownload(runtime, context);
    assert.equal(refused.status, 503);
    // The factory is never asked for a store rooted at '' (the working directory).
    assert.deepEqual(requestedPaths, []);

    const rooted = { ...context, storagePath: '/srv/app/storage' };
    assert.equal((await callDownload(runtime, rooted)).status, 200);
    assert.deepEqual(requestedPaths, ['/srv/app/storage']);
  });
});
