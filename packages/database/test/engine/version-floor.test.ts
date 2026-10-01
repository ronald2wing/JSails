/**
 * The supported server floors, on the version strings each server reports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VERSION_FLOORS } from '../../src/engine/index.js';
import { assertVersionFloor } from '../../src/engine/version-floor.js';

describe('assertVersionFloor', () => {
  it('accepts the floors and newer', () => {
    assertVersionFloor('mariadb', '11.4.13-MariaDB-ubu2404');
    assertVersionFloor('mariadb', '10.6.0-MariaDB');
    assertVersionFloor('postgres', '17.12 (Debian 17.12-1.pgdg13+1)');
    assertVersionFloor('postgres', '14.0');
    assertVersionFloor('sqlite', '3.54.1');
    assert.deepEqual(VERSION_FLOORS.mariadb, [10, 6]);
  });

  it('refuses servers below the floor', () => {
    assert.throws(() => assertVersionFloor('mariadb', '10.5.27-MariaDB'), {
      code: 'unsupported_version',
    });
    assert.throws(() => assertVersionFloor('postgres', '13.16'), { code: 'unsupported_version' });
    assert.throws(() => assertVersionFloor('sqlite', '3.34.1'), { code: 'unsupported_version' });
    assert.throws(() => assertVersionFloor('postgres', 'garbage'), { code: 'unsupported_version' });
  });

  it('refuses MySQL on the MariaDB dialect, whatever its version', () => {
    assert.throws(() => assertVersionFloor('mariadb', '8.4.3'), { code: 'unsupported_server' });
  });
});
