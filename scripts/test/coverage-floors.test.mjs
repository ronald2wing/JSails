/**
 * Tests for `scripts/coverage-floors.mjs`: floors written from measurements,
 * the document shape, and the repository's floors file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { FLOORS_FILE, floorFor, validateFloors, withMeasurements } from '../coverage-floors.mjs';
import { readWorkspaces } from '../workspaces.mjs';

const floor = { lines: 80, branches: 70, functions: 75 };

describe('floorFor', () => {
  it('sits one point below the measurement, rounded down, never negative', () => {
    assert.equal(floorFor(93.75), 92);
    assert.equal(floorFor(90), 89);
    assert.equal(floorFor(0.5), 0);
  });
});

describe('validateFloors', () => {
  it('accepts a floor for every workspace', () => {
    assert.deepEqual(validateFloors({ workspaces: { a: floor, b: floor } }, ['a', 'b']), []);
  });

  it('allows a workspace without a floor (a new package)', () => {
    assert.deepEqual(validateFloors({ workspaces: { a: floor } }, ['a', 'new-package']), []);
  });

  it('reports extra and malformed floors', () => {
    const errors = validateFloors(
      { workspaces: { a: { ...floor, lines: 101 }, c: { ...floor, statements: 1 } } },
      ['a', 'b'],
    );
    assert.deepEqual(errors, [
      'a: "lines" must be a percentage',
      'c: not a workspace',
      'c: unknown key "statements"',
    ]);
  });

  it('rejects a document without workspaces', () => {
    assert.equal(validateFloors({}, ['a']).length, 1);
  });
});

describe('withMeasurements', () => {
  it('replaces measured workspaces, keeps the rest, and sorts by name', () => {
    const next = withMeasurements({ workspaces: { z: floor, a: floor } }, [
      { workspace: 'a', lines: 95.2, branches: 88.9, functions: 90 },
    ]);
    assert.deepEqual(Object.keys(next.workspaces), ['a', 'z']);
    assert.deepEqual(next.workspaces.a, { lines: 94, branches: 87, functions: 89 });
    assert.deepEqual(next.workspaces.z, floor);
  });
});

describe('coverage-floors.json', () => {
  it('is valid, and every workspace that exists today has a floor', () => {
    const document = JSON.parse(readFileSync(FLOORS_FILE, 'utf8'));
    const names = [...readWorkspaces().keys()];
    assert.deepEqual(validateFloors(document, names), []);
    // Floors are recorded for the packages that existed when they were
    // measured; a package created later is reported until it gets one.
    for (const name of ['jsails', '@jsails/admin', '@jsails/live']) {
      assert.ok(document.workspaces[name], `${name} has a floor`);
    }
  });
});
