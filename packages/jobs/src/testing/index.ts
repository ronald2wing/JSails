/**
 * Test support for job transports (`@jsails/jobs/testing`): the adapter
 * conformance suite every adapter, first-party or custom, is held to.
 */

export {
  DRAIN_DEADLINE_MS,
  conformancePlan,
  ExecutionLog,
  SCENARIO_GROUPS,
  ScenarioJobFailure,
  runScenario,
  suiteName,
  testJobsAdapter,
  type DriverFactory,
  type DriverOptions,
  type Execution,
  type Harness,
  type JobEvent,
  type JobsHarnessDriver,
  type Scenario,
  type ScenarioBatchCallbacks,
  type ScenarioCall,
  type ScenarioDispatchOptions,
  type ScenarioGroup,
  type ScenarioJob,
  type ScenarioJobContext,
  type ScenarioMiddleware,
  type ScenarioSchedule,
  type StartWorkerOptions,
  type ConformanceGroup,
  type ConformanceTest,
  type TestJobsAdapterOptions,
  type WorkerHandle,
} from './conformance/index.js';
