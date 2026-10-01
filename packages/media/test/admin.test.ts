/**
 * Media admin tests.
 *
 * The list/search/edit/delete flows drive the media admin plugin (`mediaAdmin`)
 * through a real in-process `Application`: the admin plugin registers the
 * trusted Hono routes and every request is routed through the same pipeline
 * `serve` uses. Uploads are covered both through the real multipart admin route
 * (which now hands file parts through `AdminPagePostContext`) and against the
 * page handler directly for focused failure cases. The library is built over
 * an in-memory {@link MemoryDisk} and {@link createMemoryMediaIndex}, so no
 * filesystem or network is ever touched.
 *
 * Covered:
 *
 * - `mediaAdmin` returns an admin plugin (id `media`) whose page is slug `media`
 *   and label `Media`;
 * - GET lists assets, honors `q` search via `selectMedia`, and renders the
 *   upload/search forms and the asset table (filename, MIME, size, alt, created
 *   date, per-row Edit/Delete);
 * - `?edit=<id>` renders an edit form pre-filled with the current alt/caption;
 * - POST `upload` reads a multipart body (native `FormData`/`File`) and stores
 *   the first file part, ignoring client-supplied size/width/height;
 * - POST `update` patches alt/caption and 404s a missing id;
 * - POST `delete` removes the asset; a missing id maps the `not_found` media
 *   failure to a 404;
 * - an unsupported type / over-size payload fails value-free (no filename, id,
 *   MIME type, or error detail echoed in the response);
 * - `directUrls` redirects downloads and previews to a signed URL only when
 *   enabled and the disk can sign, and is validated at construction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDisk } from '@jsails/filesystem';
import { readBytes } from 'jsails/filesystem';
import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import type { AdminPagePostContext, AdminPageRenderContext } from '@jsails/admin';
import { createTestApp, createTestSession, postForm, type TestApplication } from 'jsails/testing';

import {
  MediaLibraryError,
  createMediaLibrary,
  createMemoryMediaIndex,
  type MediaAsset,
  type MediaLibrary,
} from '../src/index.js';
import { mediaAdmin } from '../src/admin/index.js';
import { defineMediaAdminPage, type MediaAdminPageOptions } from '../src/admin/page.js';
import {
  JPEG_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  pngOfSize,
  sendDoubleS3Disk,
  signingMemoryDisk,
} from './fixtures.js';

/** Drive the page's GET hook directly, bypassing the panel routes. */
async function handleMediaGet(
  context: AdminPageRenderContext,
  options: MediaAdminPageOptions,
): Promise<Response | undefined> {
  const handleGet = defineMediaAdminPage(options).handleGet;
  assert.ok(handleGet, 'the media page defines a GET hook');
  return handleGet(context);
}

/** Drive the page's POST hook directly, bypassing the panel routes. */
async function handleMediaPost(
  context: AdminPagePostContext,
  options: MediaAdminPageOptions,
): Promise<Response> {
  const handlePost = defineMediaAdminPage(options).handlePost;
  assert.ok(handlePost, 'the media page defines a POST hook');
  return handlePost(context);
}

const STUB_ASSET: MediaAsset = Object.freeze({
  id: 'stub',
  disk: 'local',
  path: 'media/stub/stub.png',
  filename: 'stub.png',
  mimeType: 'image/png',
  size: 4,
  alt: '',
  caption: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const SESSION = createTestSession({ id: 'admin-session-1' });

/** Build a media library over a fresh memory disk with a deterministic id clock. */
function makeLibrary(options?: { maxBytes?: number; allowedTypes?: readonly string[] }): {
  library: MediaLibrary;
  disk: MemoryDisk;
} {
  const disk = new MemoryDisk();
  let sequence = 0;
  const library = createMediaLibrary({
    disk,
    diskName: 'local',
    metadata: createMemoryMediaIndex(),
    maxBytes: options?.maxBytes,
    allowedTypes: options?.allowedTypes,
    nextId: () => `asset-${(sequence += 1)}`,
  });
  return { library, disk };
}

/** Build a test app mounting the media admin page over the given library. */
function makeApp(
  library: MediaLibrary,
  options?: Pick<
    MediaAdminPageOptions,
    'previewLimitBytes' | 'directUrls' | 'authorize' | 'maxBodyBytes'
  >,
): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      // The app's own sessions, which the panel reads too.
      resolveSession: () => SESSION,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            adminPlugins: [mediaAdmin({ library, authorize: () => true, ...options })],
          }),
        ),
      ],
    },
  });
}

