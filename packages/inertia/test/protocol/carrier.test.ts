/**
 * The sealed one-shot carrier: sealing (tamper, truncation, wrong AAD, and
 * expiry read as empty; no plaintext in the cookie), the cookie attributes,
 * and when flash, errors, and `clearHistory` are consumed: once across
 * 303 -> GET -> GET, never by a 409 or a prefetch, errors but not flash by a
 * partial reload (the deferred-request race), nothing by HEAD.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AesEncrypter } from 'jsails/encryption';

import {
  defer,
  defineInertia,
  inertiaRedirect,
  InertiaError,
  resolveInertia,
  sealerFromEncrypter,
  validationFailure,
  webCryptoSealer,
  CARRIER_AAD,
  CARRIER_MAX_BYTES,
  type InertiaConfig,
  type InertiaOutcome,
} from '../../src/index.js';
import { carrierCookieName, openCarrierToken, readCarrier } from '../../src/carrier.js';
import {
  cookieAfter,
  engine,
  facts,
  header,
  inertiaHeaders,
  seeded,
  setCookies,
  TEST_KEY,
  TEST_SEALER,
  TestClock,
} from './engine-fixture.js';

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

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

async function flashRedirect(
  config: InertiaConfig,
  options: Parameters<typeof inertiaRedirect>[3],
  cookie?: string,
): Promise<InertiaOutcome> {
  return inertiaRedirect(
    config,
    facts('/save', inertiaHeaders(cookie === undefined ? {} : { Cookie: cookie }), {
      method: 'POST',
    }),
    '/done',
    options,
  );
}

function render(
  config: InertiaConfig,
  cookie: string | null,
  extra: Record<string, string> = {},
  method = 'GET',
): Promise<InertiaOutcome> {
  return resolveInertia(
    config,
    facts('/done', inertiaHeaders({ ...extra, ...(cookie === null ? {} : { Cookie: cookie }) }), {
      method,
    }),
    { component: 'Done', props: { stats: defer(() => ({ n: 1 })) } },
  );
}

function pageOf(outcome: InertiaOutcome): Extract<InertiaOutcome, { kind: 'page' }>['page'] {
  assert.ok(outcome.kind === 'page');
  return outcome.page;
}

describe('webCryptoSealer', () => {
  it('opens what it sealed under the same AAD only', async () => {
    const token = await TEST_SEALER.seal('hello', CARRIER_AAD);
    assert.match(token, /^v1\.[A-Za-z0-9_-]+$/u);
    assert.equal(await TEST_SEALER.open(token, CARRIER_AAD), 'hello');
    assert.equal(await TEST_SEALER.open(token, 'jsails-inertia-carrier:v2'), null);
    assert.equal(await webCryptoSealer(new Uint8Array(32)).open(token, CARRIER_AAD), null);
    assert.notEqual(await TEST_SEALER.seal('hello', CARRIER_AAD), token);
  });

  it('opens tampered, truncated, and malformed tokens to null (property)', async () => {
    const token = await TEST_SEALER.seal('{"v":1,"exp":1}', CARRIER_AAD);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const random = seeded(0xca77);
    for (let sample = 0; sample < 200; sample += 1) {
      const index = 3 + Math.floor(random() * (token.length - 3));
      const replacement = alphabet[Math.floor(random() * alphabet.length)] ?? 'A';
      const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
      if (tampered === token) continue;
      const opened = await TEST_SEALER.open(tampered, CARRIER_AAD);
      // A flip in the last character's padding bits can decode to the same bytes.
      if (opened !== null) assert.equal(index, token.length - 1);
    }
    for (let length = 0; length < token.length; length += 7) {
      assert.equal(await TEST_SEALER.open(token.slice(0, length), CARRIER_AAD), null);
    }
    for (const bad of [
      '',
      'v2.' + token.slice(3),
      token.replace('v1.', 'v1.!'),
      'v1.' + 'A'.repeat(20),
    ]) {
      assert.equal(await TEST_SEALER.open(bad, CARRIER_AAD), null);
    }
  });

  it('accepts only a 32-byte key or an AES-GCM CryptoKey', async () => {
    assert.throws(() => webCryptoSealer(new Uint8Array(31)), code('invalid_options'));
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const sealer = webCryptoSealer(key);
    assert.equal(await sealer.open(await sealer.seal('x', 'a'), 'a'), 'x');
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    assert.throws(() => webCryptoSealer(hmac), code('invalid_options'));
  });
});

describe('sealerFromEncrypter', () => {
  it('adapts the core AesEncrypter with AAD binding', async () => {
    const sealer = sealerFromEncrypter(new AesEncrypter({ key: TEST_KEY }));
    const token = await sealer.seal('payload', CARRIER_AAD);
    assert.equal(await sealer.open(token, CARRIER_AAD), 'payload');
    assert.equal(await sealer.open(token, 'other'), null);
    assert.equal(await sealer.open('garbage', CARRIER_AAD), null);
    assert.throws(() => sealerFromEncrypter({} as never), code('invalid_options'));
  });
});

describe('carrier cookie', () => {
  it('is HttpOnly, SameSite=Lax, Path=/, 60 s, Secure and __Host- under https', async () => {
    const config = engine();
    const secure = await flashRedirect(config, { flash: { ok: true } });
    const [cookie] = setCookies(secure);
    assert.match(
      cookie ?? '',
      /^__Host-jsails-inertia-carrier=v1\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=60$/u,
    );
    const plain = await inertiaRedirect(
      config,
      facts('/save', inertiaHeaders(), { method: 'POST', origin: 'http://localhost:3000' }),
      '/done',
      { flash: { ok: true } },
    );
    assert.match(
      setCookies(plain)[0] ?? '',
      /^jsails-inertia-carrier=v1\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60$/u,
    );
    const forced = defineInertia({ version: 'v1', carrier: { sealer: TEST_SEALER, secure: true } });
    assert.ok(forced.carrier !== null);
    assert.equal(
      carrierCookieName(forced.carrier, facts('/', {}, { origin: 'http://localhost' })),
      '__Host-jsails-inertia-carrier',
    );
  });

  it('holds no plaintext', async () => {
    const outcome = await flashRedirect(engine(), {
      flash: { message: 'secret-flash-value' },
      clearHistory: true,
    });
    const cookie = setCookies(outcome)[0] ?? '';
    for (const fragment of ['secret', 'flash', 'message', 'clearHistory', 'exp']) {
      assert.ok(!cookie.includes(fragment), fragment);
    }
  });
});

describe('carrier consumption', () => {
  it('shows flash once across 303 -> GET -> GET', async () => {
    const config = engine();
    const redirect = await flashRedirect(config, { flash: { toast: 'Saved' } });
    assert.equal(redirect.status, 303);
    const cookie = cookieAfter(redirect);
    const first = await render(config, cookie);
    assert.deepEqual(pageOf(first).flash, { toast: 'Saved' });
    assert.match(setCookies(first)[0] ?? '', /^__Host-jsails-inertia-carrier=; .*Max-Age=0$/u);
    assert.equal(header(first, 'cache-control'), 'private, no-store');
    const second = await render(config, cookieAfter(first));
    assert.equal(pageOf(second).flash, undefined);
    assert.deepEqual(setCookies(second), []);
    assert.equal(header(second, 'cache-control'), 'private');
  });

  it('carries clearHistory to the next page render', async () => {
    const config = engine();
    const redirect = await flashRedirect(config, { clearHistory: true });
    const page = pageOf(await render(config, cookieAfter(redirect)));
    assert.equal(page.clearHistory, true);
  });

  it('carries preserveFragment to the next non-partial render only', async () => {
    const config = engine();
    const redirect = await flashRedirect(config, { preserveFragment: true });
    const cookie = cookieAfter(redirect);
    const partial = await render(config, cookie, {
      'X-Inertia-Partial-Component': 'Done',
      'X-Inertia-Partial-Data': 'stats',
    });
    assert.equal(pageOf(partial).preserveFragment, undefined);
    assert.deepEqual(setCookies(partial), []);
    const page = await render(config, cookie);
    assert.equal(pageOf(page).preserveFragment, true);
    assert.equal(pageOf(await render(config, cookieAfter(page))).preserveFragment, undefined);
    await assert.rejects(
      flashRedirect(config, { preserveFragment: 'yes' as unknown as boolean }),
      code('invalid_options'),
    );
  });

  it('is not consumed by a version-mismatch 409, so flash survives the reload', async () => {
    const config = engine();
    const cookie = cookieAfter(await flashRedirect(config, { flash: { toast: 'Saved' } }));
    const stale = await render(config, cookie, { 'X-Inertia-Version': 'old' });
    assert.equal(stale.status, 409);
    assert.deepEqual(setCookies(stale), []);
    assert.deepEqual(pageOf(await render(config, cookie)).flash, { toast: 'Saved' });
  });

  it('is neither read nor consumed by a prefetch, which gets no flash', async () => {
    const config = engine();
    const cookie = cookieAfter(await flashRedirect(config, { flash: { toast: 'Saved' } }));
    const prefetch = await render(config, cookie, { Purpose: 'prefetch' });
    assert.equal(pageOf(prefetch).flash, undefined);
    assert.deepEqual(setCookies(prefetch), []);
    assert.deepEqual(pageOf(await render(config, cookie)).flash, { toast: 'Saved' });
    const renderFlash = await resolveInertia(
      config,
      facts('/', inertiaHeaders({ Purpose: 'prefetch' })),
      { component: 'Home', props: {}, flash: { now: 1 } },
    );
    assert.equal(pageOf(renderFlash).flash, undefined);
  });

  it('gives a deferred request between the 303 and the page the errors, not the flash', async () => {
    const config = engine();
    const redirect = await inertiaRedirect(
      config,
      facts('/save', inertiaHeaders(), { method: 'POST' }),
      '/done',
      { flash: { toast: 'Saved' } },
    );
    const withErrors = await validationFailure(
      config,
      facts('/save', inertiaHeaders({ Cookie: cookieAfter(redirect) ?? '' }), { method: 'POST' }),
      [{ path: ['name'], code: 'required', message: 'Required.' }],
    );
    assert.ok(withErrors !== null);
    const cookie = cookieAfter(withErrors);
    const deferred = await render(config, cookie, {
      'X-Inertia-Partial-Component': 'Done',
      'X-Inertia-Partial-Data': 'stats',
    });
    const deferredPage = pageOf(deferred);
    assert.deepEqual(deferredPage.props, { errors: { name: 'Required.' }, stats: { n: 1 } });
    assert.equal(deferredPage.flash, undefined);
    const rewritten = cookieAfter(deferred);
    assert.ok(rewritten !== null && rewritten !== cookie);
    const page = pageOf(await render(config, rewritten));
    assert.deepEqual(page.flash, { toast: 'Saved' });
    assert.deepEqual(page.props.errors, {});
  });

  it('leaves a flash-only carrier alone on a partial reload', async () => {
    const config = engine();
    const cookie = cookieAfter(await flashRedirect(config, { flash: { toast: 'Saved' } }));
    const partial = await render(config, cookie, {
      'X-Inertia-Partial-Component': 'Done',
      'X-Inertia-Partial-Data': 'stats',
    });
    assert.equal(pageOf(partial).flash, undefined);
    assert.deepEqual(setCookies(partial), []);
  });

  it('consumes nothing on HEAD', async () => {
    const config = engine();
    const cookie = cookieAfter(await flashRedirect(config, { flash: { toast: 'Saved' } }));
    const head = await render(config, cookie, {}, 'HEAD');
    assert.deepEqual(setCookies(head), []);
    assert.deepEqual(pageOf(await render(config, cookie)).flash, { toast: 'Saved' });
  });

  it('reads an expired or tampered carrier as empty and clears it', async () => {
    const clock = new TestClock();
    const config = engine(clock);
    const cookie = cookieAfter(await flashRedirect(config, { flash: { toast: 'Saved' } }));
    assert.ok(cookie !== null);
    clock.advance(60_001);
    const expired = await render(config, cookie);
    assert.equal(pageOf(expired).flash, undefined);
    assert.match(setCookies(expired)[0] ?? '', /Max-Age=0$/u);
    const tampered = await render(config, tamper(cookie, cookie.lastIndexOf('.') + 1));
    assert.equal(pageOf(tampered).flash, undefined);
    assert.match(setCookies(tampered)[0] ?? '', /Max-Age=0$/u);
  });

  it('ignores a carrier sealed under another key or a cookie of another name', async () => {
    const config = engine();
    const other = engine(undefined, {
      carrier: { sealer: webCryptoSealer(new Uint8Array(32)), oversize: 'throw' },
    });
    const foreign = cookieAfter(await flashRedirect(other, { flash: { toast: 'x' } }));
    assert.equal(pageOf(await render(config, foreign)).flash, undefined);
    const renamed = (foreign ?? '').replace('__Host-', '');
    assert.ok(config.carrier !== null);
    const read = await readCarrier(config.carrier, facts('/', { Cookie: renamed }), Date.now());
    assert.equal(read.present, false);
  });

  it('merges a redirect chain into the carrier the request holds', async () => {
    const config = engine();
    const first = cookieAfter(await flashRedirect(config, { flash: { a: 1 } }));
    const second = await flashRedirect(
      config,
      { flash: { b: 2 }, clearHistory: true },
      first ?? '',
    );
    const page = pageOf(await render(config, cookieAfter(second)));
    assert.deepEqual(page.flash, { a: 1, b: 2 });
    assert.equal(page.clearHistory, true);
  });

  it('merges render flash over carried flash', async () => {
    const config = engine();
    const cookie = cookieAfter(await flashRedirect(config, { flash: { a: 1, b: 1 } }));
    const outcome = await resolveInertia(
      config,
      facts('/', inertiaHeaders({ Cookie: cookie ?? '' })),
      { component: 'Home', props: {}, flash: { b: 2 } },
    );
    assert.deepEqual(pageOf(outcome).flash, { a: 1, b: 2 });
  });

  it('writes nothing for a prefetch redirect or an empty one', async () => {
    const config = engine();
    const prefetch = await inertiaRedirect(
      config,
      facts('/old', inertiaHeaders({ Purpose: 'prefetch' })),
      '/new',
      { flash: { moved: true } },
    );
    assert.deepEqual(setCookies(prefetch), []);
    assert.deepEqual(setCookies(await flashRedirect(config, { flash: {} })), []);
  });
});

describe('carrier policy', () => {
  it('requires a configured carrier to carry anything', async () => {
    const config = defineInertia({ version: 'v1' });
    await assert.rejects(flashRedirect(config, { flash: { a: 1 } }), code('invalid_options'));
    assert.equal((await flashRedirect(config, {})).status, 303);
  });

  it('rejects flash that is not plain JSON, with its path', async () => {
    await assert.rejects(
      flashRedirect(engine(), { flash: { when: new Date() as never } }),
      (error) =>
        code('unserializable_prop')(error) && (error as InertiaError).context.path === 'flash.when',
    );
    await assert.rejects(
      resolveInertia(engine(), facts('/'), {
        component: 'Home',
        props: {},
        flash: { n: 1n as never },
      }),
      code('unserializable_prop'),
    );
  });

  it('throws carrier_too_large over 3 KiB under the throw policy', async () => {
    await assert.rejects(
      flashRedirect(engine(), { flash: { blob: 'x'.repeat(4000) } }),
      code('carrier_too_large'),
    );
  });

  it('drops flash, keeps errors, and reports under the drop-flash policy', async () => {
    const reports: unknown[][] = [];
    const config = engine(undefined, {
      carrier: { sealer: TEST_SEALER, oversize: 'drop-flash' },
      report: (...args) => reports.push(args),
    });
    const flashOnly = await flashRedirect(config, { flash: { blob: 'x'.repeat(4000) } });
    assert.match(setCookies(flashOnly)[0] ?? '', /Max-Age=0$/u);
    const cookie = cookieAfter(await flashRedirect(config, { flash: { a: 1 } }));
    const failed = await validationFailure(
      config,
      facts('/save', inertiaHeaders({ Cookie: cookie ?? '' }), { method: 'POST' }),
      [{ path: ['name'], code: 'required', message: 'Required.' }],
    );
    assert.ok(failed !== null);
    const big = await inertiaRedirect(
      config,
      facts('/save', inertiaHeaders({ Cookie: cookieAfter(failed) ?? '' }), { method: 'POST' }),
      '/done',
      { flash: { blob: 'y'.repeat(4000) } },
    );
    const page = pageOf(await render(config, cookieAfter(big)));
    assert.equal(page.flash, undefined);
    assert.deepEqual(page.props.errors, { name: 'Required.' });
    assert.equal(reports.length, 2);
    assert.ok(
      reports.every(([error, phase]) => code('carrier_too_large')(error) && phase === 'carrier'),
    );
  });

  it('throws carrier_too_large for errors alone over 3 KiB under the throw policy', async () => {
    await assert.rejects(
      validationFailure(
        engine(),
        facts('/save', inertiaHeaders({ Referer: 'https://example.test/form' }), {
          method: 'POST',
        }),
        manyIssues(60),
      ),
      code('carrier_too_large'),
    );
  });

  it('keeps the longest leading run of error fields that fits under drop-flash, and reports once', async () => {
    const reports: unknown[][] = [];
    const config = engine(undefined, {
      carrier: { sealer: TEST_SEALER, oversize: 'drop-flash' },
      report: (...args) => reports.push(args),
    });
    const failed = await validationFailure(
      config,
      facts('/save', inertiaHeaders({ Referer: 'https://example.test/form' }), {
        method: 'POST',
      }),
      manyIssues(60),
    );
    assert.ok(failed !== null);
    assert.equal(failed.status, 303);
    assert.equal(header(failed, 'location'), '/form');
    const cookie = setCookies(failed)[0] ?? '';
    assert.ok(Buffer.byteLength(cookie.split(';', 1)[0] ?? '') <= CARRIER_MAX_BYTES);
    const errors = pageOf(await render(config, cookieAfter(failed))).props.errors;
    const kept = Object.keys(errors);
    assert.ok(kept.length > 0 && kept.length < 60);
    assert.deepEqual(
      kept,
      Array.from({ length: kept.length }, (_, index) => `items.${index}.name`),
    );
    assert.equal(reports.length, 1);
    assert.ok(code('carrier_too_large')(reports[0]?.[0]) && reports[0]?.[1] === 'carrier');
  });

  it('trims every field to its first message before dropping fields, inside a named bag', async () => {
    const config = engine(undefined, {
      carrier: { sealer: TEST_SEALER, oversize: 'drop-flash' },
      errors: { allMessages: true },
      report: () => undefined,
    });
    const issues = Array.from({ length: 8 }, (_, index) =>
      Array.from({ length: 6 }, (_, message) => ({
        path: [`field${index}`],
        code: 'invalid',
        message: `${'m'.repeat(60)} ${message}`,
      })),
    ).flat();
    const failed = await validationFailure(
      config,
      facts('/save', inertiaHeaders({ 'X-Inertia-Error-Bag': 'toString' }), { method: 'POST' }),
      issues,
    );
    assert.ok(failed !== null);
    const opened = await openCarrierToken(TEST_SEALER, tokenOf(failed), new TestClock().current);
    const bag = (opened?.errors as Record<string, Record<string, readonly string[]>>).toString;
    assert.deepEqual(
      bag,
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`field${index}`, [`${'m'.repeat(60)} 0`]]),
      ),
    );
  });

  it('drops the flash, then trims the errors, keeping the flags', async () => {
    const config = engine(undefined, {
      carrier: { sealer: TEST_SEALER, oversize: 'drop-flash' },
      report: () => undefined,
    });
    const failed = await validationFailure(
      config,
      facts('/save', inertiaHeaders(), { method: 'POST' }),
      manyIssues(60),
    );
    assert.ok(failed !== null);
    const chained = await inertiaRedirect(
      config,
      facts('/save', inertiaHeaders({ Cookie: cookieAfter(failed) ?? '' }), { method: 'POST' }),
      '/done',
      { flash: { blob: 'z'.repeat(2000) }, clearHistory: true, preserveFragment: true },
    );
    const opened = await openCarrierToken(TEST_SEALER, tokenOf(chained), new TestClock().current);
    assert.equal(opened?.flash, undefined);
    assert.equal(opened?.clearHistory, true);
    assert.equal(opened?.preserveFragment, true);
    assert.ok(Object.keys(opened?.errors ?? {}).length > 0);
  });

  it('still throws under drop-flash when not even the first error field fits', async () => {
    const config = engine(undefined, {
      carrier: { sealer: TEST_SEALER, oversize: 'drop-flash' },
      report: () => undefined,
    });
    await assert.rejects(
      validationFailure(config, facts('/save', inertiaHeaders(), { method: 'POST' }), [
        { path: ['bio'], code: 'invalid', message: 'x'.repeat(4000) },
      ]),
      code('carrier_too_large'),
    );
  });

  it('reads a payload that mixes unwrapped fields and bags as empty', async () => {
    const config = engine();
    assert.ok(config.carrier !== null);
    const now = new TestClock().current;
    const token = await TEST_SEALER.seal(
      JSON.stringify({ v: 1, exp: now + 60_000, errors: { a: 'x', bag: { b: 'y' } } }),
      CARRIER_AAD,
    );
    const read = await readCarrier(
      config.carrier,
      facts('/', { Cookie: `__Host-jsails-inertia-carrier=${token}` }),
      now,
    );
    assert.deepEqual(read, { present: true, contents: null, expiresAt: null });
  });
});

function manyIssues(count: number): { path: string[]; code: string; message: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    path: ['items', String(index), 'name'],
    code: 'required',
    message: 'The name field is required.',
  }));
}

function tokenOf(outcome: InertiaOutcome): string {
  const cookie = setCookies(outcome)[0] ?? '';
  return cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
}
