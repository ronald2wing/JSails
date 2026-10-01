/**
 * Audit finding "every app model with a Date field fails on Postgres" (the
 * critic's widening of "JsailsFailedJob and DatabasePluginState declare
 * `type: 'datetime'`, which TypeORM rejects on the documented postgres
 * driver"), on every driver. `ModelColumnType` names the MySQL/SQLite type
 * `datetime`, and defineModel lowers it verbatim, before the driver is known.
 *
 * The second test states DAT-03's fidelity rule for timestamps: a Date is read
 * back equal to the millisecond. MariaDB's `DATETIME` without a precision
 * keeps whole seconds.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { BaseEntity } from 'typeorm';

import { defineModel } from '../../../src/models/define-model.js';
import { clearModelRegistry } from '../../../src/models/model-registry.js';
import { openMatrixDataSource } from './matrix-database.js';

class Appointment extends BaseEntity {
  declare id: number;
  declare starts_at: Date;
}

defineModel(Appointment, {
  table: 'regression_appointments',
  primaryKey: { name: 'id', kind: 'integer' },
  columns: [{ name: 'starts_at', type: 'datetime', nullable: false }],
  relations: [],
});
// defineModel registers into a process-wide registry that every later data
// source harvests; this file owns this model, so it clears it at the end.
after(() => clearModelRegistry());

describe('a model with a datetime column', () => {
  it('builds its metadata and table on this driver', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Appointment] });

    assert.equal(dataSource.getMetadata(Appointment).tableName, 'regression_appointments');
  });

  it('reads back the Date it wrote, to the millisecond', async (t) => {
    await openMatrixDataSource(t, { entities: [Appointment] });
    const startsAt = new Date('2026-03-04T05:06:07.089Z');

    const saved = await Appointment.create({ starts_at: startsAt }).save();
    const loaded = await Appointment.findOneByOrFail({ id: saved.id });

    // The message carries both values, so the ledger can pin today's failure
    // (the milliseconds dropped) and reject any other change, a shifted
    // timezone among them.
    assert.equal(
      loaded.starts_at.toISOString(),
      startsAt.toISOString(),
      `the Date came back as ${loaded.starts_at.toISOString()}, not ${startsAt.toISOString()}`,
    );
  });
});