/**
 * Build a fresh native `Request` carrying a multipart body with one file part.
 * This is the raw multipart field parsing seam: the request is consumed exactly
 * once by `readFormBodyAndFiles`, which is how the page's `handlePost` recovers
 * the uploaded bytes.
 */
function multipartRequest(
  file: { name: string; type: string; bytes: Uint8Array },
  fields: Record<string, string>,
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  const buffer = new ArrayBuffer(file.bytes.byteLength);
  new Uint8Array(buffer).set(file.bytes);
  form.set('file', new File([buffer], file.name, { type: file.type }));
  return new Request('http://localhost/admin/media', { method: 'POST', body: form });
}

/** A synthetic `AdminPagePostContext` around a request and the parsed string body. */
function postContext(request: Request, body: Record<string, string>): AdminPagePostContext {
  return {
    session: SESSION,
    path: '/admin',
    request,
    url: new URL(request.url),
    body,
  };
}

/** A synthetic `AdminPageRenderContext` around a URL. */
function getContext(url: string): AdminPageRenderContext {
  const request = new Request(url);
  return {
    session: SESSION,
    path: '/admin',
    request,
    url: new URL(request.url),
  };
}

describe('mediaAdmin', () => {
  it('returns an admin plugin with id "media" and one page slug "media"', () => {
    const { library } = makeLibrary();
    const plugin = mediaAdmin({ library });
    assert.equal(plugin.id, 'media');
    assert.equal(typeof plugin.register, 'function');
    const pages: string[] = [];
    plugin.register({
      addPage: (page) => {
        pages.push(page.slug);
      },
      addNavigationItem: () => {},
      addResource: () => {},
    });
    assert.deepEqual(pages, ['media']);
  });

  it('serves the page only to a session its own authorize admits', async () => {
    const { library } = makeLibrary();
    const denied = await makeApp(library, { authorize: undefined });
    assert.equal((await denied.request('/admin/media')).status, 403);
    await denied.close();

    const seen: string[] = [];
    const gated = await makeApp(library, {
      authorize: ({ session, slug }) => {
        seen.push(`${session.id}:${slug}`);
        return false;
      },
    });
    assert.equal((await gated.request('/admin/media')).status, 403);
    assert.deepEqual(seen, ['admin-session-1:media']);
    await gated.close();

    assert.throws(
      () => mediaAdmin({ library, authorize: true as unknown as () => boolean }),
      /authorize must be a function/,
    );
  });

  it('rejects a missing library', () => {
    assert.throws(
      () => mediaAdmin({ library: undefined as unknown as MediaLibrary }),
      /mediaAdmin requires a media library/,
    );
  });
});

describe('media admin page (render)', () => {
  it('lists uploaded assets with filename, type, size, alt, and created date', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'A hero image',
      caption: 'The banner',
    });
    const app = await makeApp(library);

    const response = await app.request('/admin/media');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /hero\.png/);
    assert.match(html, /image\/png/);
    assert.match(html, /A hero image/);
    assert.match(html, /Edit/);
    assert.match(html, /Delete/);
    assert.match(html, /Upload/);
  });

  it('filters the listing by the q search parameter', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    await library.upload({
      bytes: JPEG_BYTES,
      filename: 'logo.jpg',
      mimeType: 'image/jpeg',
      alt: 'Company logo',
    });
    const app = await makeApp(library);

    const matched = await (await app.request('/admin/media?q=logo')).text();
    assert.match(matched, /logo\.jpg/);
    assert.doesNotMatch(matched, /hero\.png/);

    const altMatched = await (await app.request('/admin/media?q=company')).text();
    assert.match(altMatched, /logo\.jpg/);
    assert.doesNotMatch(altMatched, /hero\.png/);
  });

  it('renders an edit form pre-filled with current alt/caption for ?edit=<id>', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'Original alt',
      caption: 'Original caption',
    });
    const app = await makeApp(library);

    const html = await (await app.request(`/admin/media?edit=${asset.id}`)).text();
    assert.match(html, /value="Original alt"/);
    assert.match(html, /Original caption/);
    assert.match(html, /Save/);
    assert.match(html, /Cancel/);
  });
});

