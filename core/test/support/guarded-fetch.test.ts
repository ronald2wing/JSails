/**
 * Tests for `guardedFetch` against loopback servers: the vetted-address
 * connection (a rebinding resolver never redirects it), every redirect checked
 * like the first hop, the transport rules, the size and time bounds observed
 * from the server side, and value-free errors.
 */

import assert from 'node:assert/strict';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { describe, it } from 'node:test';

import {
  GuardedFetchErrors,
  createGuardedFetch,
  type GuardedConnector,
  type GuardedFetch,
  type GuardedFetchOptions,
  type GuardedResolver,
} from '../../src/support/guarded-fetch.server.js';

// A test-only CA and a leaf for `registry.test`, `cdn.test` and `127.0.0.1`, valid until
// 2126. They exist for these tests and protect nothing.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBpjCCAU2gAwIBAgIUd0PcbHsYlZvE7/PCHB45VKkXoSwwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVZ3VhcmRlZC1mZXRjaCB0ZXN0IENBMCAXDTI2MTEyMTAyNDMw
N1oYDzIxMjYxMDI4MDI0MzA3WjAgMR4wHAYDVQQDDBVndWFyZGVkLWZldGNoIHRl
c3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ9FTaqR1ncBzZaqGhwMj5u
TbKYXdQ+rlDJoloW6IMQT5ubi9zNlE6dB0q1rX99nJAUJ0mefBGHZlxMwr+F9EXt
o2MwYTAdBgNVHQ4EFgQU0m/x4nYiIymmuEhPeCHzECC6Dm4wHwYDVR0jBBgwFoAU
0m/x4nYiIymmuEhPeCHzECC6Dm4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E
BAMCAgQwCgYIKoZIzj0EAwIDRwAwRAIgXNqy6LU3YN+iLar1Zw9vp04Z2JuEXxGw
blYHPMcH4fMCIHnmPqzR2dB6x0b9l0jouRu4vI8i47Wo1Th8qM9jO/9a
-----END CERTIFICATE-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIByjCCAXCgAwIBAgIUeVPYdsBKahjITajtJmLj78NC4MswCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVZ3VhcmRlZC1mZXRjaCB0ZXN0IENBMCAXDTI2MTEyMTAyNTE0
N1oYDzIxMjYxMDI4MDI1MTQ3WjAYMRYwFAYDVQQDDA1yZWdpc3RyeS50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhudhp6BhV6lqsT1XGQdrryqALQpPOWka
4fXwpE2mVxY5aS32JEgYMJWkye/IAkPASRPWNb4kTGnsLepdgaamKqOBjTCBijAo
BgNVHREEITAfgg1yZWdpc3RyeS50ZXN0gghjZG4udGVzdIcEfwAAATAJBgNVHRME
AjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBQClhm9KzXBF1BVGLce
ZlQl8JSlfzAfBgNVHSMEGDAWgBTSb/HidiIjKaa4SE94IfMQILoObjAKBggqhkjO
PQQDAgNIADBFAiEAxQbKoJmcq/5L77OZeWwtlXIpgaTVlI8iHSUIx2QyRVcCIFoL
/uGiMoYzJpM5hSA2gLdzLKfqKAz14X7MvxY7F1bP
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1OJR0B7Iomf59RQb
nwxfarPObFipPZ2AtpckUvnrJFOhRANCAASG52GnoGFXqWqxPVcZB2uvKoAtCk85
aRrh9fCkTaZXFjlpLfYkSBgwlaTJ78gCQ8BJE9Y1viRMaewt6l2BpqYq
-----END PRIVATE KEY-----
`;

/** Public addresses the fake resolver hands out; the connector routes them to loopback. */
const PUBLIC_A = '93.184.215.14';
const PUBLIC_B = '93.184.215.15';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly port: number;
  /** Request URLs (path and query) in arrival order. */
  readonly requests: IncomingMessage[];
  /** Resolves once the server has seen a request's connection close. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Start a loopback server, HTTPS with the test leaf unless `plain`. */
async function startServer(handler: Handler, plain = false): Promise<TestServer> {
  const requests: IncomingMessage[] = [];
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const listener: Handler = (request, response) => {
    requests.push(request);
    request.socket.on('close', markClosed);
    handler(request, response);
  };
  const server: Server = plain
    ? createHttpServer(listener)
    : createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    closed,
    close: async () => {
      (server as ReturnType<typeof createHttpServer>).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A resolver over a fixed table, recording every lookup. A host listed with
 * several answers returns the next one on each call (a rebinding resolver).
 */
function tableResolver(table: Record<string, readonly (readonly string[])[]>): {
  readonly resolve: GuardedResolver;
  readonly lookups: string[];
} {
  const lookups: string[] = [];
  const calls = new Map<string, number>();
  return {
    lookups,
    resolve: async (hostname) => {
      lookups.push(hostname);
      const answers = table[hostname];
      if (answers === undefined) throw new Error('ENOTFOUND');
      const call = calls.get(hostname) ?? 0;
      calls.set(hostname, call + 1);
      return answers[Math.min(call, answers.length - 1)] ?? [];
    },
  };
}

/**
 * A connector that records the vetted address it was asked for and connects
 * to the loopback server on the same port, standing in for the public host.
 */
function loopbackConnector(refuse: ReadonlySet<string> = new Set()): {
  readonly connect: GuardedConnector;
  readonly targets: string[];
} {
  const targets: string[] = [];
  return {
    targets,
    connect: (target) => {
      targets.push(target.address);
      if (refuse.has(target.address)) return Promise.reject(new Error('ECONNREFUSED'));
      return new Promise<Socket>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: target.port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    },
  };
}

function rejectsWith(code: keyof typeof GuardedFetchErrors.codes): (error: unknown) => boolean {
  return (error) => {
    assert.ok(GuardedFetchErrors.is(error), String(error));
    assert.equal(error.code, `guarded_fetch.${code}`);
    return true;
  };
}

const LIMITS: GuardedFetchOptions = { maxBytes: 64 * 1024, timeoutMs: 5_000 };

/** Settles with 'closed' when `closed` resolves within two seconds. */
async function closedWithin(closed: Promise<void>): Promise<'closed' | 'open'> {
  const open = new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 2_000).unref());
  return Promise.race([closed.then(() => 'closed' as const), open]);
}

/** A fetch whose resolver answers `table` and whose connector reaches the loopback server. */
function harness(
  table: Record<string, readonly (readonly string[])[]>,
  refuse?: ReadonlySet<string>,
): {
  readonly fetch: GuardedFetch;
  readonly lookups: string[];
  readonly targets: string[];
} {
  const resolver = tableResolver(table);
  const connector = loopbackConnector(refuse);
  return {
    fetch: createGuardedFetch({
      resolve: resolver.resolve,
      connect: connector.connect,
      ca: TEST_CA,
    }),
    lookups: resolver.lookups,
    targets: connector.targets,
  };
}

describe('guardedFetch connection', () => {
  it('connects to the vetted address with the URL host as TLS name and Host header', async () => {
    const server = await startServer((request, response) => {
      response.end(`host=${request.headers.host ?? ''}`);
    });
    try {
      const { fetch, lookups, targets } = harness({ 'registry.test': [[PUBLIC_A]] });
      const url = `https://registry.test:${server.port}/bundle.tgz?v=1#frag`;
      const response = await fetch(url, LIMITS);
      assert.equal(response.status, 200);
      assert.equal(new TextDecoder().decode(response.bytes), `host=registry.test:${server.port}`);
      assert.equal(response.url, `https://registry.test:${server.port}/bundle.tgz?v=1`);
      assert.equal(server.requests[0]?.url, '/bundle.tgz?v=1');
      assert.equal(server.requests[0]?.headers['accept-encoding'], 'identity');
      assert.equal(server.requests[0]?.headers.connection, 'close');
      assert.deepEqual(lookups, ['registry.test']);
      assert.deepEqual(targets, [PUBLIC_A]);
    } finally {
      await server.close();
    }
  });

  it('resolves once, so a rebinding resolver cannot move the connection', async () => {
    const server = await startServer((_request, response) => response.end('ok'));
    try {
      // The first answer is public; every later one points at loopback.
      const { fetch, lookups, targets } = harness({
        'registry.test': [[PUBLIC_A], ['127.0.0.1']],
      });
      const response = await fetch(`https://registry.test:${server.port}/`, LIMITS);
      assert.equal(response.status, 200);
      assert.deepEqual(lookups, ['registry.test']);
      assert.deepEqual(targets, [PUBLIC_A]);
    } finally {
      await server.close();
    }
  });

  it('falls back to the next vetted address, never to an unvetted one', async () => {
    const server = await startServer((_request, response) => response.end('ok'));
    try {
      const { fetch, targets } = harness(
        { 'registry.test': [[PUBLIC_A, PUBLIC_B]] },
        new Set([PUBLIC_A]),
      );
      const response = await fetch(`https://registry.test:${server.port}/`, LIMITS);
      assert.equal(response.status, 200);
      assert.deepEqual(targets, [PUBLIC_A, PUBLIC_B]);
    } finally {
      await server.close();
    }
  });

  it('fails with connect_failed when no vetted address accepts', async () => {
    const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] }, new Set([PUBLIC_A]));
    await assert.rejects(fetch('https://registry.test/', LIMITS), rejectsWith('connect_failed'));
  });

  it('refuses a host when any one of its addresses is blocked', async () => {
    for (const blocked of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.0.1', 'fd00::1']) {
      const { fetch, targets } = harness({ 'registry.test': [[PUBLIC_A, blocked]] });
      await assert.rejects(fetch('https://registry.test/', LIMITS), rejectsWith('blocked_address'));
      assert.deepEqual(targets, []);
    }
  });

  it('refuses blocked IP literals without a lookup', async () => {
    const { fetch, lookups, targets } = harness({});
    for (const url of [
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://0.0.0.0/',
    ]) {
      await assert.rejects(fetch(url, LIMITS), rejectsWith('blocked_address'));
    }
    assert.deepEqual(lookups, []);
    assert.deepEqual(targets, []);
  });

  it('fails closed on a resolver that throws, answers nothing, or answers a name', async () => {
    for (const resolve of [
      async () => {
        throw new Error('ENOTFOUND registry.test');
      },
      async () => [],
      async () => ['registry.internal'],
      async () => 'not-a-list' as unknown as string[],
    ] satisfies GuardedResolver[]) {
      const connector = loopbackConnector();
      const fetch = createGuardedFetch({ resolve, connect: connector.connect });
      await assert.rejects(
        fetch('https://registry.test/', { ...LIMITS, allowPrivate: true }),
        rejectsWith('resolve_failed'),
      );
      assert.deepEqual(connector.targets, []);
    }
  });

  it('fails with tls on a certificate that does not name the host', async () => {
    const server = await startServer((_request, response) => response.end('ok'));
    try {
      const { fetch } = harness({ 'other.test': [[PUBLIC_A]] });
      await assert.rejects(fetch(`https://other.test:${server.port}/`, LIMITS), rejectsWith('tls'));
    } finally {
      await server.close();
    }
  });

  it('fails with tls on a certificate the trusted roots do not cover', async () => {
    const server = await startServer((_request, response) => response.end('ok'));
    try {
      const resolver = tableResolver({ 'registry.test': [[PUBLIC_A]] });
      const fetch = createGuardedFetch({
        resolve: resolver.resolve,
        connect: loopbackConnector().connect,
      });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, LIMITS),
        rejectsWith('tls'),
      );
    } finally {
      await server.close();
    }
  });
});

