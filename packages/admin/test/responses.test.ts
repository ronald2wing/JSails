/**
 * Tests for the admin response helpers: the no-store HTML response, the 303
 * redirect, and the value-free error documents.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adminErrorResponse,
  adminForbiddenResponse,
  adminHtmlResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
} from '../src/index.js';

describe('admin responses', () => {
  it('wraps HTML in a no-store response with the given status', () => {
    const response = adminHtmlResponse('<p>x</p>', 201);
    assert.equal(response.status, 201);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('produces a 303 redirect by default', () => {
    const response = adminRedirectResponse('/somewhere');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/somewhere');
  });
});

describe('adminErrorResponse', () => {
  it('renders a titled document with the given status and message', async () => {
    const response = adminErrorResponse(409, 'Conflict', 'Managed by the configuration.');
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.match(body, /<title>Conflict<\/title>/);
    assert.match(body, /Managed by the configuration\./);
  });

  it('backs the fixed forbidden and not-found responses', async () => {
    assert.equal(adminForbiddenResponse().status, 403);
    assert.equal(adminNotFoundResponse().status, 404);
    assert.match(await adminNotFoundResponse().text(), /Not Found/);
  });
});
