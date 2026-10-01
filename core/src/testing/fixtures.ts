/**
 * Small test fixtures shared by the framework and plugin suites
 * (`jsails/testing`): a same-origin form POST, a controllable clock, a
 * temporary directory tied to a test's lifetime, a manually resolved promise,
 * and a session literal that passes every structural check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import type { Session } from '../contracts/http.js';
import type { TestApplication } from './app.js';

/** POST an `application/x-www-form-urlencoded` body with a same-origin `Origin` header. */
export function postForm(
  app: TestApplication,
  path: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A clock whose `now()` only moves when the test calls `advance`. */
export interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

/** Create a {@link FakeClock} starting at `start` epoch milliseconds. */
export function createFakeClock(start = 0): FakeClock {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** A temporary directory removed when the test (or suite) `t` finishes. */
export function tempDir(t: TestContext, prefix = 'jsails-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A promise with its `resolve` and `reject` exposed to the test. */
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** Create a {@link Deferred}. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A structurally valid session for tests; `overrides` replace any field. */
export function createTestSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    csrfToken: 'csrf-secret-token',
    data: { userId: 'u1' },
    expiresAt: 2_000_000_000_000,
    ...overrides,
  };
}
