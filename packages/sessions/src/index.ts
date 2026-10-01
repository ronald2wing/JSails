/**
 * Database-backed sessions (`@jsails/sessions`).
 *
 * This package carries the framework-owned session entity and the
 * database-backed {@link SessionStore}. It imports no HTTP, queue, or
 * Socket.IO runtime beyond the `Session`/`SessionStore` contracts (referenced
 * through `import type`) and the TypeORM entity backing the `jsails_session`
 * table.
 */

export {
  JsailsSession,
  sessionEntities,
  SESSION_TABLE,
  SESSION_ID_COLUMN_LENGTH,
} from './entities.js';

export {
  createDatabaseSessionStore,
  SessionStoreError,
  type DatabaseSessionStore,
  type DatabaseSessionStoreOptions,
  type SessionStoreErrorCode,
} from './database-store.js';
