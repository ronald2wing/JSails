/**
 * Test support for job transports (`@jsails/jobs/testing`): the adapter
 * conformance suite every adapter, first-party or custom, is held to, and
 * the cron fire-time table a transport's own evaluator is checked against.
 */

export {
  CRON_FIRE_CASES,
  DRAIN_DEADLINE_MS,
  conformancePlan,
  ExecutionLog,
  SCENARIO_GROUPS,
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
  type CronFireCase,
  type TestJobsAdapterOptions,
  type WorkerHandle,
} from './conformance/index.js';