describe('guardedFetch transport rules', () => {
  it('refuses plain http unless allowPrivate is set and every address is loopback', async () => {
    const server = await startServer((_request, response) => response.end('plain'), true);
    try {
      const fetch = createGuardedFetch({
        resolve: tableResolver({ 'registry.test': [[PUBLIC_A]], localhost: [['127.0.0.1']] })
          .resolve,
      });
      await assert.rejects(
        fetch(`http://127.0.0.1:${server.port}/`, LIMITS),
        rejectsWith('invalid_url'),
      );
      await assert.rejects(
        fetch(`http://registry.test:${server.port}/`, { ...LIMITS, allowPrivate: true }),
        rejectsWith('invalid_url'),
      );
      // The default TCP connector, against the real loopback server.
      for (const host of ['127.0.0.1', 'localhost']) {
        const response = await fetch(`http://${host}:${server.port}/`, {
          ...LIMITS,
          allowPrivate: true,
        });
        assert.equal(new TextDecoder().decode(response.bytes), 'plain');
      }
    } finally {
      await server.close();
    }
  });

  it('reaches a private https address with allowPrivate, verifying its IP certificate', async () => {
    const server = await startServer((_request, response) => response.end('private'));
    try {
      const fetch = createGuardedFetch({ ca: TEST_CA });
      const response = await fetch(`https://127.0.0.1:${server.port}/`, {
        ...LIMITS,
        allowPrivate: true,
      });
      assert.equal(new TextDecoder().decode(response.bytes), 'private');
    } finally {
      await server.close();
    }
  });

  it('refuses other schemes and URLs that carry credentials', async () => {
    const { fetch, targets } = harness({ 'registry.test': [[PUBLIC_A]] });
    for (const url of [
      'ftp://registry.test/a.tgz',
      'file:///etc/passwd',
      'https://user:pass@registry.test/a.tgz',
      'not a url',
      '',
    ]) {
      await assert.rejects(fetch(url, LIMITS), rejectsWith('invalid_url'));
    }
    assert.deepEqual(targets, []);
  });

  it('checks allowHosts case-insensitively before resolving', async () => {
    const { fetch, lookups } = harness({ 'registry.test': [[PUBLIC_A]] });
    await assert.rejects(
      fetch('https://evil.test/', { ...LIMITS, allowHosts: ['Registry.Test'] }),
      rejectsWith('host_not_allowed'),
    );
    assert.deepEqual(lookups, []);
  });

  it('compares allowHosts in the form URL#hostname spells the host', async () => {
    const server = await startServer((_request, response) => response.end('ok'));
    try {
      const { fetch } = harness({ 'xn--bcher-kva.test': [[PUBLIC_A]] });
      const response = await fetch(`https://xn--bcher-kva.test:${server.port}/`, {
        ...LIMITS,
        allowHosts: ['B\u00fccher.Test'],
      }).catch((error: unknown) => error);
      // The leaf does not name this host, so reaching the TLS step proves the
      // host check passed.
      assert.ok(GuardedFetchErrors.is(response));
      assert.equal(response.code, 'guarded_fetch.tls');
    } finally {
      await server.close();
    }
  });

  it('returns a non-2xx response instead of failing', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(404, { 'x-reason': 'missing' });
      response.end('nope');
    });
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      const response = await fetch(`https://registry.test:${server.port}/`, LIMITS);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('x-reason'), 'missing');
      assert.equal(new TextDecoder().decode(response.bytes), 'nope');
    } finally {
      await server.close();
    }
  });
});

