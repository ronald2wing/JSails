/**
 * A test file driver-matrix.test.ts runs in a process of its own, to
 * observe how the runner reports a `forEachDriver` suite limited to drivers
 * this run does not use: skipped, with the reason, and its body never run.
 */

import { it } from 'node:test';

import { forEachDriver } from '../../../src/testing/index.js';

void forEachDriver(
  'limited to the servers',
  () => {
    it('never runs on SQLite', () => {
      throw new Error('a suite limited to the servers ran on SQLite');
    });
  },
  { drivers: ['mariadb', 'postgres'], env: {} },
);
