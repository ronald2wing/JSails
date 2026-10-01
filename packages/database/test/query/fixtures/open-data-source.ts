/**
 * A data source over `models` on a database of its own for the run's driver:
 * the schema is pushed, then the data source is constructed (binding the
 * models). The lifecycle closes the data source, which unbinds them, before
 * the database or directory is removed.
 */

import { after } from 'node:test';

import type { DatabaseOptions } from '../../../src/engine/index.js';
import type { ModelTarget } from '../../../src/model/index.js';
import { JsailsDataSource } from '../../../src/record/index.js';
import { pushSchema } from '../../../src/schema/index.js';
import { lastInFirstOut, type MatrixLifecycle } from '../../../src/testing/index.js';
import { matrixEngineConfig } from '../../conformance/engine/fixtures/matrix-engine.js';

export async function openDataSource(
  lifecycle: MatrixLifecycle,
  models: readonly ModelTarget[],
  options: DatabaseOptions = {},
): Promise<JsailsDataSource> {
  const ordered = lastInFirstOut(lifecycle);
  const config = await matrixEngineConfig(ordered, options);
  await pushSchema({ config, models }, { environment: 'development' });
  const dataSource = new JsailsDataSource({ config, models });
  ordered.after(() => dataSource.close());
  return dataSource;
}

/**
 * A lifecycle for the suite being declared: its callbacks run, last first,
 * in one `after` registered now. node:test's `after()` called from inside a
 * running `before()` hook would not attach to the suite.
 */
export function suiteLifecycle(): MatrixLifecycle {
  const callbacks: (() => unknown)[] = [];
  after(async () => {
    for (const callback of callbacks.reverse()) await callback();
  });
  return { after: (callback) => callbacks.push(callback) };
}
