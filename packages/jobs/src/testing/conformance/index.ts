/**
 * The jobs adapter conformance suite: neutral scenarios run through a
 * {@link JobsHarnessDriver}, registered by {@link testJobsAdapter}.
 */

export {
  type DriverFactory,
  type DriverOptions,
  type JobEvent,
  type JobsHarnessDriver,
  type ScenarioBatchCallbacks,
  type ScenarioCall,
  type ScenarioDispatchOptions,
  type ScenarioJob,
  type ScenarioJobContext,
  type ScenarioMiddleware,
  type ScenarioSchedule,
  type StartWorkerOptions,
  type WorkerHandle,
} from './driver.js';
export { ExecutionLog, type Execution } from './recorder.js';
export { ScenarioJobFailure, type Harness, type Scenario, type ScenarioGroup } from './scenario.js';
export {
  DRAIN_DEADLINE_MS,
  conformancePlan,
  SCENARIO_GROUPS,
  runScenario,
  suiteName,
  testJobsAdapter,
  type ConformanceGroup,
  type ConformanceTest,
  type TestJobsAdapterOptions,
} from './suite.js';
