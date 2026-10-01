/**
 * Shared fixtures for in-process app tests.
 *
 * These helpers were copied verbatim into several test files; keeping one copy
 * here means the fixture-writing rule and the test origin stay consistent.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Hono } from 'hono';

import type { AppEnv } from '../../src/server/env.js';

/** The origin every in-process app request is issued against. */
export const TEST_ORIGIN = 'http://127.0.0.1:9999';

/** Write a fixture file under `root`, creating parent directories. */
export function writeFixture(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Issue an in-process request against `app` at the shared test origin. */
export async function appRequest(
  app: Hono<AppEnv>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`${TEST_ORIGIN}${path}`, init));
}
