/**
 * In-process testing entry point (`jsails/testing`).
 *
 * Server-only: importing this subpath pulls in the application runtime (Hono,
 * page rendering, and the app config loader) but is never part of the
 * browser-agnostic root entry. Runtime values are exported here; the types a
 * test author needs to annotate a {@link TestApplication} are re-exported so no
 * root import is required.
 */

export { createTestApp, DEFAULT_TEST_ORIGIN, TEST_ORIGIN_ENV, TestRequestError } from './app.js';

export type { TestAppOptions, TestApplication, TestingLifecycle } from './app.js';

export { createComponentTestHarness } from './server-components.js';

export type {
  ComponentRenderResult,
  ComponentTestHarness,
  ComponentTestHarnessOptions,
  ComponentUpdateOptions,
  ComponentUpdateTestResult,
} from './server-components.js';

export { createTestRequestContext } from './request-context.js';

export type { TestRequestContextOptions } from './request-context.js';

export { withTestTransaction, createEmptyDataSource } from './test-database.js';

export type { CreateEmptyDataSourceOptions, EmptyDataSourceEntities } from './test-database.js';

export { tick, waitFor, WaitForTimeoutError } from './wait-for.js';

export type { WaitForOptions } from './wait-for.js';

export type { Application } from '../app/application.js';
export type { JsailsAppConfig, ResolvedAppConfig } from '../app/config/index.js';
