/**
 * The `proxy-client-keys` stage: the generated admin app, served the way
 * `jamal deploy` runs it behind kamal-proxy, keys its rate limits per client.
 *
 * `jamal deploy` gives the web container `JSAILS_TRUSTED_PROXIES=hops=<n>`
 * for the proxies it puts in front of it (one, kamal-proxy, by default), and
 * the starters state no `server.trustedProxies` of their own, so that count
 * decides whose address a request comes from. The stage proves it end to end
 * on the built fixture:
 *
 * - A simulated kamal-proxy (an HTTP forwarder in this process) stands in
 *   front of `jsails serve`. Like kamal-proxy without `--forward-headers` it
 *   replaces whatever `X-Forwarded-For` a client sent with the address it
 *   received the connection from, and forwards the `Host` unchanged.
 * - Two clients connect to it from distinct loopback addresses (127.0.0.2 and
 *   127.0.0.3 on Linux, where all of 127/8 is local; 127.0.0.1 and ::1
 *   elsewhere). Client A sends failed logins for one email until the
 *   starter's limiter answers 429 (10 per route, email, and client); client B
 *   then tries the same email and must not be throttled: its own bucket.
 * - Negative control: the same run without the variable (the app's default
 *   `'none'`) keys both clients on the proxy's address, so client B is
 *   throttled by A's attempts. Without it the stage could pass by accident.
 *
 * The app runs as `test` with no reachable database: every allowed login
 * fails fast on a refused connection (a redirect to the login page), and the
 * limiter counts each attempt before the credentials are checked, so the
 * stage needs neither MariaDB nor a browser.
 */
import { createServer, request as httpRequest } from 'node:http';

import { BETTER_AUTH_SECRET } from './database.mjs';
import { installedCli } from './fixtures.mjs';
import { findFreePort, spawnServer } from './processes.mjs';

/** The public origin the fixture is served at; both clients address it. */
const PUBLIC_ORIGIN = 'http://app.verify.test';

/** The starter limiter's attempts per route, email, and client in one window. */
const LOGIN_LIMIT = 10;

/** Two client addresses this machine can connect from, and the family to use. */
const CLIENTS =
  process.platform === 'linux'
    ? [
        { name: 'A', localAddress: '127.0.0.2', family: 4 },
        { name: 'B', localAddress: '127.0.0.3', family: 4 },
      ]
    : [
        { name: 'A', localAddress: '127.0.0.1', family: 4 },
        { name: 'B', localAddress: '::1', family: 6 },
      ];

/** The address a socket peer is written as in `X-Forwarded-For`. */
function forwardedAddress(remoteAddress) {
  return remoteAddress?.startsWith('::ffff:') ? remoteAddress.slice(7) : (remoteAddress ?? '');
}

/**
 * Starts the simulated kamal-proxy in front of `target` (the served app's
 * URL) and resolves `{ port, close }`. It listens on every loopback family so
 * both clients reach it.
 */
function startSimulatedProxy(target) {
  const upstream = new URL(target);
  const proxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    delete headers.forwarded;
    delete headers['x-real-ip'];
    headers['x-forwarded-for'] = forwardedAddress(incoming.socket.remoteAddress);
    headers['x-forwarded-proto'] = 'http';
    const forwarded = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  return new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '::', () => {
      resolve({
        port: proxy.address().port,
        close: () => new Promise((done) => proxy.close(() => done())),
      });
    });
  });
}

/** One failed login from `client` through the proxy; resolves the status code. */
function attemptLogin(proxyPort, client, email) {
  const body = new URLSearchParams({ email, password: 'not-the-password' }).toString();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: client.family === 6 ? '::1' : '127.0.0.1',
        family: client.family,
        localAddress: client.localAddress,
        port: proxyPort,
        method: 'POST',
        path: '/api/login',
        headers: {
          host: new URL(PUBLIC_ORIGIN).host,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          // A forged chain, which the proxy must replace and the app never read.
          'x-forwarded-for': '203.0.113.66',
          connection: 'close',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/**
 * Serves the fixture with `extraEnv`, puts the simulated proxy in front of it,
 * spends client A's attempts, and resolves the status of A's next attempt and
 * of client B's first.
 */
async function measureBuckets(fixtureDir, extraEnv, label) {
  const closedPort = await findFreePort();
  const served = await spawnServer({
    cmd: process.execPath,
    args: [installedCli(fixtureDir), 'serve', '--config', 'jsails.app.js'],
    cwd: fixtureDir,
    env: {
      PORT: '0',
      JSAILS_ENV: 'test',
      NODE_ENV: 'test',
      PUBLIC_ORIGIN,
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: PUBLIC_ORIGIN,
      // Nothing listens here, so every allowed attempt fails fast.
      DATABASE_TYPE: 'mariadb',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: String(closedPort),
      DATABASE_USER: 'verify',
      DATABASE_PASSWORD: 'verify',
      DATABASE_NAME: 'verify',
      JSAILS_TRUSTED_PROXIES: null,
      ...extraEnv,
    },
    match: /Serving at (https?:\/\/\S+)/,
    label,
  });
  const proxy = await startSimulatedProxy(served.url);
  try {
    const [clientA, clientB] = CLIENTS;
    const email = `bucket-${Date.now().toString(36)}@example.com`;
    for (let attempt = 1; attempt <= LOGIN_LIMIT; attempt += 1) {
      const status = await attemptLogin(proxy.port, clientA, email);
      if (status === 429 || status >= 500) {
        throw new Error(`${label}: client A attempt ${attempt} answered ${status}`);
      }
    }
    const aAfter = await attemptLogin(proxy.port, clientA, email);
    const bFirst = await attemptLogin(proxy.port, clientB, email);
    return { aAfter, bFirst };
  } finally {
    await proxy.close();
    await served.stop();
  }
}

/** Runs the stage against the built admin fixture; resolves its summary line. */
export async function runProxyClientKeysStage(fixtureDir) {
  const trusted = await measureBuckets(
    fixtureDir,
    { JSAILS_TRUSTED_PROXIES: 'hops=1' },
    'jsails serve behind one proxy (hops=1)',
  );
  if (trusted.aAfter !== 429) {
    throw new Error(
      `behind one trusted proxy, client A's 11th attempt answered ${trusted.aAfter}, not 429`,
    );
  }
  if (trusted.bFirst === 429) {
    throw new Error("behind one trusted proxy, client B shared client A's exhausted bucket");
  }

  const untrusted = await measureBuckets(fixtureDir, {}, "jsails serve behind one proxy ('none')");
  if (untrusted.aAfter !== 429 || untrusted.bFirst !== 429) {
    throw new Error(
      `negative control: with no trusted proxy both clients must share the proxy's bucket ` +
        `(A ${untrusted.aAfter}, B ${untrusted.bFirst})`,
    );
  }
  return (
    `behind a simulated kamal-proxy with JSAILS_TRUSTED_PROXIES=hops=1, client A was throttled ` +
    `after ${LOGIN_LIMIT} attempts (429) while client B kept its own bucket (${trusted.bFirst}); ` +
    `without it both shared the proxy's bucket (B ${untrusted.bFirst})`
  );
}