describe('media admin page (preview and download)', () => {
  it('renders a lazy thumbnail from the preview route, never inlined bytes', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'A hero image',
    });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /<img[^>]+src="\/admin\/media\?preview=asset-1"/);
    assert.match(html, /<img[^>]+loading="lazy"/);
    assert.match(html, /<img[^>]+alt="A hero image"/);
    assert.doesNotMatch(html, /data:image\/png;base64,/);
  });

  it('never reads asset bytes to render the list', async () => {
    const { library, disk } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    let reads = 0;
    const read = disk.read.bind(disk);
    disk.read = async (key, options) => {
      reads += 1;
      return read(key, options);
    };
    const app = await makeApp(library);

    const response = await app.request('/admin/media');
    assert.equal(response.status, 200);
    assert.equal(reads, 0);
    await app.close();
  });

  it('serves the preview route inline under a locked-down CSP', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?preview=asset-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
    await app.close();
  });

  it('refuses a preview of a non-previewable or over-size asset', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/*', 'application/pdf'] });
    await library.upload({ bytes: PDF_BYTES, filename: 'doc.pdf', mimeType: 'application/pdf' });
    await library.upload({
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      filename: 'evil.svg',
      mimeType: 'image/svg+xml',
    });
    await library.upload({ bytes: pngOfSize(1024), filename: 'big.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: 512 });

    for (const id of ['asset-1', 'asset-2', 'asset-3', 'missing']) {
      const response = await app.request(`/admin/media?preview=${id}`);
      assert.equal(response.status, 404, id);
    }
    await app.close();
  });

  it('does not render a thumbnail for an over-size asset', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: pngOfSize(1024), filename: 'big.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: 16 });

    const html = await (await app.request('/admin/media')).text();
    assert.doesNotMatch(html, /preview=asset-1/);
    assert.match(html, /Too large to preview\./);
    assert.match(html, /big\.png/);
  });

  it('renders a placeholder (not an img) for a non-image type', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PDF_BYTES, filename: 'report.pdf', mimeType: 'application/pdf' });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /report\.pdf/);
    assert.doesNotMatch(html, /<img/);
  });

  it('never renders SVG as an image, even when allowed by the library', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/*'] });
    await library.upload({
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      filename: 'evil.svg',
      mimeType: 'image/svg+xml',
    });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /evil\.svg/);
    assert.doesNotMatch(html, /<img/);
  });

  it('honors the preview limit boundary at exactly the limit', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'edge.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: PNG_BYTES.byteLength });

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /preview=asset-1/);
  });

  it('pages the HTML list', async () => {
    const { library } = makeLibrary();
    for (let i = 0; i < 51; i += 1) {
      const name = `file-${String(i).padStart(2, '0')}.png`;
      await library.upload({ bytes: PNG_BYTES, filename: name, mimeType: 'image/png' });
    }
    const app = await makeApp(library);

    const first = await (await app.request('/admin/media')).text();
    assert.match(first, /file-49\.png/);
    assert.doesNotMatch(first, /file-50\.png/);
    assert.match(first, /Page 1 of 2 \(51 assets\)/);
    assert.match(first, /href="\/admin\/media\?page=2"/);

    const second = await (await app.request('/admin/media?page=2')).text();
    assert.match(second, /file-50\.png/);
    assert.doesNotMatch(second, /file-00\.png/);
    await app.close();
  });

  it('renders a download link to the streaming route, not an inline data URL', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /<a[^>]+href="\/admin\/media\?download=asset-1"[^>]*>Download<\/a>/);
    assert.doesNotMatch(html, /data:/);
  });

  it('renders a download link for an over-size asset (no disabled note)', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: pngOfSize(1024), filename: 'big.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: 16 });

    const html = await (await app.request('/admin/media')).text();
    // The preview is suppressed, but the download link is still present and
    // carries no inline bytes.
    assert.doesNotMatch(html, /href="data:image\/png;base64,/);
    assert.doesNotMatch(html, /admin-download-disabled/);
    assert.match(html, /<a[^>]+href="\/admin\/media\?download=asset-1"[^>]*>Download<\/a>/);
  });
});

describe('media admin page (download route)', () => {
  it('streams image bytes with the recorded MIME, disposition, and length', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
    });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=asset-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /attachment; filename="hero\.png"/,
    );
    assert.equal(response.headers.get('content-length'), String(PNG_BYTES.byteLength));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    // An upload served from the admin origin is never sniffed into something
    // the browser would run, nor rendered as a page if it were.
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, PNG_BYTES);
    await app.close();
  });

  it('streams from the disk without buffering and answers a byte range with 206', async () => {
    const { library, disk } = makeLibrary();
    const bytes = pngOfSize(200);
    await library.upload({ bytes, filename: 'big.png', mimeType: 'image/png' });
    const ranges: unknown[] = [];
    const read = disk.read.bind(disk);
    disk.read = async (key, options) => {
      ranges.push(options?.range);
      return read(key, options);
    };
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=asset-1', {
      headers: { range: 'bytes=100-149' },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 100-149/200');
    assert.equal(response.headers.get('content-length'), '50');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.subarray(100, 150));

    const unsatisfiable = await app.request('/admin/media?download=asset-1', {
      headers: { range: 'bytes=500-' },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */200');
    assert.deepEqual(
      ranges,
      [{ start: 100, end: 149 }, { start: 500 }],
      'each download asks the disk for only its range',
    );
    await app.close();
  });

  it('streams a PDF with its recorded MIME type', async () => {
    const { library } = makeLibrary();
    const pdf = PDF_BYTES;
    await library.upload({ bytes: pdf, filename: 'report.pdf', mimeType: 'application/pdf' });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=asset-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /attachment; filename="report\.pdf"/,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
    await app.close();
  });

  it('streams an SVG (when the library allows it) with its recorded MIME type', async () => {
    const { library } = makeLibrary({ allowedTypes: ['image/*'] });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await library.upload({ bytes: svg, filename: 'drawing.svg', mimeType: 'image/svg+xml' });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=asset-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /attachment; filename="drawing\.svg"/,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), svg);
    await app.close();
  });

  it('404s a missing id without echoing it', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=does-not-exist');
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /does-not-exist/);
    await app.close();
  });

  it('maps a library/disk failure to a value-free 500', async () => {
    const failing: MediaLibrary = {
      upload: async () => {
        throw new Error('unused');
      },
      list: async () => [],
      query: async () => ({ assets: [], total: 0 }),
      get: async () => STUB_ASSET,
      stream: async () => {
        throw new MediaLibraryError('io_failed', 'disk operation failed');
      },
      content: async () => {
        throw new MediaLibraryError('io_failed', 'disk operation failed');
      },
      update: async () => undefined,
      remove: async () => {},
    };

    const response = await handleMediaGet(
      getContext('http://localhost/admin/media?download=secret-download-id'),
      {
        library: failing,
      },
    );
    assert.ok(response, 'download failure still produces a Response');
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /disk operation failed/);
    assert.doesNotMatch(text, /secret-download-id/);
  });

  it('neutralizes a hostile filename in the Content-Disposition header', async () => {
    const injected = 'quote"name\r\nX-Evil: injected.png';
    const hostile: MediaLibrary = {
      upload: async () => {
        throw new Error('unused');
      },
      list: async () => [],
      query: async () => ({ assets: [], total: 0 }),
      get: async () => ({ ...STUB_ASSET, filename: injected }),
      stream: async () => ({
        stream: new Blob([new Uint8Array(PNG_BYTES)]).stream(),
        size: PNG_BYTES.byteLength,
        start: 0,
        end: PNG_BYTES.byteLength - 1,
        mimeType: 'image/png',
        filename: injected,
      }),
      content: async () => ({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        filename: injected,
      }),
      update: async () => undefined,
      remove: async () => {},
    };

    const response = await handleMediaGet(getContext('http://localhost/admin/media?download=y'), {
      library: hostile,
    });
    assert.ok(response, 'hostile download still produces a Response');
    assert.equal(response.status, 200);
    const disposition = response.headers.get('content-disposition') ?? '';
    // The quoted ASCII fallback escapes the double quote and turns CR/LF into
    // underscores, so the header can never terminate early or inject a sibling.
    assert.match(disposition, /filename="quote\\"name__X-Evil: injected\.png"/);
    // No raw CR/LF survives anywhere in the header value.
    assert.doesNotMatch(disposition, /\r|\n/);
  });

  it('renders the HTML list when the download query is absent', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const response = await app.request('/admin/media');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /hero\.png/);
    await app.close();
  });

  it('renders the HTML list when the download query is empty', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    await app.close();
  });

  it('never renders a data: download link in the table', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PDF_BYTES,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.doesNotMatch(html, /<a[^>]+href="data:/);
    await app.close();
  });
});

