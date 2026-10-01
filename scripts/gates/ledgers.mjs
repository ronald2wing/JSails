/**
 * Every expected-failure ledger in `scripts/expected-failures/` has the one
 * shape `scripts/expected-failures.mjs` documents, names files that exist, and
 * lists each test once across all ledgers.
 */
import { readLedgers } from '../expected-failures.mjs';

export const name = 'ledgers';
export const description = 'expected-failure ledgers are well formed and disjoint';
export const needsBuild = false;

export function run() {
  try {
    readLedgers();
    return [];
  } catch (error) {
    return [error.message];
  }
}