describe('guardedFetch redirects', () => {
  /** A server answering each path from `routes` with a redirect or a body. */
  function routed(routes: Record<string, (port: number) => [number, string]>): Handler {
    return (request, response) => {
      const port = request.socket.localPort ?? 0;
      const route = routes[request.url ?? ''];
      if (route === undefined) {
        response.writeHead(404).end();
        return;
      }
      const [status, value] = route(port);
      if (status >= 300 && status < 400) response.writeHead(status, { location: value }).end();
      else response.writeHead(status).end(value);
    };
  }

  it('re-checks a redirect into a private range before requesting it', async () => {
    const server = await startServer(
      routed({
        '/start': (port) => [302, `https://internal.test:${port}/secret`],
        '/meta': () => [302, 'https://169.254.169.254/latest/meta-data'],
      }),
    );
    try {
      const { fetch, targets } = harness({
        'registry.test': [[PUBLIC_A]],
        'internal.test': [['10.0.0.5']],
      });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/start`, LIMITS),
        rejectsWith('blocked_address'),
      );
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/meta`, LIMITS),
        rejectsWith('blocked_address'),
      );
      assert.deepEqual(targets, [PUBLIC_A, PUBLIC_A]);
      assert.deepEqual(
        server.requests.map((request) => request.url),
        ['/start', '/meta'],
      );
    } finally {
      await server.close();
    }
  });

  it('re-resolves each hop, so a rebinding answer on a redirect is refused', async () => {
    const server = await startServer(
      routed({ '/start': (port) => [301, `https://registry.test:${port}/next`] }),
    );
    try {
      const { fetch, lookups, targets } = harness({
        'registry.test': [[PUBLIC_A], ['127.0.0.1']],
      });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/start`, LIMITS),
        rejectsWith('blocked_address'),
      );
      assert.deepEqual(lookups, ['registry.test', 'registry.test']);
      assert.deepEqual(targets, [PUBLIC_A]);
    } finally {
      await server.close();
    }
  });

  it('refuses a redirect that downgrades to http, carries credentials, or leaves allowHosts', async () => {
    const server = await startServer(
      routed({
        '/http': (port) => [302, `http://registry.test:${port}/a`],
        '/creds': (port) => [302, `https://u:p@registry.test:${port}/a`],
        '/other': (port) => [302, `https://cdn.test:${port}/a`],
      }),
    );
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]], 'cdn.test': [[PUBLIC_B]] });
      const base = `https://registry.test:${server.port}`;
      await assert.rejects(fetch(`${base}/http`, LIMITS), rejectsWith('invalid_url'));
      await assert.rejects(fetch(`${base}/creds`, LIMITS), rejectsWith('invalid_url'));
      await assert.rejects(
        fetch(`${base}/other`, { ...LIMITS, allowHosts: ['registry.test'] }),
        rejectsWith('host_not_allowed'),
      );
    } finally {
      await server.close();
    }
  });

  it('follows exactly maxRedirects hops and fails on one more', async () => {
    const routes: Record<string, (port: number) => [number, string]> = {};
    for (let index = 0; index < 3; index += 1) {
      routes[`/${index}`] = (port) => [307, `https://registry.test:${port}/${index + 1}`];
    }
    routes['/3'] = () => [200, 'done'];
    const server = await startServer(routed(routes));
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      const url = `https://registry.test:${server.port}/0`;
      const response = await fetch(url, { ...LIMITS, maxRedirects: 3 });
      assert.equal(new TextDecoder().decode(response.bytes), 'done');
      assert.equal(response.url, `https://registry.test:${server.port}/3`);
      await assert.rejects(
        fetch(url, { ...LIMITS, maxRedirects: 2 }),
        rejectsWith('too_many_redirects'),
      );
    } finally {
      await server.close();
    }
  });

  it('turns a POST into a GET on 303 and drops credentials across origins', async () => {
    const seen: { method: string; body: string; authorization: string | undefined }[] = [];
    const server = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method ?? '',
          body: Buffer.concat(chunks).toString(),
          authorization: request.headers.authorization,
        });
        const port = request.socket.localPort ?? 0;
        if (request.url === '/post') {
          response.writeHead(307, { location: `/kept` }).end();
        } else if (request.url === '/kept') {
          response.writeHead(303, { location: `https://cdn.test:${port}/done` }).end();
        } else {
          response.end('ok');
        }
      });
    });
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]], 'cdn.test': [[PUBLIC_B]] });
      const response = await fetch(`https://registry.test:${server.port}/post`, {
        ...LIMITS,
        method: 'POST',
        body: 'payload',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(seen, [
        { method: 'POST', body: 'payload', authorization: 'Bearer t' },
        { method: 'POST', body: 'payload', authorization: 'Bearer t' },
        { method: 'GET', body: '', authorization: undefined },
      ]);
    } finally {
      await server.close();
    }
  });

  it('sends a header named like an object prototype key', async () => {
    const server = await startServer((request, response) => {
      // `rawHeaders`: Node's parsed `headers` object drops a `__proto__` field.
      const index = request.rawHeaders.findIndex((name) => name.toLowerCase() === '__proto__');
      response.end(index >= 0 ? (request.rawHeaders[index + 1] ?? '') : 'lost');
    });
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      const headers = JSON.parse('{"__proto__":"kept"}') as Record<string, string>;
      const response = await fetch(`https://registry.test:${server.port}/`, {
        ...LIMITS,
        headers,
      });
      assert.equal(new TextDecoder().decode(response.bytes), 'kept');
    } finally {
      await server.close();
    }
  });
});