describe('media admin page (json picker)', () => {
  it('returns selected assets as a stable application/json array with public metadata', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'A hero image',
      caption: 'The banner',
    });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?format=json');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const page = (await response.json()) as { assets: Record<string, unknown>[]; total: number };
    const entries = page.assets;

    assert.equal(page.total, 1);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.deepEqual(Object.keys(entry).sort(), [
      'alt',
      'caption',
      'createdAt',
      'filename',
      'height',
      'id',
      'mimeType',
      'size',
      'width',
    ]);
    assert.equal(entry.id, 'asset-1');
    assert.equal(entry.filename, 'hero.png');
    assert.equal(entry.mimeType, 'image/png');
    assert.equal(entry.size, PNG_BYTES.byteLength);
    assert.equal(entry.alt, 'A hero image');
    assert.equal(entry.caption, 'The banner');
    assert.equal(typeof entry.createdAt, 'string');
    // No disk path, disk name, or bytes are ever exposed.
    assert.equal('path' in entry, false);
    assert.equal('disk' in entry, false);
    await app.close();
  });

  it('includes width/height only when recorded', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PDF_BYTES,
      filename: 'sized.pdf',
      mimeType: 'application/pdf',
      width: 320,
      height: 240,
    });
    await library.upload({
      bytes: PDF_BYTES,
      filename: 'plain.pdf',
      mimeType: 'application/pdf',
    });
    const app = await makeApp(library);

    const entries = (
      (await (await app.request('/admin/media?format=json')).json()) as {
        assets: Record<string, unknown>[];
      }
    ).assets;
    // Deterministic ordering: filename, then id.
    const plain = entries.find((entry) => entry.filename === 'plain.pdf');
    const sized = entries.find((entry) => entry.filename === 'sized.pdf');
    assert.ok(plain);
    assert.ok(sized);
    assert.equal('width' in plain, false);
    assert.equal('height' in plain, false);
    assert.equal(sized.width, 320);
    assert.equal(sized.height, 240);
    await app.close();
  });

  it('filters by the q query parameter', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    await library.upload({
      bytes: JPEG_BYTES,
      filename: 'logo.jpg',
      mimeType: 'image/jpeg',
      alt: 'Company logo',
    });
    const app = await makeApp(library);

    const matched = (
      (await (await app.request('/admin/media?format=json&q=logo')).json()) as {
        assets: { filename: string }[];
      }
    ).assets;
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.filename, 'logo.jpg');

    const altMatched = (
      (await (await app.request('/admin/media?format=json&q=company')).json()) as {
        assets: { filename: string }[];
      }
    ).assets;
    assert.equal(altMatched.length, 1);
    assert.equal(altMatched[0]?.filename, 'logo.jpg');
    await app.close();
  });

  it('pages the result with limit/offset and reports the full match count', async () => {
    const { library } = makeLibrary();
    for (let i = 0; i < 5; i += 1) {
      await library.upload({
        bytes: PNG_BYTES,
        filename: `asset-${i}.png`,
        mimeType: 'image/png',
      });
    }
    const app = await makeApp(library);

    const first = (await (await app.request('/admin/media?format=json&limit=2')).json()) as {
      assets: { filename: string }[];
      total: number;
    };
    assert.equal(first.total, 5, 'total reports every match, not the page length');
    assert.deepEqual(
      first.assets.map((asset) => asset.filename),
      ['asset-0.png', 'asset-1.png'],
    );

    const second = (await (
      await app.request('/admin/media?format=json&limit=2&offset=2')
    ).json()) as { assets: { filename: string }[]; total: number };
    assert.equal(second.total, 5);
    assert.deepEqual(
      second.assets.map((asset) => asset.filename),
      ['asset-2.png', 'asset-3.png'],
    );

    const tail = (await (
      await app.request('/admin/media?format=json&limit=2&offset=4')
    ).json()) as { assets: { filename: string }[]; total: number };
    assert.deepEqual(
      tail.assets.map((asset) => asset.filename),
      ['asset-4.png'],
    );
    await app.close();
  });

  it('falls back to the default page for a malformed limit or offset', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library);

    const page = (await (
      await app.request('/admin/media?format=json&limit=abc&offset=-5')
    ).json()) as { assets: { filename: string }[]; total: number };
    assert.equal(page.total, 1);
    assert.equal(page.assets.length, 1);
    await app.close();
  });

  it('filters by the mime query parameter', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    await library.upload({ bytes: JPEG_BYTES, filename: 'logo.jpg', mimeType: 'image/jpeg' });
    const app = await makeApp(library);

    const images = (await (await app.request('/admin/media?format=json&mime=image/*')).json()) as {
      assets: { filename: string }[];
      total: number;
    };
    assert.equal(images.total, 2);

    const jpeg = (await (await app.request('/admin/media?format=json&mime=image/jpeg')).json()) as {
      assets: { filename: string }[];
      total: number;
    };
    assert.equal(jpeg.total, 1);
    assert.equal(jpeg.assets[0]?.filename, 'logo.jpg');
    await app.close();
  });

  it('returns an empty page when there are no assets', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);

    const response = await app.request('/admin/media?format=json');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await response.json(), { assets: [], total: 0 });
    await app.close();
  });

  it('gives ?download precedence over ?format=json', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
    });
    const app = await makeApp(library);

    const response = await app.request('/admin/media?download=asset-1&format=json');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
    await app.close();
  });

  it('maps a library failure to a value-free 500', async () => {
    const failing: MediaLibrary = {
      upload: async () => {
        throw new Error('unused');
      },
      list: async () => {
        throw new MediaLibraryError('io_failed', 'secret library failure');
      },
      query: async () => {
        throw new MediaLibraryError('io_failed', 'secret library failure');
      },
      get: async () => undefined,
      stream: async () => {
        throw new MediaLibraryError('io_failed', 'disk operation failed');
      },
      content: async () => {
        throw new MediaLibraryError('io_failed', 'disk operation failed');
      },
      update: async () => undefined,
      remove: async () => {},
    };

    const response = await handleMediaGet(getContext('http://localhost/admin/media?format=json'), {
      library: failing,
    });
    assert.ok(response, 'library failure still produces a Response');
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret library failure/);
  });
});

