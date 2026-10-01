/**
 * Unexpected request failures reach the `onError` hook (or the default stderr
 * logger) with the route pattern and request id, while the response stays the
 * value-free envelope; expected failures are never reported.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it, mock } from 'node:test';

import { createApp } from '../../src/server/app.js';
import {
  createRequestErrorReporter,
  isExpectedRequestError,
  logRequestError,
  type RequestErrorInfo,
} from '../../src/server/request-errors.js';
import { HttpError } from '../../src/contracts/http.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'request-errors-'));
after(() => rmSync(root, { recursive: true, force: true }));

const contractsUrl = pathToFileURL(join(distDir, 'src/contracts/http.js')).href;

writeFixture(
  root,
  'api/boom/[id].mjs',
  `export const GET = () => { throw new Error('db exploded'); };\nexport const authorize = () => true;\n`,
);
writeFixture(
  root,
  'api/teapot.mjs',
  `import { HttpError } from '${contractsUrl}';
export const GET = () => { throw new HttpError('teapot', 'short and stout', 418); };
export const authorize = () => true;\n`,
);
writeFixture(
  root,
  'api/ok.mjs',
  `export const GET = () => Response.json({ ok: true });
export const authorize = (context) => context.session === null;\n`,
);
writeFixture(
  root,
  'api/policy.mjs',
  `export const GET = () => Response.json({ ok: true });
export const authorize = () => { throw new Error('policy store down'); };\n`,
);
const manifest = discoverRoutes(root);

interface Report {
  readonly error: unknown;
  readonly info: RequestErrorInfo;
}

function collector(): {
  reports: Report[];
  onError: (error: unknown, info: RequestErrorInfo) => void;
} {
  const reports: Report[] = [];
  return { reports, onError: (error, info) => void reports.push({ error, info }) };
}

describe('request error reporting', () => {
  it('reports a handler throw with the route pattern and request id, response value-free', async () => {
    const { reports, onError } = collector();
    const app = await createApp({ manifest, onError });
    const res = await app.fetch(
      new Request('http://localhost/api/boom/42?token=secret', {
        headers: { 'x-request-id': 'req-123' },
      }),
    );
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /db exploded/);
    assert.equal(reports.length, 1);
    const report = reports[0]!;
    assert.equal((report.error as Error).message, 'db exploded');
    assert.deepEqual(report.info, {
      phase: 'handler',
      method: 'GET',
      route: '/api/boom/:id',
      requestId: 'req-123',
    });
  });

  it('does not report an expected HttpError below 500', async () => {
    const { reports, onError } = collector();
    const app = await createApp({ manifest, onError });
    const res = await app.fetch(new Request('http://localhost/api/teapot'));
    assert.equal(res.status, 418);
    assert.equal(reports.length, 0);
  });

  it('reports a throwing session resolver and fails closed to anonymous', async () => {
    const { reports, onError } = collector();
    const app = await createApp({
      manifest,
      resolveSession: () => {
        throw new Error('session store down');
      },
      onError,
    });
    const res = await app.fetch(
      new Request('http://localhost/api/ok', { headers: { cookie: 'sid=1' } }),
    );
    assert.equal(res.status, 200);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.info.phase, 'session');
  });

  it('reports a throwing access check and answers it as a fault', async () => {
    const { reports, onError } = collector();
    const app = await createApp({ manifest, onError });
    const res = await app.fetch(new Request('http://localhost/api/policy'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.info.phase, 'authorize');
  });

  it('logs to stderr with the stack by default', async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (line: string) => void lines.push(line));
    const app = await createApp({ manifest });
    const res = await app.fetch(new Request('http://localhost/api/boom/1'));
    assert.equal(res.status, 500);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\[jsails\] handler failed: GET \/api\/boom\/:id request_id=\S+/);
    assert.match(lines[0]!, /db exploded/);
    assert.match(lines[0]!, /at /);
  });

  it('survives a throwing hook without echoing its error', async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (line: string) => void lines.push(line));
    const report = createRequestErrorReporter(() => {
      throw new Error('hook secret');
    });
    await report(new Error('x'), {
      phase: 'handler',
      method: 'GET',
      route: '/',
      requestId: undefined,
    });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /hook secret/);
  });

  it('classifies expected errors', () => {
    assert.equal(isExpectedRequestError(new HttpError('nope', 'Nope', 404)), true);
    assert.equal(isExpectedRequestError(new HttpError('down', 'Down', 503)), false);
    assert.equal(isExpectedRequestError(new Error('x')), false);
  });

  it('logRequestError names a non-Error throw without echoing it', () => {
    const spy = mock.method(console, 'error', () => undefined);
    try {
      logRequestError('raw secret string', {
        phase: 'component',
        method: 'POST',
        route: '/x',
        requestId: undefined,
      });
      const line = String(spy.mock.calls[0]?.arguments[0]);
      assert.match(line, /non-Error string thrown/);
      assert.doesNotMatch(line, /raw secret string/);
    } finally {
      spy.mock.restore();
    }
  });
});