describe('guardedFetch bounds', () => {
  /** A server that keeps sending until the client hangs up. */
  function endless(
    intervalMs: number,
    chunkBytes: number,
  ): {
    readonly handler: Handler;
    stop(): void;
  } {
    const timers = new Set<NodeJS.Timeout>();
    return {
      handler: (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        const timer = setInterval(() => response.write(new Uint8Array(chunkBytes)), intervalMs);
        timers.add(timer);
        response.on('close', () => clearInterval(timer));
      },
      stop: () => {
        for (const timer of timers) clearInterval(timer);
      },
    };
  }

  it('stops reading past maxBytes and the server sees the socket close', async () => {
    const sender = endless(5, 16 * 1024);
    const server = await startServer(sender.handler);
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, { ...LIMITS, maxBytes: 64 * 1024 }),
        rejectsWith('too_large'),
      );
      assert.equal(await closedWithin(server.closed), 'closed');
    } finally {
      sender.stop();
      await server.close();
    }
  });

  it('refuses a declared Content-Length above maxBytes before reading', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-length': '1000000' });
      response.write(new Uint8Array(10));
    });
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, { ...LIMITS, maxBytes: 1024 }),
        rejectsWith('too_large'),
      );
      assert.equal(await closedWithin(server.closed), 'closed');
    } finally {
      await server.close();
    }
  });

  it('times out a slow-drip body and the server sees the socket close', async () => {
    const sender = endless(50, 1);
    const server = await startServer(sender.handler);
    try {
      const { fetch } = harness({ 'registry.test': [[PUBLIC_A]] });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, { ...LIMITS, timeoutMs: 300 }),
        rejectsWith('timeout'),
      );
      assert.equal(await closedWithin(server.closed), 'closed');
    } finally {
      sender.stop();
      await server.close();
    }
  });

  it('times out a resolver that never answers', async () => {
    const fetch = createGuardedFetch({ resolve: () => new Promise<string[]>(() => {}) });
    await assert.rejects(
      fetch('https://registry.test/', { ...LIMITS, timeoutMs: 50 }),
      rejectsWith('timeout'),
    );
  });

  it('fails with aborted when the caller aborts, before or during the request', async () => {
    const sender = endless(20, 1);
    const server = await startServer(sender.handler);
    try {
      const { fetch, targets } = harness({ 'registry.test': [[PUBLIC_A]] });
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, { ...LIMITS, signal: AbortSignal.abort() }),
        rejectsWith('aborted'),
      );
      assert.deepEqual(targets, []);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100).unref();
      await assert.rejects(
        fetch(`https://registry.test:${server.port}/`, { ...LIMITS, signal: controller.signal }),
        rejectsWith('aborted'),
      );
      assert.equal(await closedWithin(server.closed), 'closed');
    } finally {
      sender.stop();
      await server.close();
    }
  });
});