describe('media admin page (upload)', () => {
  it('uploads through the real multipart admin route', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);
    const form = new FormData();
    form.set('action', 'upload');
    form.set('alt', 'Route alt');
    const buffer = new ArrayBuffer(PNG_BYTES.byteLength);
    new Uint8Array(buffer).set(PNG_BYTES);
    form.set('file', new File([buffer], 'route.png', { type: 'image/png' }));

    const response = await app.request('/admin/media', {
      method: 'POST',
      headers: { origin: app.origin },
      body: form,
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=uploaded/);

    const assets = await library.list();
    assert.equal(assets.length, 1);
    assert.equal(assets[0]?.filename, 'route.png');
    assert.equal(assets[0]?.alt, 'Route alt');
  });

  it("takes an upload past 1 MiB only with the page's raised form cap", async () => {
    const MiB = 1024 * 1024;
    const { library } = makeLibrary({ maxBytes: 3 * MiB });
    const upload = (app: TestApplication) => {
      const bytes = new Uint8Array(2 * MiB);
      bytes.set(PNG_BYTES);
      const form = new FormData();
      form.set('action', 'upload');
      form.set('file', new File([bytes], 'large.png', { type: 'image/png' }));
      return app.request('/admin/media', {
        method: 'POST',
        headers: { origin: app.origin },
        body: form,
      });
    };

    const capped = await makeApp(library);
    assert.equal((await upload(capped)).status, 413);
    await capped.close();
    assert.equal((await library.list()).length, 0);

    const raised = await makeApp(library, { maxBodyBytes: 4 * MiB });
    assert.equal((await upload(raised)).status, 303);
    await raised.close();
    assert.equal((await library.list()).length, 1);
  });

  it('uploads the first file part and ignores client size/width/height', async () => {
    const { library, disk } = makeLibrary();

    const request = multipartRequest(
      { name: 'photo.png', type: 'image/png', bytes: PNG_BYTES },
      { action: 'upload', alt: 'Alt', caption: 'Caption', size: '9999' },
    );
    const response = await handleMediaPost(
      postContext(request, { action: 'upload', alt: 'Alt', caption: 'Caption', size: '9999' }),
      { library },
    );
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=uploaded/);

    const assets = await library.list();
    assert.equal(assets.length, 1);
    const uploaded = assets[0];
    assert.ok(uploaded);
    assert.equal(uploaded.filename, 'photo.png');
    assert.equal(uploaded.mimeType, 'image/png');
    assert.equal(uploaded.size, PNG_BYTES.byteLength, 'client-supplied size is ignored');
    assert.equal(uploaded.width, 1, 'width comes from the image bytes');
    assert.equal(uploaded.height, 1, 'height comes from the image bytes');
    assert.equal(uploaded.alt, 'Alt');
    assert.equal(uploaded.caption, 'Caption');
    assert.deepEqual(
      await readBytes(disk, uploaded.path, { maxBytes: PNG_BYTES.byteLength }),
      PNG_BYTES,
    );
  });

  it('rejects an upload with no file part', async () => {
    const { library } = makeLibrary();

    // A urlencoded body has no file part.
    const request = new Request('http://localhost/admin/media', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'upload' }).toString(),
    });
    const response = await handleMediaPost(postContext(request, { action: 'upload' }), { library });
    assert.equal(response.status, 400);
    assert.equal((await library.list()).length, 0);
  });

  it('rejects an unsupported type value-free (no input echoed)', async () => {
    const { library } = makeLibrary();

    const request = multipartRequest(
      { name: 'script.svg', type: 'image/svg+xml', bytes: PNG_BYTES },
      { action: 'upload' },
    );
    const response = await handleMediaPost(postContext(request, { action: 'upload' }), {
      library,
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, /script\.svg/);
    assert.doesNotMatch(text, /svg\+xml/);
    assert.equal((await library.list()).length, 0);
  });

  it('rejects an over-size payload value-free', async () => {
    const { library } = makeLibrary({ maxBytes: 4 });

    const request = multipartRequest(
      { name: 'big.png', type: 'image/png', bytes: PNG_BYTES },
      { action: 'upload' },
    );
    const response = await handleMediaPost(postContext(request, { action: 'upload' }), {
      library,
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, /big\.png/);
    assert.equal((await library.list()).length, 0);
  });
});

