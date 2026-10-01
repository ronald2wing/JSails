/**
 * Core's own cache doubles pass the contract conformance suites, so a test
 * that runs core code over them exercises the contract, not a looser fake.
 */

import { test } from 'node:test';

import { cacheStoreConformance, leaseStoreConformance } from '../../src/testing/index.js';
import { MapCacheStore, MapLeaseStore } from './map-cache-store.js';

function clock(): { now: () => number; advance(ms: number): Promise<void> } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: async (ms) => {
      current += ms;
    },
  };
}

for (const entry of cacheStoreConformance(async () => {
  const time = clock();
  const store = new MapCacheStore(time.now);
  return { store, advance: time.advance, close: () => store.close() };
})) {
  test(`MapCacheStore: ${entry.name}`, () => entry.run());
}

for (const entry of leaseStoreConformance(async () => {
  const time = clock();
  const store = new MapLeaseStore(time.now);
  return { store, advance: time.advance, close: () => store.close() };
})) {
  test(`MapLeaseStore: ${entry.name}`, () => entry.run());
}
