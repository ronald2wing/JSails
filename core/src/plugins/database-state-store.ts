/**
 * Database-backed plugin state.
 *
 * {@link createDatabasePluginStateStore} persists plugin state in the
 * framework-owned `jsails_plugin_state` table through the injected TypeORM
 * `DataSource`'s repository — no raw SQL and no runtime DDL. The table must
 * already exist (checked once per store; a positive result is cached): an app
 * includes {@link pluginStateEntities} in its
 * `JsailsDataSource` entities and creates the table through the normal
 * declarative schema history (`db:push`). A missing table fails with a clear,
 * value-free {@link PluginStateError} telling the caller to run those commands;
 * the store never creates it. `load`/`save` map table rows to and from a
 * {@link PluginState}, validating every id and active version value-free: an id
 * that does not match {@link PLUGIN_ID_PATTERN} or a version that is not valid
 * semver is rejected without ever echoing the value. Every write is per row:
 * `putEntry` updates or inserts one id's row, `removeEntry` deletes one id's
 * rows, and `save` updates or inserts the rows of the ids it carries inside one
 * transaction. No write deletes a row for an id it was not given: the caller's
 * snapshot may predate another process's install, and a whole-document
 * replace would silently undo it. Nothing ever truncates (`TRUNCATE` commits
 * implicitly on MySQL/MariaDB). The table has no unique key on `pluginId`, so
 * a reader takes the lowest primary key for an id and a write for an id
 * deletes any later duplicate rows of that id. A data source that is not
 * initialized fails with a clear {@link PluginStateError} before any
 * repository query runs.
 */

import { In, type DataSource, type Repository } from 'typeorm';

import { PLUGIN_ID_PATTERN } from './manifest/plugin-id.js';
import { isValidSemverVersion } from './manifest/semver.js';
import {
  PluginStateError,
  PLUGIN_STATE_VERSION,
  pluginStateSchema,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
} from './state-store.js';
import {
  ACTIVE_VERSION_COLUMN_LENGTH,
  PLUGIN_ID_COLUMN_LENGTH,
  PLUGIN_STATE_TABLE,
  DatabasePluginState,
} from './database-state-entity.js';

/** Options for {@link createDatabasePluginStateStore}. */
export interface DatabasePluginStateStoreOptions {
  /** A TypeORM data source backing plugin state. */
  readonly dataSource?: DataSource;
  /**
   * Resolve the data source lazily on first use. Preferred for app configs:
   * constructing the source reads DATABASE_* but connecting waits for the first
   * managed state read/write, so static export never opens a connection.
   */
  readonly getDataSource?: () => DataSource;
}

/** Validate a stored id/version pair value-free (never echoes the value). */
function assertValidEntry(id: string, active: string): void {
  if (!PLUGIN_ID_PATTERN.test(id) || id.length > PLUGIN_ID_COLUMN_LENGTH) {
    throw new PluginStateError('invalid_plugin_id', 'plugin state contains an invalid plugin id');
  }
  if (!isValidSemverVersion(active) || active.length > ACTIVE_VERSION_COLUMN_LENGTH) {
    throw new PluginStateError(
      'invalid_version',
      'plugin state contains an invalid active version',
    );
  }
}

/**
 * Parse a stored `settings` text column back into an object. `null` (or an
 * empty string) yields `undefined`; anything that is not a JSON object raises a
 * value-free {@link PluginStateError} (the raw text is never echoed).
 */
function parseSettings(text: string | null): Record<string, unknown> | undefined {
  if (text === null || text === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginStateError('invalid_state', 'plugin state contains invalid settings');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginStateError('invalid_state', 'plugin state contains invalid settings');
  }
  return parsed as Record<string, unknown>;
}

/** Serialize settings to the stored text column (`null` when unset). */
function serializeSettings(settings: Record<string, unknown> | undefined): string | null {
  if (settings === undefined) {
    return null;
  }
  try {
    return JSON.stringify(settings);
  } catch {
    throw new PluginStateError('invalid_state', 'plugin settings cannot be serialized');
  }
}

/** Validate an inbound {@link PluginState} before it is written, value-free. */
function assertValidState(state: PluginState): void {
  if (!pluginStateSchema.safeParse(state).success) {
    throw new PluginStateError('invalid_state', 'plugin state is invalid');
  }
  for (const [id, entry] of Object.entries(state.plugins)) {
    assertValidEntry(id, entry.active);
  }
}

/** Validate one inbound entry before it is written, value-free. */
function assertValidPut(id: string, entry: PluginStateEntry): void {
  assertValidState({ version: PLUGIN_STATE_VERSION, plugins: { [id]: entry } });
}

/**
 * Write the given entries row by row: an id with a row is updated in place
 * (when anything changed), a new id is inserted, and a stray duplicate row of
 * a written id is deleted. Rows of ids not in `entries` are not touched.
 */
