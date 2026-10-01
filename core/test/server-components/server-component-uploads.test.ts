/**
 * Server-side upload tests for stateful server components.
 *
 * Covers the storage-and-reference half of the file-upload story end to end,
 * without a browser, HTTP listener, database, or Valkey:
 *
 * - the disk store (atomic write, streaming byte cap, subject scoping,
 *   content-type allowlist, delete/open of missing files);
 * - the signed reference signer (round-trip, tamper, expiry, claim validation,
 *   domain separation from the snapshot signer);
 * - `uploadRefSchema` and the incremental multipart reader;
 * - the runtime `handleUpload` pipeline (happy path, `resolveUpload` read-back,
 *   and every security seam: origin, snapshot, CSRF, authorization, content
 *   type, oversize, missing file, disabled uploads, per-component opt-in and
 *   limits, authorization before the file is read, the concurrency cap);
 * - the HTTP mount (`/_jsails/components/upload`) including the body-limit
 *   exemption that lets an upload larger than the JSON/API cap through.
 *
 * Every fixture uses a real temp directory and injected signers with a frozen
 * clock, so nothing touches a shared path or the real filesystem.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext, Session } from '../../src/contracts/http.js';
import {
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../src/server-components/extension.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
} from '../../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { openMultipartUpload } from '../../src/server-components/runtime/multipart-upload.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import {
  DiskUploadStore,
  createUploadReferenceSigner,
  UploadError,
  uploadRefSchema,
  type UploadReferenceClaims,
  type UploadReferenceSigner,
  type UploadStore,
} from '../../src/server-components/uploads.js';
import { Async } from '../../src/support/async.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

/**
 * `token` with the character at `at` changed to a different one. The first
 * character of a base64url segment carries six significant bits, so the
 * result always decodes differently; overwriting the trailing characters does
 * not, since the decoder ignores the last character's unused low bits and the
 * old value may already be the replacement.
 */
function tamper(token: string, at: number): string {
  const tampered = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
  assert.notEqual(tampered, token);
  return tampered;
}

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';
const SNAPSHOT_ID = 'upload-snap-1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const avatar = defineServerComponent<{ ref?: { __upload: string } }>({
  name: 'Avatar',
  stateSchema: z.object({ ref: uploadRefSchema().optional() }).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  uploads: { anonymous: { maxBytes: 64 * 1024 * 1024, maxFiles: 1000, maxConcurrent: 16 } },
  render() {
    return null;
  },
});

/** Accepts uploads, but only small PNGs. */
const thumbnail = defineServerComponent({
  name: 'Thumbnail',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  uploads: {
    maxBytes: 4,
    contentTypes: ['image/png'],
    anonymous: { maxBytes: 1024, maxFiles: 100 },
  },
  render() {
    return null;
  },
});

/** A public component that never opted into uploads. */
const noUploads = defineServerComponent({
  name: 'NoUploads',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
});

const denied = defineServerComponent({
  name: 'Denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  uploads: {},
  render() {
    return null;
  },
});

/** Accepts uploads from signed-in sessions only. */
const membersOnly = defineServerComponent({
  name: 'Members',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  uploads: {},
  render() {
    return null;
  },
});

