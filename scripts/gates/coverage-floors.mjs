/**
 * `coverage-floors.json` is well formed and names only workspaces. A workspace
 * without a floor yet is allowed: `run-tests.mjs --coverage` measures and
 * reports it until `npm run coverage:floors` records one.
 */
import { readFileSync } from 'node:fs';

import { FLOORS_FILE, validateFloors } from '../coverage-floors.mjs';
import { readWorkspaces } from '../workspaces.mjs';

export const name = 'coverage-floors';
export const description = 'coverage-floors.json is well formed and names only workspaces';
export const needsBuild = false;

export function run() {
  let document;
  try {
    document = JSON.parse(readFileSync(FLOORS_FILE, 'utf8'));
  } catch (error) {
    return [`coverage-floors.json cannot be read: ${error.message}`];
  }
  return validateFloors(document, [...readWorkspaces().keys()]);
}
