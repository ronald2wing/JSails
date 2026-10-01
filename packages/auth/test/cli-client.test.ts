/**
 * Tests for the CLI device-flow client's defences: device-code response
 * validation (interval clamping, finite expiry, same-origin http(s) URLs), the
 * per-platform browser opener that never routes a URL through cmd.exe, and the
 * login flow refusing a malformed device response instead of polling forever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { browserCommand, CliAuthError, login, parseDeviceCodeResponse } from '../src/cli-client.js';

const BASE = 'http://localhost:3000';

function deviceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: 'dev',
    user_code: 'ABCD-EFGH',
    verification_uri: `${BASE}/device`,
    verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`,
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

function isUnexpected(error: unknown): boolean {
  return error instanceof CliAuthError && error.code === 'unexpected_response';
}

describe('parseDeviceCodeResponse', () => {
  it('accepts a well-formed response', () => {
    const parsed = parseDeviceCodeResponse(deviceBody(), BASE);
    assert.equal(parsed.device_code, 'dev');
    assert.equal(parsed.interval, 5);
    assert.equal(parsed.verification_uri_complete, `${BASE}/device?user_code=ABCD-EFGH`);
  });

  it('defaults a missing interval and clamps a tiny one, so polling never busy-loops', () => {
    assert.equal(parseDeviceCodeResponse(deviceBody({ interval: undefined }), BASE).interval, 5);
    assert.equal(parseDeviceCodeResponse(deviceBody({ interval: 0 }), BASE).interval, 1);
    assert.equal(parseDeviceCodeResponse(deviceBody({ interval: 1e9 }), BASE).interval, 60);
  });

  it('rejects a missing or non-finite expiry and missing codes', () => {
    for (const overrides of [
      { expires_in: undefined },
      { expires_in: Number.NaN },
      { expires_in: -1 },
      { device_code: '' },
      { user_code: 7 },
    ]) {
      assert.throws(() => parseDeviceCodeResponse(deviceBody(overrides), BASE), isUnexpected);
    }
    assert.throws(() => parseDeviceCodeResponse('nope', BASE), isUnexpected);
  });

  it('refuses a verification URL off the app origin or outside http(s)', () => {
    for (const url of [
      'file:///etc/passwd',
      'evil-handler://run',
      'https://evil.example/device',
      'javascript:alert(1)',
    ]) {
      assert.throws(
        () => parseDeviceCodeResponse(deviceBody({ verification_uri_complete: url }), BASE),
        isUnexpected,
      );
    }
  });
});

describe('browserCommand', () => {
  it('never hands the URL to cmd.exe on Windows', () => {
    const url = `${BASE}/device?a=1&calc.exe`;
    const windows = browserCommand('win32', url);
    assert.notEqual(windows.command, 'cmd');
    assert.deepEqual(windows.args, ['url.dll,FileProtocolHandler', url]);
    assert.deepEqual(browserCommand('darwin', url), { command: 'open', args: [url] });
    assert.deepEqual(browserCommand('linux', url), { command: 'xdg-open', args: [url] });
  });
});

describe('login', () => {
  it('refuses a device response without an expiry instead of polling forever', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return Response.json(deviceBody({ expires_in: undefined, interval: undefined }));
    });
    await assert.rejects(login({ baseUrl: BASE, openBrowser: false }), isUnexpected);
    assert.equal(calls, 1);
  });
});
