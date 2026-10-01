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

export { postForm, createFakeClock, tempDir, deferred, createTestSession } from './fixtures.js';

export type { FakeClock, Deferred } from './fixtures.js';

export type { WaitForOptions } from './wait-for.js';

// Audit regression tests and the shared fakes they use: test titles keyed by
// audit id with a bounded timeout, a deadline assertion, reproducible randomness, and a TCP
// peer that never answers.
export {
  auditCase,
  auditTitle,
  AuditTestError,
  AUDIT_ID_PATTERN,
  DEFAULT_AUDIT_TIMEOUT_MS,
  settlesWithin,
  SettleTimeoutError,
} from './audit-test.js';

export type {
  AuditCaseOptions,
  AuditTestErrorCode,
  AuditTestOptions,
  SettleTimeoutErrorCode,
} from './audit-test.js';

export {
  FIXED_SEEDS,
  forEachSeed,
  seededRandom,
  TEST_SEED_ENV,
  testSeeds,
} from './seeded-random.js';

export type { SeededRandom, TestSeedsOptions } from './seeded-random.js';

export { generateRejectedRichText, generateRichTextDocument } from './rich-text-generator.js';

export type { RejectedRichText, RichTextGeneratorOptions } from './rich-text-generator.js';

export { blackholeServer } from './blackhole-server.js';

export { respServer } from './resp-server.js';

export type { RespServer, RespServerOptions } from './resp-server.js';

// Conformance cases every CacheStore and LeaseStore implementation is held to.
export { cacheStoreConformance, leaseStoreConformance } from './store-conformance.js';

export type {
  StoreConformanceCase,
  StoreConformanceOptions,
  StoreHarness,
  StoreHarnessFactory,
} from './store-conformance.js';

// Conformance cases every store is held to under `defineCache`.
export { defineCacheConformance } from './define-cache-conformance.js';

export type { DefineCacheHarness, DefineCacheHarnessFactory } from './define-cache-conformance.js';

export type { BlackholeMode, BlackholeServer, BlackholeServerOptions } from './blackhole-server.js';

// The inert-setup harness for plugins on the definePlugin contract: one
// instance's setup, run as the application runner runs it, under traps for
// network, file writes, subprocesses and recurring timers.
export { PluginHarnessErrors, testPlugin } from './plugin-harness.js';

export { runCommand } from './command-harness.js';

export type { CommandRun, RunCommandOptions } from './command-harness.js';

export type { PluginTestRun, TestPluginOptions } from './plugin-harness.js';

// The access matrix: every surface asked by every canonical actor through the
// real pipeline, with a probe in place of the route's code, judged by the
// hard access invariants.
export { accessMatrix, accessMatrixSession } from './access-matrix.js';

export type {
  AccessMatrixOptions,
  AccessMatrixResult,
  AccessMatrixTarget,
  ProbeBuilder,
  ProbeContext,
  ProbeRequest,
} from './access-matrix.js';

export { ACCESS_INVARIANTS } from './access-invariants.js';

export type {
  AccessInvariant,
  AccessInvariantId,
  AccessMatrixRow,
  AccessViolation,
  ProbeOrigin,
  ProbeOutcome,
} from './access-invariants.js';

export { AccessMatrixErrors, canonicalActors } from './canonical-actors.js';

export type { ActorCarrier, CanonicalActor, Persona } from './canonical-actors.js';

// The leak harness: what a cycle (a plugin set opened and shut down through
// the kernel stages, an application served and closed) leaves behind.
export { measureLeaks, measurePluginLeaks } from './leak-harness.js';

export type { LeakOptions, LeakReport, PluginLeakOptions } from './leak-harness.js';

// Job doubles, also on `jsails/jobs`: a dispatch recorder with assertions and
// an in-process adapter, so a test needs neither Valkey nor a second import.
export { createFakeJobs } from '../jobs/fake-jobs.js';
export { MemoryJobsAdapter } from '../jobs/memory-adapter.js';

export type { FakeDispatch, FakeJobs, FakeJobsOptions } from '../jobs/fake-jobs.js';

export type { Application } from '../app/application.js';
export type { JsailsAppConfig, ResolvedAppConfig } from '../app/config/index.js';