/** Accepts anonymous uploads within a tiny quota of its own. */
const guestbook = defineServerComponent({
  name: 'Guestbook',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  uploads: { anonymous: { maxBytes: 8, maxFiles: 2 } },
  render() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A signed-in session and a snapshot minted for its subject. */
function sessionSnapshot(
  component: string,
  sessionId = 'session-1',
): { session: Session; snapshot: string } {
  const signer = new HmacComponentSigner({ key: KEY, now: () => 0 });
  const session: Session = {
    id: sessionId,
    csrfToken: `csrf-${sessionId}`,
    data: {},
    expiresAt: 1,
  };
  return { session, snapshot: makeSnapshot(component, signer.subjectFor(sessionId)) };
}

/** An upload request carrying the CSRF token of the session `sessionSnapshot` built. */
function sessionUploadRequest(snapshot: string, bytes: Buffer, sessionId = 'session-1'): Request {
  return makeUploadRequest(snapshot, fileForm(snapshot, bytes), {
    [COMPONENT_CSRF_HEADER]: `csrf-${sessionId}`,
  });
}

/** A promise a test resolves by hand. */
function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** An upload whose body delivers all but its last 8 bytes, then waits for `gate`. */
function gatedUploadRequest(
  contentType: string,
  bytes: Uint8Array,
  gate: Promise<void>,
  headers: Record<string, string> = {},
): Request {
  const head = bytes.subarray(0, bytes.length - 8);
  const tail = bytes.subarray(bytes.length - 8);
  let step = 0;
  return new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      origin: ORIGIN,
      [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID,
      ...headers,
    },
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        step += 1;
        if (step === 1) {
          controller.enqueue(head);
        } else if (step === 2) {
          await gate;
          controller.enqueue(tail);
        } else {
          controller.close();
        }
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jsails-uploads-'));
}

/** A runtime with a direct disk store rooted at `dir` and a frozen clock. */
function makeRuntime(
  dir: string,
  overrides: {
    components?: Readonly<Record<string, ServerComponentDefinition<any>>>;
    maxBytes?: number;
    contentTypes?: readonly string[];
    maxConcurrent?: number;
    maxConcurrentPerSubject?: number;
    snapshotTimeoutMs?: number;
    idleTimeoutMs?: number;
    timeoutMs?: number;
    referenceSigner?: UploadReferenceSigner;
  } = {},
): { runtime: ServerComponentsRuntime; store: UploadStore } {
  const store = new DiskUploadStore({
    rootDir: dir,
    maxBytes: overrides.maxBytes,
    contentTypes: overrides.contentTypes,
  });
  const runtime = createServerComponentsRuntime({
    components: overrides.components ?? { Avatar: avatar },
    signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
    uploads: {
      store,
      signer: overrides.referenceSigner ?? createUploadReferenceSigner({ key: KEY, now: () => 0 }),
      maxBytes: overrides.maxBytes,
      contentTypes: overrides.contentTypes,
      maxConcurrent: overrides.maxConcurrent,
      maxConcurrentPerSubject: overrides.maxConcurrentPerSubject,
      snapshotTimeoutMs: overrides.snapshotTimeoutMs,
      idleTimeoutMs: overrides.idleTimeoutMs,
      timeoutMs: overrides.timeoutMs,
    },
  });
  return { runtime, store };
}

function makeSnapshot(component = 'Avatar', subject: string | null = null): string {
  return new HmacComponentSigner({ key: KEY, now: () => 0 }).sign({
    v: 1,
    component,
    id: SNAPSHOT_ID,
    state: {},
    page: { path: '/avatar', params: {} },
    origin: ORIGIN,
    subject,
  });
}

function makeUploadRequest(
  _snapshot: string,
  body: FormData,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID, ...headers },
    body,
  });
}

function uploadContext(request: Request, session: Session | null = null): RequestContext {
  return {
    request,
    url: new URL(request.url),
    params: {},
    session,
  };
}

