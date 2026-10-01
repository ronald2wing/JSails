/**
 * The `Content-Type` of an asset, by the extension of its path.
 *
 * The responder answers a file with the type its name states. The table is
 * the framework's own rather than the router's, so asset serving does not
 * build on Hono, and text types carry `charset=utf-8`. A name without an
 * extension, or with one the table does not know, is
 * `application/octet-stream`, which a browser downloads instead of guessing
 * (the security headers send `nosniff`).
 */

/** The type of each known extension, lower case. */
const TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    '3g2': 'video/3gpp2',
    '3gp': 'video/3gpp',
    aac: 'audio/aac',
    av1: 'video/av1',
    avi: 'video/x-msvideo',
    avif: 'image/avif',
    bin: 'application/octet-stream',
    bmp: 'image/bmp',
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    eot: 'application/vnd.ms-fontobject',
    epub: 'application/epub+zip',
    gif: 'image/gif',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    gz: 'application/gzip',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    ico: 'image/x-icon',
    ics: 'text/calendar; charset=utf-8',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json',
    jsonld: 'application/ld+json',
    map: 'application/json',
    mid: 'audio/x-midi',
    midi: 'audio/x-midi',
    mjs: 'text/javascript; charset=utf-8',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mpeg: 'video/mpeg',
    oga: 'audio/ogg',
    ogv: 'video/ogg',
    ogx: 'application/ogg',
    opus: 'audio/opus',
    otf: 'font/otf',
    pdf: 'application/pdf',
    png: 'image/png',
    rtf: 'application/rtf',
    svg: 'image/svg+xml; charset=utf-8',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    ts: 'video/mp2t',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
    wasm: 'application/wasm',
    weba: 'audio/webm',
    webm: 'video/webm',
    webmanifest: 'application/manifest+json',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    xhtml: 'application/xhtml+xml; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    zip: 'application/zip',
  }),
);

/** The type of an extensionless or unknown name. */
const UNKNOWN = 'application/octet-stream';

/** The `Content-Type` for the asset at `path` (an index path such as `/app.css`). */
export function assetContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return UNKNOWN;
  return TYPES.get(name.slice(dot + 1).toLowerCase()) ?? UNKNOWN;
}