describe('guardedFetch errors and options', () => {
  it('never echoes the URL, its token, the host, or an address', async () => {
    const { fetch } = harness({ 'registry.test': [['10.1.2.3']] });
    const failures: unknown[] = [];
    for (const url of [
      'https://registry.test/a.tgz?token=s3cr3t',
      'https://unknown.test/a.tgz?token=s3cr3t',
      'https://u:s3cr3t@registry.test/',
    ]) {
      failures.push(await fetch(url, LIMITS).catch((error: unknown) => error));
    }
    for (const failure of failures) {
      assert.ok(GuardedFetchErrors.is(failure));
      for (const fragment of ['s3cr3t', 'registry.test', 'unknown.test', '10.1.2.3']) {
        assert.ok(!failure.message.includes(fragment), failure.message);
      }
      assert.equal(failure.cause, undefined);
    }
  });

  it('refuses malformed options before any network use', async () => {
    const { fetch, lookups } = harness({ 'registry.test': [[PUBLIC_A]] });
    const url = 'https://registry.test/';
    for (const options of [
      { timeoutMs: 1000 },
      { maxBytes: -1, timeoutMs: 1000 },
      { maxBytes: 1, timeoutMs: 0 },
      { maxBytes: 1, timeoutMs: 1000, maxRedirects: 21 },
      { ...LIMITS, allowHosts: [''] },
      { ...LIMITS, allowHosts: 'registry.test' },
      { ...LIMITS, allowHosts: ['registry.test:443'] },
      { ...LIMITS, allowHosts: ['registry.test/path'] },
      { ...LIMITS, allowHosts: ['user@registry.test'] },
      { ...LIMITS, allowHosts: ['::1'] },
      { ...LIMITS, allowPrivate: 'yes' },
      { ...LIMITS, method: 'TRACE' },
      { ...LIMITS, body: 'x' },
      { ...LIMITS, method: 'POST', body: 42 },
      { ...LIMITS, headers: { Host: 'evil.test' } },
      { ...LIMITS, headers: { 'Transfer-Encoding': 'chunked' } },
      { ...LIMITS, headers: { 'x-a': 'line\r\nbreak' } },
      { ...LIMITS, headers: { 'bad name': 'v' } },
      { ...LIMITS, headers: { 'X-A': '1', 'x-a': '2' } },
      { ...LIMITS, signal: {} },
    ]) {
      await assert.rejects(
        fetch(url, options as unknown as GuardedFetchOptions),
        rejectsWith('invalid_options'),
        JSON.stringify(options),
      );
    }
    assert.deepEqual(lookups, []);
  });

  it('refuses a malformed transport', () => {
    for (const transport of [{ resolve: 1 }, { connect: 'x' }, { ca: [1] }]) {
      assert.throws(
        () => createGuardedFetch(transport as never),
        (error: unknown) => GuardedFetchErrors.is(error, 'invalid_options'),
      );
    }
  });
});
