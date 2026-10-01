/**
 * Tests for the Varnish cache-proxy argv builders, VCL resolution, validation,
 * the X-Forwarded-For the app receives through the cache proxy, and executors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CacheProxyError,
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_IMAGE_DEFAULT,
  CACHE_PROXY_PORT_DEFAULT,
  CACHE_PROXY_SIZE_DEFAULT,
  CACHE_PROXY_CONTAINER_VCL_DIR,
  CACHE_PROXY_HOST_VCL_FILE,
  CACHE_PROXY_VCL_DIRECTORY_MODE,
  CACHE_PROXY_VCL_MODE,
  DEFAULT_VCL,
  cacheProxyBoot,
  cacheProxyBootArgv,
  cacheProxyHealthArgv,
  cacheProxyListArgv,
  cacheProxyStatus,
  cacheProxyStatusArgv,
  resolveVcl,
} from '../../src/production/cache-proxy.js';
import { HostHomeErrors } from '../../src/production/host-home.js';
import type { CommandResult } from '../../src/production/process-runner.js';
import { decodeRemoteOp } from '../../src/production/remote-op.js';
import type { RemoteRunner } from '../../src/production/transport.js';

/**
 * Tests for the Varnish cache-proxy accessory. The pure argv builders are
 * asserted directly (exact argv shapes and validation), the default VCL
 * constant is checked for the required pass-guards, and the executors run
 * against a recording fake {@link RemoteRunner} so no ssh or docker command
 * is ever spawned.
 */

interface RecordedCall {
  server: string;
  remoteArgv: string[];
}

function makeRemote(script: (server: string, remoteArgv: string[]) => CommandResult): {
  remote: RemoteRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return script(server, [...remoteArgv]);
    },
  };
  return { remote, calls };
}

const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

/** The ssh user's home the tests' server reports. */
const HOME = '/home/deploy';

