/**
 * Tests for the bundle intake: the download through the outbound guard (the
 * options it passes, how each refusal reads as an installer failure, and the
 * socket closed on an oversize download) and the single-manifest rule.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import {
  DOWNLOAD_TIMEOUT_MS,
  downloadBundle,
  flattenBundleEntries,
  MAX_DOWNLOAD_REDIRECTS,
  parseExtractedManifest,
} from '../../src/plugins/bundle-intake.js';
import { PluginInstallerError } from '../../src/plugins/installer-error.js';
import {
  GuardedFetchError,
  guardedFetch,
  type GuardedFetch,
  type GuardedFetchErrorCode,
  type GuardedFetchOptions,
} from '../../src/support/guarded-fetch.server.js';
import { bundleManifestJson } from './manifest-fixture.js';

const BODY = new Uint8Array([1, 2, 3, 4]);
const START = 'https://registry.example/plugins/acme-tasks-1.0.0.tgz';

/** A guarded fetch that answers with `status` and records every call. */
function answering(status = 200): {
  readonly fetch: GuardedFetch;
  readonly calls: { url: string; options: GuardedFetchOptions }[];
} {
  const calls: { url: string; options: GuardedFetchOptions }[] = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status, headers: new Headers(), bytes: BODY.slice(), url };
    },
  };
}

function failingWith(code: GuardedFetchErrorCode): GuardedFetch {
  return async () => {
    throw new GuardedFetchError(code, 'refused');
  };
}

function rejectsWith(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PluginInstallerError && error.code === code;
}

describe('downloadBundle', () => {
  it('downloads through the guard with the bounds and no private access by default', async () => {
    const { fetch, calls } = answering();
    const bytes = await downloadBundle(START, { fetch, maxBytes: 1024 });
    assert.deepEqual(bytes, BODY);
    assert.deepEqual(calls, [
      {
        url: START,
        options: {
          maxBytes: 1024,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxRedirects: MAX_DOWNLOAD_REDIRECTS,
          allowPrivate: false,
        },
      },
    ]);
  });

  it('passes the host list and the private-host opt-in to the guard', async () => {
    const { fetch, calls } = answering();
    await downloadBundle(START, {
      fetch,
      maxBytes: 1024,
      allowedHosts: ['registry.example'],
      allowPrivateHosts: true,
    });
    assert.deepEqual(calls[0]?.options.allowHosts, ['registry.example']);
    assert.equal(calls[0]?.options.allowPrivate, true);
  });

  it('fails a final response that is not 2xx', async () => {
    for (const status of [199, 302, 404, 500]) {
      await assert.rejects(
        downloadBundle(START, { fetch: answering(status).fetch, maxBytes: 1024 }),
        rejectsWith('fetch_failed'),
      );
    }
  });

  it('reads every refusal of the guard as an installer failure', async () => {
    const expected: Record<GuardedFetchErrorCode, string> = {
      invalid_options: 'invalid_options',
      invalid_url: 'invalid_url',
      host_not_allowed: 'invalid_url',
      resolve_failed: 'fetch_failed',
      blocked_address: 'private_address',
      connect_failed: 'fetch_failed',
      tls: 'fetch_failed',
      response_failed: 'fetch_failed',
      too_many_redirects: 'fetch_failed',
      too_large: 'oversize_download',
      timeout: 'fetch_failed',
      aborted: 'fetch_failed',
    };
    for (const [code, installerCode] of Object.entries(expected)) {
      await assert.rejects(
        downloadBundle(START, { fetch: failingWith(code as GuardedFetchErrorCode), maxBytes: 1 }),
        rejectsWith(installerCode),
        code,
      );
    }
  });

  it('sanitizes an unexpected failure without echoing the URL', async () => {
    const url = 'https://user:s3cr3t@registry.example/a.tgz?token=s3cr3t';
    await assert.rejects(
      downloadBundle(url, {
        fetch: async (requested) => {
          throw new Error(`boom while fetching ${requested}`);
        },
        maxBytes: 1024,
      }),
      (error: unknown) =>
        error instanceof PluginInstallerError &&
        error.code === 'fetch_failed' &&
        !error.message.includes('s3cr3t'),
    );
  });

  it('closes the server-side socket of an oversize download', async () => {
    let timer: NodeJS.Timeout | undefined;
    let markClosed: () => void = () => {};
    const closed = new Promise<'closed'>((resolve) => {
      markClosed = () => resolve('closed');
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/gzip' });
      // A sender that never stops: only the client hanging up ends the response.
      timer = setInterval(() => response.write(new Uint8Array(16 * 1024)), 5);
      response.on('close', () => {
        clearInterval(timer);
        markClosed();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await assert.rejects(
        downloadBundle(`http://127.0.0.1:${port}/a.tgz`, {
          fetch: guardedFetch,
          maxBytes: 64 * 1024,
          allowPrivateHosts: true,
        }),
        rejectsWith('oversize_download'),
      );
      const deadline = new Promise<'open'>((resolve) =>
        setTimeout(() => resolve('open'), 2000).unref(),
      );
      assert.equal(await Promise.race([closed, deadline]), 'closed');
    } finally {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses a loopback download without the private-host opt-in', async () => {
    await assert.rejects(
      downloadBundle('https://127.0.0.1:1/a.tgz', { fetch: guardedFetch, maxBytes: 1024 }),
      rejectsWith('private_address'),
    );
  });
});

describe('bundle manifest intake', () => {
  const encoder = new TextEncoder();
  const manifestBytes = (id: string): Uint8Array =>
    encoder.encode(
      JSON.stringify(
        bundleManifestJson({ id, version: '1.0.0', jsailsCompat: '^0.1.0', entry: './i.js' }),
      ),
    );

  it('refuses a second manifest anywhere in the archive', () => {
    const entries = new Map([
      ['a/manifest.json', manifestBytes('acme')],
      ['b/c/manifest.json', manifestBytes('evil')],
    ]);
    assert.throws(
      () => parseExtractedManifest(flattenBundleEntries(entries)),
      (error: unknown) =>
        error instanceof PluginInstallerError && error.code === 'multiple_manifests',
    );
  });

  it('strips one shared top-level directory and nothing deeper', () => {
    const flattened = flattenBundleEntries(
      new Map([
        ['package/manifest.json', manifestBytes('acme')],
        ['package/lib/index.js', new Uint8Array(0)],
      ]),
    );
    assert.deepEqual([...flattened.keys()], ['manifest.json', 'lib/index.js']);
    assert.equal(parseExtractedManifest(flattened).id, 'acme');

    const mixed = new Map([
      ['manifest.json', manifestBytes('acme')],
      ['lib/index.js', new Uint8Array(0)],
    ]);
    assert.equal(flattenBundleEntries(mixed), mixed);
  });
});