describe('media admin page (update)', () => {
  it('updates alt/caption and redirects with the updated notice', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'Before',
      caption: 'Old caption',
    });
    const app = await makeApp(library);

    const response = await postForm(app, '/admin/media', {
      action: 'update',
      id: asset.id,
      alt: 'After',
      caption: 'New caption',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=updated/);

    const updated = await library.get(asset.id);
    assert.equal(updated?.alt, 'After');
    assert.equal(updated?.caption, 'New caption');
  });

  it('404s when updating a missing id, without echoing the id', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);

    const response = await postForm(app, '/admin/media', {
      action: 'update',
      id: 'does-not-exist',
      alt: 'x',
    });
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.doesNotMatch(text, /does-not-exist/);
  });
});

describe('media admin page (delete)', () => {
  it('removes the asset and redirects with the deleted notice', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
    });
    const app = await makeApp(library);

    const response = await postForm(app, '/admin/media', {
      action: 'delete',
      id: asset.id,
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=deleted/);
    assert.equal((await library.list()).length, 0);
  });

  it('404s when deleting a missing id, without echoing the id', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);

    const response = await postForm(app, '/admin/media', {
      action: 'delete',
      id: 'does-not-exist',
    });
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.doesNotMatch(text, /does-not-exist/);
  });
});