/** Answer the `host.home` op as a server whose home is {@link HOME}, else `other`. */
function serverWithHome(other: CommandResult): (server: string, argv: string[]) => CommandResult {
  return (_server, argv) =>
    decodeRemoteOp(argv)?.kind === 'host.home'
      ? { exitCode: 0, stdout: `${HOME}\n`, stderr: '' }
      : other;
}

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CacheProxyError, `expected CacheProxyError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a CacheProxyError, but nothing was thrown');
}

describe('cacheProxyBootArgv: argv shape', () => {
  it('emits the default boot argv', () => {
    assert.deepEqual(cacheProxyBootArgv({ home: HOME }), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      CACHE_PROXY_CONTAINER_NAME,
      '--network',
      'jamal',
      '-e',
      `VARNISH_SIZE=${CACHE_PROXY_SIZE_DEFAULT}`,
      '-e',
      `VARNISH_HTTP_PORT=${CACHE_PROXY_PORT_DEFAULT}`,
      '-p',
      `127.0.0.1:${CACHE_PROXY_PORT_DEFAULT}:${CACHE_PROXY_PORT_DEFAULT}`,
      '-v',
      '/home/deploy/.jamal/cache-proxy:/etc/varnish:ro',
      CACHE_PROXY_IMAGE_DEFAULT,
    ]);
  });

  it('honors a custom image and size', () => {
    assert.deepEqual(cacheProxyBootArgv({ home: HOME, image: 'varnish:7.6', size: '512m' }), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      CACHE_PROXY_CONTAINER_NAME,
      '--network',
      'jamal',
      '-e',
      'VARNISH_SIZE=512m',
      '-e',
      `VARNISH_HTTP_PORT=${CACHE_PROXY_PORT_DEFAULT}`,
      '-p',
      `127.0.0.1:${CACHE_PROXY_PORT_DEFAULT}:${CACHE_PROXY_PORT_DEFAULT}`,
      '-v',
      '/home/deploy/.jamal/cache-proxy:/etc/varnish:ro',
      'varnish:7.6',
    ]);
  });

  it('mounts the VCL directory by absolute path, which every Docker version binds', () => {
    // A `./` source is a named volume to a CLI before Docker 23.
    const argv = cacheProxyBootArgv({ home: '/' });
    assert.equal(argv[argv.indexOf('-v') + 1], '/.jamal/cache-proxy:/etc/varnish:ro');
  });

  it('exposes the documented default constants', () => {
    assert.match(CACHE_PROXY_IMAGE_DEFAULT, /^varnish@sha256:[0-9a-f]{64}$/);
    assert.equal(CACHE_PROXY_SIZE_DEFAULT, '256m');
    assert.equal(CACHE_PROXY_PORT_DEFAULT, 6081);
    assert.equal(CACHE_PROXY_CONTAINER_NAME, 'jamal-cache-proxy');
  });
});

describe('the VCL file on the host', () => {
  it('lives in a directory of its own that Varnish mounts read-only, so a rename reaches it', () => {
    assert.equal(CACHE_PROXY_HOST_VCL_FILE, '.jamal/cache-proxy/default.vcl');
    assert.equal(CACHE_PROXY_CONTAINER_VCL_DIR, '/etc/varnish');
    // Varnish runs as its own user, so it must be able to read the file.
    assert.equal(CACHE_PROXY_VCL_MODE, 0o644);
    assert.equal(CACHE_PROXY_VCL_DIRECTORY_MODE, 0o755);
  });
});

describe('cacheProxyStatusArgv / cacheProxyListArgv / cacheProxyHealthArgv', () => {
  it('queries status with docker inspect', () => {
    assert.deepEqual(cacheProxyStatusArgv(), ['docker', 'inspect', CACHE_PROXY_CONTAINER_NAME]);
  });

  it('lists containers filtered by name', () => {
    assert.deepEqual(cacheProxyListArgv(), [
      'docker',
      'ps',
      '--filter',
      `name=${CACHE_PROXY_CONTAINER_NAME}`,
    ]);
  });

  it('health-checks with varnishlog', () => {
    assert.deepEqual(cacheProxyHealthArgv(), [
      'docker',
      'exec',
      CACHE_PROXY_CONTAINER_NAME,
      'varnishlog',
      '-c',
      '-n',
      '/tmp',
    ]);
  });
});

describe('cacheProxy validation: value-free errors', () => {
  it('rejects a whitespace image name', () => {
    const error = capture(() => cacheProxyBootArgv({ home: HOME, image: 'has space' }));
    assert.match(error.message, /must not contain whitespace/);
    assert.ok(!error.message.includes('has space'), 'the rejected value must not leak');
  });

  it('rejects an empty image name', () => {
    const error = capture(() => cacheProxyBootArgv({ home: HOME, image: '' }));
    assert.match(error.message, /must be a non-empty string/);
  });

  it('rejects an image starting with "-"', () => {
    const error = capture(() => cacheProxyBootArgv({ home: HOME, image: '-bad' }));
    assert.match(error.message, /must not start with/);
  });

  it('rejects a control character in the image name', () => {
    const error = capture(() => cacheProxyBootArgv({ home: HOME, image: 'img\u0001' }));
    assert.match(error.message, /must not contain whitespace or control characters/);
  });
});

describe('resolveVcl: backend host and port replacement', () => {
  it('replaces the placeholder host and port', () => {
    const vcl = resolveVcl('myapp-web-abc123', 3000);
    assert.ok(!vcl.includes('__BACKEND_HOST__'), 'placeholder must be replaced');
    assert.ok(!vcl.includes('__BACKEND_PORT__'), 'placeholder must be replaced');
    assert.ok(vcl.includes('.host = "myapp-web-abc123"'));
    assert.ok(vcl.includes('.port = "3000"'));
  });

  it('defaults the port to 3000', () => {
    const vcl = resolveVcl('myapp-web-xyz');
    assert.ok(vcl.includes('.port = "3000"'));
  });

  it('rejects an empty host', () => {
    const error = capture(() => resolveVcl('', 3000));
    assert.match(error.message, /must be a non-empty string/);
  });

  it('rejects a port of 0 or 65536', () => {
    const error = capture(() => resolveVcl('app', 0));
    assert.match(error.message, /must be an integer between 1/);

    const error2 = capture(() => resolveVcl('app', 65536));
    assert.match(error2.message, /must be an integer between 1/);
  });
});

describe('resolveVcl: cookie allowlist', () => {
  it('keeps the pass-on-any-cookie block when no allowlist is given', () => {
    const vcl = resolveVcl('app', 3000);
    assert.ok(vcl.includes('  if (req.http.Cookie) {'));
    assert.ok(vcl.includes('    return (pass);'));
    assert.ok(!vcl.includes('regsuball'), 'no allowlist means no regsuball stripping');
  });

  it('keeps the pass-on-any-cookie block when the allowlist is empty', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: [] });
    assert.ok(!vcl.includes('regsuball'), 'an empty allowlist is the default policy');
  });

  it('replaces the pass block with allowlist stripping when names are given', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['session_id'] });
    assert.ok(!vcl.includes('  if (req.http.Cookie) {\n    return (pass);\n  }'));
    assert.ok(
      vcl.includes('regsuball(req.http.Cookie, "(^|; *)session_id=[^;]*", "")'),
      'must strip the allowlisted cookie',
    );
    assert.ok(vcl.includes('if (req.http.Cookie ~ "^[; ]*$")'), 'must detect "no cookies left"');
    assert.ok(vcl.includes('unset req.http.Cookie;'), 'must unset when only separators remain');
    assert.ok(vcl.includes('return (pass);'), 'must pass when another cookie remains');
  });

  it('strips multiple allowlisted names in order', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['a', 'b'] });
    const aIndex = vcl.indexOf('regsuball(req.http.Cookie, "(^|; *)a=[^;]*", "")');
    const bIndex = vcl.indexOf('regsuball(req.http.Cookie, "(^|; *)b=[^;]*", "")');
    assert.ok(aIndex >= 0 && bIndex >= 0, 'both names must be stripped');
    assert.ok(aIndex < bIndex, 'names strip in declaration order');
  });

  it('escapes regex metacharacters in a cookie name', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['__utm*'] });
    assert.ok(
      vcl.includes('regsuball(req.http.Cookie, "(^|; *)__utm\\*=[^;]*", "")'),
      'the "*" must be escaped so the name matches literally',
    );
  });

  it('rejects an empty allowlist entry', () => {
    const error = capture(() => resolveVcl('app', 3000, { cookieAllowlist: [''] }));
    assert.match(error.message, /non-empty/);
  });

  it('rejects a whitespace allowlist entry', () => {
    const error = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['has space'] }));
    assert.match(error.message, /whitespace or control/);
    assert.ok(!error.message.includes('has space'), 'the rejected value must not leak');
  });

  it('rejects a quote or backslash in an allowlist entry', () => {
    const quote = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['a"b'] }));
    assert.match(quote.message, /quotes or backslashes/);

    const backslash = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['a\\b'] }));
    assert.match(backslash.message, /quotes or backslashes/);
  });
});

describe('DEFAULT_VCL: required pass-guards and cache policy', () => {
  it('contains a pass for non-GET/HEAD methods', () => {
    assert.ok(
      DEFAULT_VCL.includes('req.method != "GET"') &&
        DEFAULT_VCL.includes('req.method != "HEAD"') &&
        DEFAULT_VCL.includes('return (pass)'),
      'must pass non-GET/HEAD requests',
    );
  });

  it('contains a pass for /_jsails/ paths', () => {
    assert.ok(
      DEFAULT_VCL.includes('^/_jsails/') && DEFAULT_VCL.includes('return (pass)'),
      'must pass JSails internal paths',
    );
  });

  it('contains a pass for Cookie-bearing requests', () => {
    assert.ok(
      DEFAULT_VCL.includes('req.http.Cookie') && DEFAULT_VCL.includes('return (pass)'),
      'must pass requests with cookies',
    );
  });

  it('strips cookies for cacheable requests', () => {
    assert.ok(
      DEFAULT_VCL.includes('unset req.http.Cookie'),
      'must strip cookies from cacheable requests',
    );
  });

  it('default-denies caching in vcl_backend_response', () => {
    assert.ok(DEFAULT_VCL.includes('set beresp.uncacheable = true'), 'must default to uncacheable');
  });

  it('never stores a response with Set-Cookie', () => {
    assert.ok(
      DEFAULT_VCL.includes('beresp.http.Set-Cookie') &&
        DEFAULT_VCL.includes('set beresp.uncacheable = true'),
      'must not store Set-Cookie responses',
    );
  });

  it('sets beresp.grace', () => {
    assert.ok(DEFAULT_VCL.includes('set beresp.grace = 1h'), 'must set grace period');
  });

  it('checks Surrogate-Control and Cache-Control', () => {
    assert.ok(
      DEFAULT_VCL.includes('beresp.http.Surrogate-Control'),
      'must check Surrogate-Control',
    );
    assert.ok(DEFAULT_VCL.includes('beresp.http.Cache-Control'), 'must check Cache-Control');
  });

  it('sets X-Cache HIT/MISS headers in vcl_deliver', () => {
    assert.ok(
      DEFAULT_VCL.includes('X-Cache') &&
        DEFAULT_VCL.includes('"HIT"') &&
        DEFAULT_VCL.includes('"MISS"'),
      'must set X-Cache debug header',
    );
  });
});

describe('DEFAULT_VCL: the X-Forwarded-For the app receives', () => {
  /** The address Varnish receives from: kamal-proxy, on the shared network. */
  const KAMAL = '172.18.0.3';

  /**
   * The header Varnish sends the app for a request that `arrived` with this
   * X-Forwarded-For (or none): Varnish itself appends the address it received
   * the request from, creating the header, then `vcl_backend_fetch` runs.
   */
  function towardApp(arrived: string | undefined): string | undefined {
    const appended = arrived === undefined ? KAMAL : `${arrived}, ${KAMAL}`;
    const fetch = /\nsub vcl_backend_fetch \{\n([\s\S]*?)\n\}\n/.exec(DEFAULT_VCL)?.[1] ?? '';
    const rule =
      /^ {2}if \(bereq\.http\.X-Forwarded-For !~ "([^"]*)"\) \{\n {4}unset bereq\.http\.X-Forwarded-For;\n {2}\}$/.exec(
        fetch,
      );
    assert.ok(rule?.[1] !== undefined, 'vcl_backend_fetch drops a lone X-Forwarded-For entry');
    return new RegExp(rule[1]).test(appended) ? appended : undefined;
  }

  it("sends kamal-proxy's health check, which carries no header, without one", () => {
    // The app then sees a direct request from the cache proxy, not a chain
    // one entry shorter than the two hops it trusts.
    assert.equal(towardApp(undefined), undefined);
  });

  it('keeps the chain of a request kamal-proxy relayed: the client, then kamal-proxy', () => {
    // Two entries: the app's two hops name the client.
    assert.equal(towardApp('203.0.113.7'), `203.0.113.7, ${KAMAL}`);
    assert.equal(towardApp('2001:db8::7'), `2001:db8::7, ${KAMAL}`);
    assert.equal(towardApp('198.51.100.1, 173.245.48.9'), `198.51.100.1, 173.245.48.9, ${KAMAL}`);
  });

  it('keeps the rule in the VCL a deploy writes, with or without a cookie allowlist', () => {
    for (const vcl of [
      resolveVcl('myapp-web-1', 3000),
      resolveVcl('myapp-web-1', 3000, { cookieAllowlist: ['theme'] }),
    ]) {
      assert.ok(vcl.includes('sub vcl_backend_fetch {'));
      assert.ok(vcl.includes('unset bereq.http.X-Forwarded-For;'));
    }
  });
});

describe('cacheProxyBoot: executor', () => {
  it('reads the server home, then boots the container mounting the VCL below it', async () => {
    const { remote, calls } = makeRemote(serverWithHome(ok));
    await cacheProxyBoot(remote, '1.2.3.4', {});

    assert.equal(calls.length, 2);
    assert.deepEqual(decodeRemoteOp(calls[0]!.remoteArgv), { kind: 'host.home' });
    assert.equal(calls[1]!.server, '1.2.3.4');
    assert.deepEqual(calls[1]!.remoteArgv, cacheProxyBootArgv({ home: HOME }));
  });

  it('boots nothing when the server home cannot be mounted from', async () => {
    const { remote, calls } = makeRemote((_server, argv) =>
      decodeRemoteOp(argv)?.kind === 'host.home'
        ? { exitCode: 0, stdout: 'Welcome!\n/home/deploy\n', stderr: '' }
        : ok,
    );
    await assert.rejects(
      () => cacheProxyBoot(remote, '1.2.3.4', {}),
      (error: unknown) => HostHomeErrors.is(error, 'unusable_home'),
    );
    assert.equal(calls.length, 1);
  });

  it('throws a value-free CacheProxyError on non-zero exit', async () => {
    const errorExit: CommandResult = { exitCode: 1, stdout: '', stderr: 'sensitive output' };
    const { remote } = makeRemote(serverWithHome(errorExit));

    await assert.rejects(
      () => cacheProxyBoot(remote, '1.2.3.4', {}),
      (error: unknown) => {
        assert.ok(error instanceof CacheProxyError);
        const message = error.message;
        assert.match(message, /cache-proxy boot/);
        assert.ok(!message.includes('sensitive output'), 'error must be value-free');
        return true;
      },
    );
  });
});

describe('cacheProxyStatus: executor', () => {
  it('resolves true on exit zero', async () => {
    const { remote } = makeRemote(() => ok);
    const present = await cacheProxyStatus(remote, '1.2.3.4');
    assert.equal(present, true);
  });

  it('resolves false on non-zero exit without throwing', async () => {
    const errorExit: CommandResult = { exitCode: 1, stdout: '', stderr: '' };
    const { remote } = makeRemote(() => errorExit);
    const present = await cacheProxyStatus(remote, '1.2.3.4');
    assert.equal(present, false);
  });
});
