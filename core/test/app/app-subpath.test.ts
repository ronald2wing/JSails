/**
 * App subpath tests: the `jsails/app` barrel shares one canonical export with
 * the root entry. No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp, createHttpServer, createPublicFilesMiddleware } from '../../src/app/index.js';
import type { AppOptions } from '../../src/app/index.js';

// Root-entry imports for the same-function-reference verification.
import { createApp as rootCreateApp } from '../../src/server/app.js';
import { createHttpServer as rootCreateHttpServer } from '../../src/server/http-server.js';
import { createPublicFilesMiddleware as rootCreatePublicFilesMiddleware } from '../../src/app/public-files.js';

describe('jsails/app barrel', () => {
  it('re-exports createApp from the same source as the root entry', () => {
    // Same function reference means the barrel and the root share one canonical export.
    assert.strictEqual(createApp, rootCreateApp);
  });

  it('re-exports createHttpServer from the same source as the root entry', () => {
    assert.strictEqual(createHttpServer, rootCreateHttpServer);
  });

  it('re-exports createPublicFilesMiddleware from the same source as the root entry', () => {
    assert.strictEqual(createPublicFilesMiddleware, rootCreatePublicFilesMiddleware);
  });

  it('exposes the core HTTP types (compile-time)', () => {
    // The import-block above already proves all types resolve. This test
    // exercises the value-level shape using `typeof` in a value position.
    const options: AppOptions = { manifest: { entries: [], byRoute: new Map() } };
    assert.equal(typeof options.manifest, 'object');
  });
});
