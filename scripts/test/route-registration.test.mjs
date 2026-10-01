/**
 * The first-party route snapshot: how a route renders as a line, and how the
 * check and write modes compare and record the committed list.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  formatRoute,
  formatSurface,
  main,
  renderSnapshot,
  SNAPSHOT,
} from '../route-registration.mjs';

const root = mkdtempSync(join(tmpdir(), 'route-registration-'));
mkdirSync(join(root, 'api'));
after(() => rmSync(root, { recursive: true, force: true }));

const route = {
  kind: 'api',
  methods: ['POST'],
  pattern: '/api/login',
  access: { kind: 'public', reason: 'sign-in form' },
  surface: 'route',
  credentials: ['cookie', 'token'],
  owner: 'auth',
  origin: 'code-plugin',
};

describe('route registration snapshot', () => {
  it('renders a route with its access, surface, credentials, rule, owner and origin', () => {
    assert.equal(
      formatRoute(route),
      'api POST /api/login public(sign-in form) surface=route credentials=cookie,token cross-site=origin auth/code-plugin',
    );
    assert.equal(
      formatRoute({ ...route, access: { kind: 'legacy', reason: '' } }),
      'api POST /api/login legacy surface=route credentials=cookie,token cross-site=origin auth/code-plugin',
    );
    assert.equal(
      formatRoute({ ...route, credentials: [] }),
      'api POST /api/login public(sign-in form) surface=route credentials=none cross-site=none auth/code-plugin',
    );
  });

  it('renders a surface outside the route table with its kind, credentials and owner', () => {
    assert.equal(
      formatSurface({
        id: 'asset:public',
        kind: 'asset',
        match: { methods: ['GET', 'HEAD'], pattern: '/*' },
        access: { kind: 'public', reason: 'a public file' },
        credentials: [],
        owner: 'framework',
      }),
      'surface asset:public GET,HEAD /* public(a public file) surface=asset credentials=none framework',
    );
  });

  it("renders a multipart body's parts, so widening any part limit changes the line", () => {
    const parts = {
      maxParts: 2,
      maxFieldBytes: 100,
      maxHeaderBytes: 8192,
      files: Object.assign(Object.create(null), {
        photo: { maxBytes: 1024, maxCount: 1, contentTypes: ['image/*'] },
        doc: { maxBytes: 2048, maxCount: 3 },
      }),
      idleMs: 30000,
    };
    const upload = (value) => ({
      ...route,
      pattern: '/upload',
      body: { kind: 'multipart', maxBytes: 4096, parts: value },
    });
    const line = formatRoute(upload(parts));
    assert.equal(
      line,
      'api POST /upload public(sign-in form) surface=route credentials=cookie,token cross-site=origin body=multipart:4096 parts=2 field=100 header=8192 body-idle=30000 file:"doc"=2048x3:any file:"photo"=1024x1:image/* auth/code-plugin',
    );
    const photo = parts.files.photo;
    const widened = [
      { ...parts, maxParts: 3 },
      { ...parts, maxFieldBytes: 101 },
      { ...parts, maxHeaderBytes: 16384 },
      { ...parts, idleMs: 60000 },
      { ...parts, files: { ...parts.files, photo: { ...photo, maxBytes: 4096 } } },
      { ...parts, files: { ...parts.files, photo: { ...photo, maxCount: 2 } } },
      {
        ...parts,
        files: { ...parts.files, photo: { ...photo, contentTypes: ['application/*'] } },
      },
      { ...parts, files: { ...parts.files, photo: { maxBytes: 1024, maxCount: 1 } } },
      { ...parts, files: { ...parts.files, extra: photo } },
    ];
    for (const value of widened) {
      assert.notEqual(formatRoute(upload(value)), line, JSON.stringify(value));
    }
  });

  it('records the list, then fails the check when a route changes', async () => {
    const lines = [formatRoute(route)];
    const collect = async () => lines;
    const options = { root, collect };
    assert.equal((await main(['--check'], options)).status, 1, 'no snapshot yet');
    assert.equal((await main(['--write'], options)).status, 0);
    assert.equal(readFileSync(join(root, SNAPSHOT), 'utf8'), renderSnapshot(lines));
    assert.deepEqual(await main(['--check'], options), { status: 0, messages: [] });

    lines.push(formatRoute({ ...route, methods: ['DELETE'], pattern: '/api/tokens/:id' }));
    const changed = await main(['--check'], options);
    assert.equal(changed.status, 1);
    assert.match(changed.messages[0] ?? '', /api\/routes\.md does not match/);
  });
});