/** Collect a Node `Readable` into a buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fileForm(
  snapshot: string,
  bytes: Buffer,
  name = 'avatar.png',
  type = 'image/png',
): FormData {
  const form = new FormData();
  form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, snapshot);
  // `new Uint8Array(bytes)` copies into an ArrayBuffer-backed view, satisfying
  // the `BlobPart` constraint (a Buffer's backing store is `ArrayBufferLike`).
  form.set(COMPONENT_UPLOAD_FILE_FIELD, new File([new Uint8Array(bytes)], name, { type }));
  return form;
}

/** Encode a form to its raw multipart bytes and the matching content type. */
async function encodeForm(form: FormData): Promise<{ contentType: string; bytes: Uint8Array }> {
  const response = new Response(form);
  const contentType = response.headers.get('content-type') ?? '';
  return { contentType, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** Split a byte array into fixed-size chunks for a streaming request body. */
function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

/**
 * Build a request whose body is a `ReadableStream` (so it carries no
 * `Content-Length`), reporting each chunk as it is pulled from the source.
 */
function streamingUploadRequest(
  contentType: string,
  chunks: readonly Uint8Array[],
  onPull?: (bytes: number) => void,
  headers: Record<string, string> = {},
): Request {
  let index = 0;
  // `highWaterMark: 0` keeps the source from buffering a chunk ahead, so
  // `onPull` measures exactly how far the consumer reads.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        onPull?.(chunk.byteLength);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  // Node requires `duplex: 'half'` for a stream body, but its global
  // `RequestInit` type omits the field.
  return new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
}

// ---------------------------------------------------------------------------
// Disk store
// ---------------------------------------------------------------------------

describe('disk upload store', () => {
  it('writes, reads back, and deletes an upload atomically', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      const bytes = Buffer.from('hello upload');
      const { size } = await store.put({
        id: 'upload-1',
        subject: null,
        contentType: 'image/png',
        stream: Readable.from([bytes]),
      });
      assert.equal(size, bytes.length);

      const opened = await store.open('upload-1', null);
      assert.ok(opened);
      assert.deepEqual(await collect(opened), bytes);

      await store.delete('upload-1', null);
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a content type outside the allowlist before writing', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      await assert.rejects(
        () =>
          store.put({
            id: 'upload-1',
            subject: null,
            contentType: 'text/html',
            stream: Readable.from([Buffer.from('x')]),
          }),
        (error: unknown) =>
          error instanceof UploadError && error.code === 'unsupported_content_type',
      );
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the byte cap while streaming and leaves nothing behind', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxBytes: 4 });
      await assert.rejects(
        () =>
          store.put({
            id: 'upload-1',
            subject: null,
            contentType: 'image/png',
            stream: Readable.from([Buffer.from('way-too-long')]),
          }),
        (error: unknown) => error instanceof UploadError && error.code === 'too_large',
      );
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scopes uploads by subject tag so one subject cannot read another', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      await store.put({
        id: 'upload-1',
        subject: 'subject-a',
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('a')]),
      });
      const opened = await store.open('upload-1', 'subject-a');
      assert.ok(opened);
      opened.destroy();
      assert.equal(await store.open('upload-1', 'subject-b'), null);
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the file before returning, so a removal before reading cannot crash', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      await store.put({
        id: 'upload-1',
        subject: 'subject-a',
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('kept')]),
      });
      const opened = await store.open('upload-1', 'subject-a');
      assert.ok(opened);
      // A path-based stream would open on a later tick and emit ENOENT with no
      // listener attached. The open descriptor keeps the bytes readable.
      await store.delete('upload-1', 'subject-a');
      rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => setImmediate(resolve));
      const chunks: Buffer[] = [];
      for await (const chunk of opened) chunks.push(Buffer.from(chunk as Uint8Array));
      assert.equal(Buffer.concat(chunks).toString(), 'kept');
      assert.equal(await store.open('upload-1', 'subject-a'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe id or subject segment', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      await assert.rejects(
        () =>
          store.put({
            id: '../escape',
            subject: null,
            contentType: 'image/png',
            stream: Readable.from([Buffer.from('x')]),
          }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a write past the per-subject byte quota and keeps nothing', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxBytesPerSubject: 10 });
      const put = (id: string, size: number): Promise<{ size: number }> =>
        store.put({
          id,
          subject: null,
          contentType: 'image/png',
          stream: Readable.from([Buffer.alloc(size, 0x41)]),
        });
      await put('upload-1', 6);
      await assert.rejects(
        () => put('upload-2', 6),
        (error: unknown) => error instanceof UploadError && error.code === 'quota_exceeded',
      );
      assert.equal(await store.open('upload-2', null), null);
      // Another subject has its own quota.
      await store.put({
        id: 'upload-3',
        subject: 'subject-a',
        contentType: 'image/png',
        stream: Readable.from([Buffer.alloc(6, 0x41)]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a write past the per-subject file-count quota', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxFilesPerSubject: 1 });
      const put = (id: string): Promise<{ size: number }> =>
        store.put({
          id,
          subject: null,
          contentType: 'image/png',
          stream: Readable.from([Buffer.from('x')]),
        });
      await put('upload-1');
      await assert.rejects(
        () => put('upload-2'),
        (error: unknown) => error instanceof UploadError && error.code === 'quota_exceeded',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps uploads and abandoned temp files older than the retention window', async () => {
    const dir = tempDir();
    try {
      let now = Date.now();
      const store = new DiskUploadStore({ rootDir: dir, now: () => now });
      await store.put({
        id: 'old-upload',
        subject: 'subject-a',
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('old')]),
      });
      const subjectDir = readdirSync(dir)[0]!;
      writeFileSync(join(dir, subjectDir, '.abandoned.0011223344556677.tmp'), 'partial');
      now += 2 * 60 * 60 * 1000;
      const { removed } = await store.sweep();
      assert.equal(removed, 2);
      assert.equal(await store.open('old-upload', 'subject-a'), null);
      assert.deepEqual(readdirSync(dir), [], 'an emptied subject directory is removed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frees quota held by expired uploads when the subject writes again', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxFilesPerSubject: 1 });
      await store.put({
        id: 'stale',
        subject: null,
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('x')]),
      });
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(join(dir, 'anonymous', 'stale'), past, past);
      await store.put({
        id: 'fresh',
        subject: null,
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('y')]),
      });
      assert.equal(await store.open('stale', null), null);
      const fresh = await store.open('fresh', null);
      assert.ok(fresh);
      assert.deepEqual(await collect(fresh), Buffer.from('y'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds the file-count quota under concurrent puts for one subject', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxFilesPerSubject: 2 });
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          store.put({
            id: `upload-${index}`,
            subject: 'subject-a',
            contentType: 'image/png',
            stream: Readable.from([Buffer.from('x')]),
          }),
        ),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
      for (const result of results) {
        if (result.status === 'rejected') {
          assert.ok(result.reason instanceof UploadError);
          assert.equal(result.reason.code, 'quota_exceeded');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds the byte quota when a concurrent put commits during a scan', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir, maxBytesPerSubject: 10 });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          store.put({
            id: `upload-${index}`,
            subject: 'subject-a',
            contentType: 'image/png',
            stream: Readable.from([Buffer.alloc(4, 0x41)]),
          }),
        ),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a short upload retention when the plugin is built', () => {
    assert.throws(
      () => serverComponentsPlugin({ uploads: { retentionMs: 60_000 } }),
      (error: unknown) => error instanceof TypeError && /retentionMs/.test(error.message),
    );
  });

  it('refuses a retention shorter than the upload reference lifetime', () => {
    assert.throws(
      () => new DiskUploadStore({ rootDir: join(tmpdir(), 'jsails-unused'), retentionMs: 1000 }),
      (error: unknown) => error instanceof TypeError && /retentionMs/.test(error.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Reference signer
// ---------------------------------------------------------------------------

describe('upload key rotation', () => {
  const PREVIOUS_KEY = 'fedcba9876543210fedcba9876543210';

  it('verifies a reference minted under a retired key but signs with the current one', () => {
    const claims = {
      uploadId: 'upload-1',
      component: 'Avatar',
      subject: null,
      size: 1,
      contentType: 'image/png',
    };
    const legacy = createUploadReferenceSigner({ key: PREVIOUS_KEY, now: () => 0 }).sign(claims);
    const rotated = createUploadReferenceSigner({
      key: KEY,
      previousKeys: [PREVIOUS_KEY],
      now: () => 0,
    });
    assert.equal(rotated.verify(legacy).uploadId, 'upload-1');
    const current = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    assert.equal(current.verify(rotated.sign(claims)).uploadId, 'upload-1');
    assert.throws(() => current.verify(legacy), UploadError);
  });

  it('resolves a pre-rotation upload for its own session from its original directory', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      const oldTag = new HmacComponentSigner({ key: PREVIOUS_KEY, now: () => 0 }).subjectFor(
        'session-1',
      );
      await store.put({
        id: 'upload-1',
        subject: oldTag,
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('before')]),
      });
      const reference = createUploadReferenceSigner({ key: PREVIOUS_KEY, now: () => 0 }).sign({
        uploadId: 'upload-1',
        component: 'Avatar',
        subject: oldTag,
        size: 6,
        contentType: 'image/png',
      });
      const runtime = createServerComponentsRuntime({
        components: { Avatar: avatar },
        signer: new HmacComponentSigner({ key: KEY, previousKeys: [PREVIOUS_KEY], now: () => 0 }),
        uploads: {
          store,
          signer: createUploadReferenceSigner({
            key: KEY,
            previousKeys: [PREVIOUS_KEY],
            now: () => 0,
          }),
        },
      });
      const resolved = runtime.resolveUpload(reference, {
        expectedComponent: 'Avatar',
        expectedSubjectId: 'session-1',
      });
      const stream = await resolved.open();
      assert.ok(stream);
      assert.deepEqual(await collect(stream), Buffer.from('before'));
      assert.throws(
        () =>
          runtime.resolveUpload(reference, {
            expectedComponent: 'Avatar',
            expectedSubjectId: 'session-2',
          }),
        (error: unknown) => error instanceof UploadError && error.code === 'invalid_reference',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('upload reference signer', () => {
  const claims = {
    uploadId: 'upload-1',
    component: 'Avatar',
    subject: null,
    size: 12,
    contentType: 'image/png',
  };

  it('signs a reference and verifies it back', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    const token = signer.sign(claims);
    assert.equal(typeof token, 'string');
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(signer.verify(token), { ...claims, v: 1, expiresAt: 3_600_000 });
  });

  it('rejects a tampered payload', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    const token = signer.sign(claims);
    const tampered = tamper(token, 0);
    assert.throws(() => signer.verify(tampered), UploadError);
  });

  it('rejects an expired reference', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0, ttlMs: 100 });
    const token = signer.sign(claims);
    assert.throws(
      () => createUploadReferenceSigner({ key: KEY, now: () => 101 }).verify(token),
      UploadError,
    );
  });

  it('does not verify a snapshot token (domain separation)', () => {
    const snapshot = makeSnapshot();
    const uploadSigner = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    assert.throws(() => uploadSigner.verify(snapshot), UploadError);
  });

  it('requires a key of at least 32 bytes', () => {
    assert.throws(() => createUploadReferenceSigner({ key: 'short' }), UploadError);
  });
});

// ---------------------------------------------------------------------------
// uploadRefSchema
// ---------------------------------------------------------------------------

describe('uploadRefSchema', () => {
  it('accepts exactly { __upload: string }', () => {
    const schema = uploadRefSchema();
    assert.deepEqual(schema.parse({ __upload: 'token' }), { __upload: 'token' });
  });

  it('rejects missing, non-string, or extra fields', () => {
    const schema = uploadRefSchema();
    assert.throws(() => schema.parse({}), z.ZodError);
    assert.throws(() => schema.parse({ __upload: 123 }), z.ZodError);
    assert.throws(() => schema.parse({ __upload: 'x', extra: true }), z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// Incremental multipart reader
// ---------------------------------------------------------------------------

describe('openMultipartUpload', () => {
  it('reads the snapshot first, then streams the file part', async () => {
    const form = fileForm('token-value', Buffer.from('file bytes'));
    const { contentType, bytes } = await encodeForm(form);
    const reader = openMultipartUpload(streamingUploadRequest(contentType, [bytes]), 64 * 1024);
    assert.equal(await reader.readSnapshot(), 'token-value');
    const file = await reader.openFile();
    assert.ok(file);
    assert.equal(file.contentType, 'image/png');
    assert.equal(file.filename, 'avatar.png');
    assert.deepEqual(await collect(file.stream), Buffer.from('file bytes'));
  });

  it('finds boundaries that straddle chunk edges', async () => {
    const payload = Buffer.from('0123456789'.repeat(50));
    const { contentType, bytes } = await encodeForm(fileForm('token-value', payload));
    for (const size of [1, 3, 7, 64]) {
      const reader = openMultipartUpload(
        streamingUploadRequest(contentType, chunkBytes(bytes, size)),
        64 * 1024,
      );
      assert.equal(await reader.readSnapshot(), 'token-value');
      const file = await reader.openFile();
      assert.deepEqual(await collect(file!.stream), payload, `chunk size ${size}`);
    }
  });

  it('rejects a non-multipart body', () => {
    const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.throws(
      () => openMultipartUpload(request, 1024),
      (error: unknown) => error instanceof UploadError && error.code === 'invalid_input',
    );
  });

  it('rejects a body whose first part is not the snapshot', async () => {
    const form = new FormData();
    form.set(
      COMPONENT_UPLOAD_FILE_FIELD,
      new File([new Uint8Array(Buffer.from('x'))], 'a.png', { type: 'image/png' }),
    );
    form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, 'token-value');
    const { contentType, bytes } = await encodeForm(form);
    const reader = openMultipartUpload(streamingUploadRequest(contentType, [bytes]), 64 * 1024);
    await assert.rejects(
      () => reader.readSnapshot(),
      (error: unknown) => error instanceof UploadError && error.code === 'invalid_input',
    );
  });

  it('stops reading a headerless body at the cap without draining it', async () => {
    const { contentType, bytes } = await encodeForm(
      fileForm('token-value', Buffer.alloc(8 * 1024, 0x41)),
    );
    const chunkSize = 512;
    let pulled = 0;
    const request = streamingUploadRequest(contentType, chunkBytes(bytes, chunkSize), (n) => {
      pulled += n;
    });
    const cap = 1024;
    const reader = openMultipartUpload(request, cap);
    assert.equal(await reader.readSnapshot(), 'token-value');
    const file = await reader.openFile();
    await assert.rejects(
      () => collect(file!.stream),
      (error: unknown) => error instanceof UploadError && error.code === 'too_large',
    );
    assert.ok(pulled <= cap + chunkSize, `pulled ${pulled} bytes for a ${cap}-byte cap`);
  });

  it('fails the file stream on a truncated body', async () => {
    const { contentType, bytes } = await encodeForm(fileForm('token-value', Buffer.from('abc')));
    const truncated = bytes.subarray(0, bytes.length - 10);
    const reader = openMultipartUpload(streamingUploadRequest(contentType, [truncated]), 64 * 1024);
    await reader.readSnapshot();
    const file = await reader.openFile();
    await assert.rejects(
      () => collect(file!.stream),
      (error: unknown) => error instanceof UploadError && error.code === 'invalid_input',
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime handleUpload + resolveUpload
// ---------------------------------------------------------------------------

describe('runtime handleUpload', () => {
  it('stores an upload and returns a signed reference that resolveUpload reads back', async () => {
    const dir = tempDir();
    try {
      const { runtime, store } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('avatar-bytes');
      const context = uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes)));

      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);
      assert.ok(result.body.reference);
      assert.equal(result.body.error, undefined);

      const resolved = runtime.resolveUpload(result.body.reference, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
      });
      assert.equal(resolved.component, 'Avatar');
      assert.equal(resolved.size, bytes.length);
      assert.equal(resolved.contentType, 'image/png');
      assert.deepEqual(await collect((await resolved.open())!), bytes);

      // The store recorded the same bytes under the derived (anonymous) subject.
      assert.deepEqual(await collect((await store.open(resolved.id, null))!), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores a headerless streaming upload within the cap', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('streamed-avatar');
      const { contentType, bytes: encoded } = await encodeForm(fileForm(snapshot, bytes));
      const request = streamingUploadRequest(contentType, chunkBytes(encoded, 32), undefined, {
        origin: ORIGIN,
        [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID,
      });
      assert.equal(request.headers.get('content-length'), null);

      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 201);
      const resolved = runtime.resolveUpload(result.body.reference!, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
      });
      assert.deepEqual(await collect((await resolved.open())!), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through a factory-resolved store keyed by storagePath', async () => {
    const dir = tempDir();
    try {
      const store = new DiskUploadStore({ rootDir: dir });
      const runtime = createServerComponentsRuntime({
        components: { Avatar: avatar },
        signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
        uploads: {
          store: () => store,
          signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }),
        },
      });
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('factory-bytes');
      const context: RequestContext = {
        ...uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes))),
        storagePath: '/ignored/by/the-factory',
      };

      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);
      const resolved = runtime.resolveUpload(result.body.reference!, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
        storagePath: '/ignored',
      });
      assert.deepEqual(await collect((await resolved.open())!), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-origin upload', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        origin: 'https://evil.example',
      });
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'origin_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered snapshot', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signed = makeSnapshot();
      const snapshot = tamper(signed, signed.lastIndexOf('.') + 1);
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'invalid_snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a snapshot whose subject does not match the session', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot('Avatar', null);
      const session: Session = { id: 'someone', csrfToken: 'csrf-token', data: {}, expiresAt: 1 };
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        [COMPONENT_CSRF_HEADER]: 'csrf-token',
      });
      const result = await runtime.handleUpload(request, uploadContext(request, session));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'invalid_snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing CSRF token', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        [COMPONENT_CSRF_HEADER]: '',
      });
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'csrf_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies a component whose authorize does not resolve to true', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { Denied: denied } });
      const snapshot = makeSnapshot('Denied');
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported content type', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(
        snapshot,
        fileForm(snapshot, Buffer.from('x'), 'evil.svg', 'image/svg+xml'),
      );
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 415);
      assert.equal(result.body.error?.code, 'unsupported_content_type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an oversize upload with 413', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { maxBytes: 4 });
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('way-too-long')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 413);
      assert.equal(result.body.error?.code, 'too_large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a request missing the file field', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const form = new FormData();
      form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, snapshot);
      const request = makeUploadRequest(snapshot, form);
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 400);
      assert.equal(result.body.error?.code, 'invalid_request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unavailable when uploads are not configured', async () => {
    const dir = tempDir();
    try {
      const runtime = createServerComponentsRuntime({
        components: { Avatar: avatar },
        signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
      });
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 503);
      assert.equal(result.body.error?.code, 'unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file for a component that did not opt into uploads', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { NoUploads: noUploads } });
      const snapshot = makeSnapshot('NoUploads');
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'forbidden');
      assert.deepEqual(readdirSync(dir), [], 'nothing is written for a refused component');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the component's own byte cap and content types", async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { Thumbnail: thumbnail } });
      const snapshot = makeSnapshot('Thumbnail');
      const big = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('too-long')));
      const tooLarge = await runtime.handleUpload(big, uploadContext(big));
      assert.equal(tooLarge.status, 413);

      const jpeg = makeUploadRequest(
        snapshot,
        fileForm(snapshot, Buffer.from('x'), 'a.jpg', 'image/jpeg'),
      );
      const unsupported = await runtime.handleUpload(jpeg, uploadContext(jpeg));
      assert.equal(unsupported.status, 415);

      const ok = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('tiny')));
      assert.equal((await runtime.handleUpload(ok, uploadContext(ok))).status, 201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unauthorized upload without reading the file part', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signed = makeSnapshot();
      const snapshot = tamper(signed, signed.lastIndexOf('.') + 1);
      const { contentType, bytes } = await encodeForm(
        fileForm(snapshot, Buffer.alloc(256 * 1024, 0x41)),
      );
      const chunkSize = 4096;
      let pulled = 0;
      const request = streamingUploadRequest(
        contentType,
        chunkBytes(bytes, chunkSize),
        (n) => {
          pulled += n;
        },
        { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID },
      );
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'invalid_snapshot');
      assert.ok(
        pulled <= snapshot.length + 2 * chunkSize,
        `pulled ${pulled} bytes before rejecting the snapshot`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers unavailable past the concurrent upload cap', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { maxConcurrent: 1 });
      const snapshot = makeSnapshot();
      const { contentType, bytes } = await encodeForm(fileForm(snapshot, Buffer.from('slow')));
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A body that delivers everything but its last chunk, then stalls.
      const head = bytes.subarray(0, bytes.length - 8);
      const tail = bytes.subarray(bytes.length - 8);
      let step = 0;
      const stalled = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          origin: ORIGIN,
          [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID,
        },
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            step += 1;
            if (step === 1) {
              controller.enqueue(head);
            } else if (step === 2) {
              await gate;
              controller.enqueue(tail);
            } else {
              controller.close();
            }
          },
        }),
        duplex: 'half',
      } as RequestInit);
      const first = runtime.handleUpload(stalled, uploadContext(stalled));

      const second = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const refused = await runtime.handleUpload(second, uploadContext(second));
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error?.code, 'unavailable');

      release?.();
      assert.equal((await first).status, 201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes no upload slot until the snapshot is authorized, and times out a stalled snapshot', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { maxConcurrent: 2, snapshotTimeoutMs: 100 });
      const { contentType } = await encodeForm(fileForm(makeSnapshot(), Buffer.from('x')));
      // Bodies that never deliver a byte: an unauthenticated client trickling
      // nothing must neither hold a slot nor hang the request forever.
      const stalled = Array.from({ length: 4 }, () => {
        const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
          method: 'POST',
          headers: { 'content-type': contentType, origin: ORIGIN },
          body: new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          duplex: 'half',
        } as RequestInit);
        return runtime.handleUpload(request, uploadContext(request));
      });

      const snapshot = makeSnapshot();
      const authorized = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('ok')));
      assert.equal((await runtime.handleUpload(authorized, uploadContext(authorized))).status, 201);

      for (const result of await Promise.all(stalled)) {
        assert.equal(result.status, 400);
        assert.equal(result.body.error?.code, 'invalid_request');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses anonymous uploads unless the component opts in with its own quota', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { Members: membersOnly } });
      const anonymousSnapshot = makeSnapshot('Members');
      const anonymous = makeUploadRequest(
        anonymousSnapshot,
        fileForm(anonymousSnapshot, Buffer.from('x')),
      );
      const refused = await runtime.handleUpload(anonymous, uploadContext(anonymous));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error?.code, 'forbidden');

      const { session, snapshot } = sessionSnapshot('Members');
      const signedIn = sessionUploadRequest(snapshot, Buffer.from('x'));
      assert.equal(
        (await runtime.handleUpload(signedIn, uploadContext(signedIn, session))).status,
        201,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds anonymous uploads to the component's own file and byte quota", async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { Guestbook: guestbook } });
      const snapshot = makeSnapshot('Guestbook');
      const upload = async (bytes: Buffer) => {
        const request = makeUploadRequest(snapshot, fileForm(snapshot, bytes));
        return runtime.handleUpload(request, uploadContext(request));
      };
      // Over the 8-byte anonymous quota on its own: refused and not counted.
      const oversized = await upload(Buffer.alloc(9, 0x41));
      assert.equal(oversized.status, 413);
      assert.equal((await upload(Buffer.from('12345'))).status, 201);
      // 5 + 5 bytes would pass the store's shared anonymous quota but not this component's.
      assert.equal((await upload(Buffer.from('12345'))).status, 413);
      assert.equal((await upload(Buffer.from('123'))).status, 201);
      // Two files staged: the file quota is spent too.
      const full = await upload(Buffer.from(''));
      assert.equal(full.status, 413);
      assert.equal(full.body.error?.code, 'too_large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not charge the anonymous quota for a file deleted because signing failed', async () => {
    const dir = tempDir();
    try {
      const real = createUploadReferenceSigner({ key: KEY, now: () => 0 });
      let failSign = true;
      const { runtime } = makeRuntime(dir, {
        components: { Guestbook: guestbook },
        referenceSigner: {
          sign(claims) {
            if (failSign) {
              failSign = false;
              throw new Error('signing key unavailable');
            }
            return real.sign(claims);
          },
          verify: (token) => real.verify(token),
        },
      });
      const snapshot = makeSnapshot('Guestbook');
      const upload = async (bytes: Buffer) => {
        const request = makeUploadRequest(snapshot, fileForm(snapshot, bytes));
        return runtime.handleUpload(request, uploadContext(request));
      };
      // The failed upload's file is deleted, so its 5 bytes and its file slot
      // must not count against the 8-byte, two-file quota.
      assert.equal((await upload(Buffer.from('12345'))).status, 500);
      assert.equal((await upload(Buffer.from('12345'))).status, 201);
      assert.equal((await upload(Buffer.from('123'))).status, 201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the uploads one subject may have in progress', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, {
        components: { Members: membersOnly },
        maxConcurrentPerSubject: 2,
      });
      const { session, snapshot } = sessionSnapshot('Members');
      const { contentType, bytes } = await encodeForm(fileForm(snapshot, Buffer.from('slow')));
      const gate = deferredGate();
      const stalled = [0, 1].map(() => {
        const request = gatedUploadRequest(contentType, bytes, gate.promise, {
          [COMPONENT_CSRF_HEADER]: session.csrfToken,
        });
        return runtime.handleUpload(request, uploadContext(request, session));
      });
      await Async.sleep(20);

      const third = sessionUploadRequest(snapshot, Buffer.from('x'));
      const refused = await runtime.handleUpload(third, uploadContext(third, session));
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error?.code, 'unavailable');

      // Another subject is not held back by this one.
      const other = sessionSnapshot('Members', 'session-2');
      const otherRequest = sessionUploadRequest(other.snapshot, Buffer.from('x'), 'session-2');
      assert.equal(
        (await runtime.handleUpload(otherRequest, uploadContext(otherRequest, other.session)))
          .status,
        201,
      );

      gate.release();
      for (const result of await Promise.all(stalled)) {
        assert.equal(result.status, 201);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a file part that goes idle and releases its slot', { timeout: 5000 }, async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { maxConcurrent: 1, idleTimeoutMs: 50 });
      const snapshot = makeSnapshot();
      const { contentType, bytes } = await encodeForm(fileForm(snapshot, Buffer.from('slow')));
      // Delivers everything but the last chunk, then never another byte.
      const never = new Promise<void>(() => undefined);
      const stalled = gatedUploadRequest(contentType, bytes, never);
      const result = await runtime.handleUpload(stalled, uploadContext(stalled));
      assert.equal(result.status, 400);
      assert.equal(result.body.error?.code, 'invalid_request');

      const next = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      assert.equal((await runtime.handleUpload(next, uploadContext(next))).status, 201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a file part that trickles past the total deadline', { timeout: 5000 }, async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { idleTimeoutMs: 1000, timeoutMs: 150 });
      const snapshot = makeSnapshot();
      const { contentType, bytes } = await encodeForm(fileForm(snapshot, Buffer.alloc(4096, 0x41)));
      // One small chunk every 20 ms: never idle, but far too slow overall.
      const chunks = chunkBytes(bytes, 64);
      let index = 0;
      const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          origin: ORIGIN,
          [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID,
        },
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = chunks[index];
            index += 1;
            if (chunk === undefined) {
              controller.close();
              return;
            }
            if (index > 2) await Async.sleep(20);
            controller.enqueue(chunk);
          },
        }),
        duplex: 'half',
      } as RequestInit);
      const started = Date.now();
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 400);
      assert.ok(Date.now() - started < 1000, 'the deadline, not the body, ended the upload');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws after close', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      runtime.close();
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      await assert.rejects(
        () => runtime.handleUpload(request, uploadContext(request)),
        ServerComponentRuntimeError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveUpload
// ---------------------------------------------------------------------------

describe('resolveUpload', () => {
  it('rejects a reference minted for a different component', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
      const reference = signer.sign({
        uploadId: 'upload-1',
        component: 'Other',
        subject: null,
        size: 1,
        contentType: 'image/png',
      });
      assert.throws(
        () => runtime.resolveUpload(reference, { expectedComponent: 'Avatar' }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a reference whose subject does not match', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
      const reference = signer.sign({
        uploadId: 'upload-1',
        component: 'Avatar',
        subject: 'subject-a',
        size: 1,
        contentType: 'image/png',
      });
      assert.throws(
        () =>
          runtime.resolveUpload(reference, { expectedComponent: 'Avatar', expectedSubject: null }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a non-string reference', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      assert.throws(() => runtime.resolveUpload(123, { expectedComponent: 'Avatar' }), UploadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes the stored upload', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('to-delete');
      const context = uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes)));
      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);

      const resolved = runtime.resolveUpload(result.body.reference!, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
      });
      await resolved.delete();
      assert.equal(await resolved.open(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP mount and body-limit exemption
// ---------------------------------------------------------------------------

describe('server components upload HTTP transport', () => {
  it('mounts the upload route and accepts an upload larger than the JSON body cap', async () => {
    const dir = tempDir();
    let app: TestApplication | undefined;
    try {
      app = await createTestApp({
        config: {
          rootDir: dir,
          port: 0,
          storage: 'storage',
          extensions: [
            serverComponentsPlugin({
              components: { Avatar: avatar },
              signingKey: KEY,
              uploads: {},
            }),
          ],
        },
      });

      // Mint a snapshot with the same key/clock the extension uses (default now).
      const snapshot = new HmacComponentSigner({ key: KEY }).sign({
        v: 1,
        component: 'Avatar',
        id: SNAPSHOT_ID,
        state: {},
        page: { path: '/avatar', params: {} },
        origin: app.origin,
        subject: null,
      });

      // 1.5 MiB exceeds the default 1 MiB JSON/API body cap; the upload route
      // must be exempt from that cap and accept it via the store's own limit.
      const bytes = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 0x41);
      const form = fileForm(snapshot, bytes);
      const response = await app.request(COMPONENT_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { origin: app.origin, [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID },
        body: form,
      });

      const raw = await response.text();
      assert.equal(response.status, 201, raw);
      const body = JSON.parse(raw) as { reference: string; error?: { code: string } };
      assert.ok(body.reference);
      assert.equal(body.error, undefined);

      const claims: UploadReferenceClaims = createUploadReferenceSigner({ key: KEY }).verify(
        body.reference,
      );
      assert.equal(claims.component, 'Avatar');
      assert.equal(claims.size, bytes.length);
      assert.equal(claims.contentType, 'image/png');
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-origin upload through the mounted route', async () => {
    const dir = tempDir();
    let app: TestApplication | undefined;
    try {
      app = await createTestApp({
        config: {
          rootDir: dir,
          port: 0,
          storage: 'storage',
          extensions: [
            serverComponentsPlugin({
              components: { Avatar: avatar },
              signingKey: KEY,
              uploads: {},
            }),
          ],
        },
      });
      const snapshot = new HmacComponentSigner({ key: KEY }).sign({
        v: 1,
        component: 'Avatar',
        id: SNAPSHOT_ID,
        state: {},
        page: { path: '/avatar', params: {} },
        origin: app.origin,
        subject: null,
      });
      const response = await app.request(COMPONENT_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { origin: 'https://evil.example', [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID },
        body: fileForm(snapshot, Buffer.from('x')),
      });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'origin_mismatch');
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