describe('media admin page (direct URLs)', () => {
  /** A library over a memory disk that can also presign URLs. */
  async function signingLibrary(): Promise<MediaLibrary> {
    const library = createMediaLibrary({
      disk: signingMemoryDisk(),
      diskName: 's3',
      metadata: createMemoryMediaIndex(),
      nextId: () => 'asset-1',
    });
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    return library;
  }

  it('streams through the app by default even when the disk can sign', async () => {
    const app = await makeApp(await signingLibrary());
    const response = await app.request('/admin/media?download=asset-1');
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
    await app.close();
  });

  it('redirects a download to a short-lived signed attachment URL when enabled', async () => {
    const app = await makeApp(await signingLibrary(), { directUrls: true });
    const response = await app.request('/admin/media?download=asset-1');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.origin, 'https://s3.example.test');
    assert.equal(location.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(
      location.searchParams.get('response-content-disposition'),
      'attachment; filename="hero.png"',
    );
    assert.equal(location.searchParams.get('response-content-type'), 'image/png');
    await app.close();
  });

  it('redirects a preview inline with a configured lifetime, and still refuses non-previewables', async () => {
    const library = await signingLibrary();
    const app = await makeApp(library, { directUrls: { expiresIn: 60 } });
    const response = await app.request('/admin/media?preview=asset-1');
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.searchParams.get('X-Amz-Expires'), '60');
    assert.match(location.searchParams.get('response-content-disposition') ?? '', /^inline; /);
    await app.close();

    const capped = await makeApp(library, { directUrls: true, previewLimitBytes: 1 });
    assert.equal((await capped.request('/admin/media?preview=asset-1')).status, 404);
    await capped.close();
  });

  it('falls back to streaming when the disk cannot sign', async () => {
    const { library } = makeLibrary();
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library, { directUrls: true });
    const download = await app.request('/admin/media?download=asset-1');
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), PNG_BYTES);
    const preview = await app.request('/admin/media?preview=asset-1');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    await app.close();
  });

  it('falls back to streaming when an S3 disk carries url but cannot sign', async () => {
    const library = createMediaLibrary({
      disk: sendDoubleS3Disk(),
      diskName: 's3',
      metadata: createMemoryMediaIndex(),
      nextId: () => 'asset-1',
    });
    await library.upload({ bytes: PNG_BYTES, filename: 'hero.png', mimeType: 'image/png' });
    const app = await makeApp(library, { directUrls: true });
    const download = await app.request('/admin/media?download=asset-1');
    assert.ok(download.status === 200 || download.status === 206, String(download.status));
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), PNG_BYTES);
    const ranged = await app.request('/admin/media?download=asset-1', {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(ranged.status, 206);
    assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), PNG_BYTES.subarray(0, 4));
    const preview = await app.request('/admin/media?preview=asset-1');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), PNG_BYTES);
    await app.close();
  });

  it('rejects a malformed directUrls option at construction', () => {
    const { library } = makeLibrary();
    for (const directUrls of [
      'yes',
      null,
      [],
      { expiresIn: 0 },
      { expiresIn: 1.5 },
      { expiresIn: 8 * 24 * 60 * 60 },
    ]) {
      const options = { library, directUrls: directUrls as MediaAdminPageOptions['directUrls'] };
      assert.throws(() => mediaAdmin(options), TypeError);
      assert.throws(() => defineMediaAdminPage(options), TypeError);
    }
  });
});