async function writeEntries(
  repository: Repository<DatabasePluginState>,
  entries: ReadonlyMap<string, PluginStateEntry>,
): Promise<void> {
  const ids = [...entries.keys()];
  if (ids.length === 0) return;
  const updatedAt = new Date();
  const existing = new Map<string, DatabasePluginState>();
  const duplicates: number[] = [];
  for (const row of await repository.find({
    where: { pluginId: In(ids) },
    order: { id: 'ASC' },
  })) {
    if (existing.has(row.pluginId)) duplicates.push(row.id);
    else existing.set(row.pluginId, row);
  }
  const writes: DatabasePluginState[] = [];
  for (const [id, entry] of entries) {
    const settings = serializeSettings(entry.settings);
    const row = existing.get(id);
    if (
      row !== undefined &&
      row.activeVersion === entry.active &&
      row.enabled === entry.enabled &&
      row.settings === settings
    ) {
      continue;
    }
    writes.push(
      repository.create({
        ...(row === undefined ? {} : { id: row.id }),
        pluginId: id,
        activeVersion: entry.active,
        enabled: entry.enabled,
        settings,
        updatedAt,
      }),
    );
  }
  if (duplicates.length > 0) {
    await repository.delete({ id: In(duplicates) });
  }
  if (writes.length > 0) {
    await repository.save(writes);
  }
}

/**
 * Build a database-backed {@link PluginStateSource} over an initialized TypeORM
 * data source. The `jsails_plugin_state` table must already exist (created by
 * the migration history); every write is per row and never deletes a row it
 * was not asked to. See the module doc for the exact contract.
 */
export function createDatabasePluginStateStore(
  options: DatabasePluginStateStoreOptions,
): PluginStateSource {
  if (options.dataSource === undefined && options.getDataSource === undefined) {
    throw new TypeError('createDatabasePluginStateStore requires a data source');
  }

  let resolved: DataSource | undefined;
  let resolving: Promise<DataSource> | undefined;
  // The table never disappears under a running app in normal operation, so a
  // positive check is cached instead of costing an information_schema round
  // trip on every load and save.
  let tableExists = false;

  /** Resolve and initialize the data source once. */
  async function resolveDataSource(): Promise<DataSource> {
    if (resolved !== undefined) return resolved;
    resolving ??= (async () => {
      const getDataSource = options.getDataSource;
      const source = getDataSource !== undefined ? getDataSource() : options.dataSource;
      if (source === undefined) {
        throw new TypeError('createDatabasePluginStateStore requires a data source');
      }
      // Explicitly supplied sources are caller-owned: require initialization.
      // A lazy getDataSource is app-owned and may initialize on first use.
      if (getDataSource !== undefined && !source.isInitialized) {
        await source.initialize();
      }
      resolved = source;
      return source;
    })();
    try {
      return await resolving;
    } finally {
      resolving = undefined;
    }
  }

  /** Fail with a clear error when the table is missing; never create it. */
  async function assertTableExists(dataSource: DataSource): Promise<void> {
    if (!dataSource.isInitialized) {
      throw new PluginStateError('unavailable', 'the plugin state data source must be initialized');
    }
    if (tableExists) return;
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(PLUGIN_STATE_TABLE))) {
        throw new PluginStateError(
          'missing_table',
          'the managed plugin state table does not exist; run db:push to create it',
        );
      }
      tableExists = true;
    } finally {
      await queryRunner.release();
    }
  }

  async function load(): Promise<PluginState> {
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    const repository = dataSource.getRepository(DatabasePluginState);
    // Lowest primary key first, so the first row of a duplicated id wins.
    const rows = await repository.find({ order: { id: 'ASC' } });
    const plugins: Record<
      string,
      { active: string; enabled: boolean; settings?: Record<string, unknown> }
    > = {};
    for (const row of rows) {
      assertValidEntry(row.pluginId, row.activeVersion);
      if (Object.hasOwn(plugins, row.pluginId)) continue;
      const settings = parseSettings(row.settings);
      plugins[row.pluginId] = {
        active: row.activeVersion,
        enabled: row.enabled,
        ...(settings === undefined ? {} : { settings }),
      };
    }
    return { version: PLUGIN_STATE_VERSION, plugins };
  }

  async function save(state: PluginState): Promise<void> {
    assertValidState(state);
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    await dataSource.transaction(async (manager) => {
      await writeEntries(
        manager.getRepository(DatabasePluginState),
        new Map(Object.entries(state.plugins)),
      );
    });
  }

  async function putEntry(id: string, entry: PluginStateEntry): Promise<void> {
    assertValidPut(id, entry);
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    await dataSource.transaction(async (manager) => {
      await writeEntries(manager.getRepository(DatabasePluginState), new Map([[id, entry]]));
    });
  }

  async function removeEntry(id: string): Promise<void> {
    if (!PLUGIN_ID_PATTERN.test(id) || id.length > PLUGIN_ID_COLUMN_LENGTH) {
      throw new PluginStateError('invalid_plugin_id', 'plugin state contains an invalid plugin id');
    }
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    await dataSource.getRepository(DatabasePluginState).delete({ pluginId: id });
  }

  return { load, save, putEntry, removeEntry };
}
