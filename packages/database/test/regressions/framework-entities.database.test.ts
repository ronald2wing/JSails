/**
 * Audit findings "JsailsFailedJob and DatabasePluginState declare
 * `type: 'datetime'`, which TypeORM rejects on the documented postgres
 * driver" and "@jsails/sessions, @jsails/flags and @jsails/config entities
 * cannot be used on PostgreSQL", widened by the critic to every framework and
 * package entity: nothing built the metadata of every entity on every driver,
 * so the break shipped. Each entity list below gets its tables created on the
 * run's driver; a guard keeps the lists complete against the source tree.
 * DAT-03 makes ModelSpec the only declaration, and DAT-13/DAT-14 port the
 * stores onto it.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { activeStorageEntities } from 'jsails/database';
import { failedJobEntities } from 'jsails/jobs';
import { pluginStateEntities } from 'jsails/plugins';
import { blogPlugin } from '@jsails/blog';
import { configEntities } from '@jsails/config';
import { flagsEntities } from '@jsails/flags';
import { mediaEntities } from '@jsails/media';
import { notificationEntities } from '@jsails/notifications';
import { sessionEntities } from '@jsails/sessions';
import { tenancyEntities } from '@jsails/tenancy';

import { openMatrixDataSource } from '../../src/testing/index.js';

const ENTITY_LISTS: readonly (readonly [string, readonly Function[]])[] = [
  ['jsails/database active storage', activeStorageEntities],
  ['jsails/jobs failed jobs', failedJobEntities],
  ['jsails/plugins plugin state', pluginStateEntities],
  ['@jsails/blog', blogPlugin().schema?.entities ?? []],
  ['@jsails/config', configEntities],
  ['@jsails/flags', flagsEntities],
  ['@jsails/media', mediaEntities],
  ['@jsails/notifications', notificationEntities],
  ['@jsails/sessions', sessionEntities],
  ['@jsails/tenancy', tenancyEntities],
];

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Every `.ts` file under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The class names of every `@Entity(...)`-decorated class in core and the packages. */
function declaredEntityClasses(): string[] {
  const packagesDir = join(repoRoot, 'packages');
  const sourceDirs = [
    join(repoRoot, 'core', 'src'),
    ...readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesDir, entry.name, 'src'))
      .filter((dir) => existsSync(dir)),
  ];
  const names: string[] = [];
  for (const file of sourceDirs.flatMap((dir) => sourceFiles(dir))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^@Entity\(.*?^export\s+class\s+(\w+)/gms)) {
      names.push(match[1] as string);
    }
  }
  return names.sort();
}

describe('framework and package entities', () => {
  it('the lists below cover every @Entity class in core and the packages', () => {
    const covered = ENTITY_LISTS.flatMap(([, entities]) => entities.map((entity) => entity.name));
    assert.deepEqual([...covered].sort(), declaredEntityClasses());
  });

  for (const [label, entities] of ENTITY_LISTS) {
    it(`${label}: tables are created on this driver`, async (t) => {
      const dataSource = await openMatrixDataSource(t, { entities });

      const live = await dataSource.getLiveSchema();
      const expected = entities.map((entity) => dataSource.getMetadata(entity).tableName);
      for (const table of expected) {
        assert.ok(
          live.tables.some((candidate) => candidate.name === table),
          `table ${table} was not created`,
        );
      }
    });
  }
});
