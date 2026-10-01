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
 *   MIME type, or error detail echoed in the response).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDisk } from '@jsails/filesystem';
import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import type { AdminPagePostContext, AdminPageRenderContext } from '@jsails/admin';
import type { Session } from 'jsails';
import { createTestApp, type TestApplication } from 'jsails/testing';

import {
  MediaError,
  createMediaLibrary,
  createMemoryMediaIndex,
  type MediaLibrary,
} from '../src/index.js';
import { mediaAdmin } from '../src/admin/index.js';
import { handleMediaGet, handleMediaPost } from '../src/admin/page.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};
const CSRF = SESSION.csrfToken;

const PNG_BYTES = new TextEncoder().encode('fake png bytes');

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
  options?: { previewLimitBytes?: number },
): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            adminPlugins: [mediaAdmin({ library, ...options })],
          }),
        ),
      ],
    },
  });
}

/** POST a urlencoded body with a same-origin header. */
function postForm(
  app: TestApplication,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
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
      bytes: PNG_BYTES,
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
  it('renders an image thumbnail data URL for a small image', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
      alt: 'A hero image',
    });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    // The thumbnail is a base64 data URL carrying the recorded image/png MIME.
    assert.match(html, /data:image\/png;base64,/);
    assert.match(html, /<img[^>]+alt="A hero image"/);
    assert.match(html, /hero\.png/);
  });

  it('does not inline an over-size asset', async () => {
    const { library } = makeLibrary();
    const big = new Uint8Array(1024).fill(7);
    await library.upload({ bytes: big, filename: 'big.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: 16 });

    const html = await (await app.request('/admin/media')).text();
    // No data URL is serialized for the over-size asset.
    assert.doesNotMatch(html, /data:image\/png;base64,/);
    assert.match(html, /Too large to preview\./);
    assert.match(html, /big\.png/);
  });

  it('renders a placeholder (not an img) for a non-image type', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /report\.pdf/);
    // No image (thumbnail) is rendered for a non-image MIME.
    assert.doesNotMatch(html, /data:application\/pdf;base64,/);
    assert.doesNotMatch(html, /<img[^>]+src="data:/);
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
    // SVG is excluded from the preview allowlist regardless of library policy.
    assert.doesNotMatch(html, /data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(html, /<img[^>]+src="data:/);
  });

  it('honors the preview limit boundary at exactly the limit', async () => {
    const { library } = makeLibrary();
    // Exactly 16 bytes: at the boundary it is still inlined (size <= limit).
    const bytes = new Uint8Array(16).fill(1);
    await library.upload({ bytes, filename: 'edge.png', mimeType: 'image/png' });
    const app = await makeApp(library, { previewLimitBytes: 16 });

    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /data:image\/png;base64,/);
  });

  it('renders a download link to the streaming route, not an inline data URL', async () => {
    const { library } = makeLibrary();
    const asset = await library.upload({
      bytes: PNG_BYTES,
      filename: 'hero.png',
      mimeType: 'image/png',
    });
    const app = await makeApp(library);

    const html = await (await app.request('/admin/media')).text();
    // The Download action is a real route link to ?download=<id>, never a data:
    // URL with inline bytes.
    assert.match(html, /<a[^>]+href="\/admin\/media\?download=asset-1"[^>]*>Download<\/a>/);
    assert.doesNotMatch(html, /<a[^>]+href="data:/);
    // Only the thumbnail preview carries a data: URL.
    assert.match(html, /data:image\/png;base64,/);
    assert.equal(asset.id, 'asset-1');
  });

  it('renders a download link for an over-size asset (no disabled note)', async () => {
    const { library } = makeLibrary();
    const big = new Uint8Array(1024).fill(7);
    await library.upload({ bytes: big, filename: 'big.png', mimeType: 'image/png' });
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, PNG_BYTES);
    await app.close();
  });

  it('streams a PDF with its recorded MIME type', async () => {
    const { library } = makeLibrary();
    const pdf = new TextEncoder().encode('%PDF-1.4 fake');
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
      get: async () => undefined,
      content: async () => {
        throw new MediaError('disk_failed', 'disk operation failed');
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
      get: async () => undefined,
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
      bytes: new TextEncoder().encode('%PDF'),
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
    const entries = (await response.json()) as Record<string, unknown>[];

    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.deepEqual(Object.keys(entry).sort(), [
      'alt',
      'caption',
      'createdAt',
      'filename',
      'id',
      'mimeType',
      'size',
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
    assert.equal('width' in entry, false);
    await app.close();
  });

  it('includes width/height only when recorded', async () => {
    const { library } = makeLibrary();
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'sized.png',
      mimeType: 'image/png',
      width: 320,
      height: 240,
    });
    await library.upload({
      bytes: PNG_BYTES,
      filename: 'plain.png',
      mimeType: 'image/png',
    });
    const app = await makeApp(library);

    const entries = (await (await app.request('/admin/media?format=json')).json()) as Record<
      string,
      unknown
    >[];
    // Deterministic ordering: filename, then id.
    const plain = entries.find((entry) => entry.filename === 'plain.png');
    const sized = entries.find((entry) => entry.filename === 'sized.png');
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
      bytes: PNG_BYTES,
      filename: 'logo.jpg',
      mimeType: 'image/jpeg',
      alt: 'Company logo',
    });
    const app = await makeApp(library);

    const matched = (await (await app.request('/admin/media?format=json&q=logo')).json()) as {
      filename: string;
    }[];
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.filename, 'logo.jpg');

    const altMatched = (await (await app.request('/admin/media?format=json&q=company')).json()) as {
      filename: string;
    }[];
    assert.equal(altMatched.length, 1);
    assert.equal(altMatched[0]?.filename, 'logo.jpg');
    await app.close();
  });

  it('returns an empty array when there are no assets', async () => {
    const { library } = makeLibrary();
    const app = await makeApp(library);

    const response = await app.request('/admin/media?format=json');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await response.json(), []);
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
        throw new MediaError('disk_failed', 'secret library failure');
      },
      get: async () => undefined,
      content: async () => {
        throw new MediaError('disk_failed', 'disk operation failed');
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
    form.set('_csrf', CSRF);
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

  it('uploads the first file part and ignores client size/width/height', async () => {
    const { library, disk } = makeLibrary();

    const request = multipartRequest(
      { name: 'photo.png', type: 'image/png', bytes: PNG_BYTES },
      { _csrf: CSRF, action: 'upload', alt: 'Alt', caption: 'Caption', size: '9999' },
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
    assert.equal(uploaded.width, undefined, 'client width is never derived');
    assert.equal(uploaded.height, undefined, 'client height is never derived');
    assert.equal(uploaded.alt, 'Alt');
    assert.equal(uploaded.caption, 'Caption');
    assert.deepEqual(await disk.get(uploaded.path), PNG_BYTES);
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
      { _csrf: CSRF, action: 'upload' },
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
      { _csrf: CSRF, action: 'upload' },
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
      _csrf: CSRF,
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
      _csrf: CSRF,
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
      _csrf: CSRF,
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
      _csrf: CSRF,
      action: 'delete',
      id: 'does-not-exist',
    });
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.doesNotMatch(text, /does-not-exist/);
  });
});
