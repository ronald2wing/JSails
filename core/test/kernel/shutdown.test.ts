/**
 * The start stage's shutdown: units drain in reverse dependency order under
 * one shared deadline and the services close after them; a unit never idle is
 * aborted at the deadline and the shutdown ends within the abort grace; a cut
 * (the second signal) aborts at once; a drain that throws is aborted; a start
 * that fails aborts the units it started. Adoption, release and the stage
 * refusals are covered here too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KernelStageErrors } from '../../src/kernel/errors.js';
import { openServices, type Services } from '../../src/kernel/open-services.js';
import { ABORT_GRACE_MS, start } from '../../src/kernel/start.js';
import type { UnitDeclaration } from './lifecycle-fixture.js';
import { graphOf, recordingUnit, unitPlugin } from './lifecycle-fixture.js';

const rootDir = import.meta.dirname;

/** Services of one plugin registering `units` for `web`, recording on `events`. */
function servicesOf(units: readonly UnitDeclaration[], events: string[]): Promise<Services> {
  return openServices(graphOf([unitPlugin('units', units, events).instance], ['web']), {
    rootDir,
  });
}

const web = ['web'] as const;

describe('kernel shutdown', () => {
  it('drains dependents first, independent units together, then closes the services', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [
        { roles: web, unit: recordingUnit('base', events) },
        { roles: web, unit: recordingUnit('left', events), options: { after: ['base'] } },
        { roles: web, unit: recordingUnit('right', events), options: { after: ['base'] } },
      ],
      events,
    );
    const kernel = await start(services);
    events.length = 0;
    const report = await kernel.shutdown({ deadlineMs: 5000 });
    assert.deepEqual(report, { outcome: 'drained', errors: [] });
    assert.deepEqual(events.slice(0, 2).sort(), ['drain:left', 'drain:right']);
    assert.ok(events.indexOf('drain:base') > events.indexOf('drained:left'));
    assert.ok(events.indexOf('drain:base') > events.indexOf('drained:right'));
    assert.equal(events.at(-1), 'cleanup:units', 'the services close after every unit drained');
    assert.equal(await kernel.shutdown(), report, 'a second shutdown returns the first report');
  });

  it('passes every drain the shared deadline signal', async () => {
    const events: string[] = [];
    const first = recordingUnit('first', events);
    const second = recordingUnit('second', events);
    const services = await servicesOf(
      [
        { roles: web, unit: first },
        { roles: web, unit: second },
      ],
      events,
    );
    await (await start(services)).shutdown({ deadlineMs: 5000 });
    assert.equal(first.deadlines.length, 1);
    assert.equal(first.deadlines[0], second.deadlines[0]);
  });

  it('aborts a unit that never idles at the deadline and ends within the abort grace', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [
        { roles: web, unit: recordingUnit('steady', events) },
        {
          roles: web,
          unit: recordingUnit('stuck', events, { neverIdle: true, stuckAbort: true }),
          options: { after: ['steady'] },
        },
      ],
      events,
    );
    const kernel = await start(services);
    const deadlineMs = 50;
    const began = performance.now();
    const report = await kernel.shutdown({ deadlineMs });
    const elapsed = performance.now() - began;
    assert.equal(report.outcome, 'aborted');
    assert.deepEqual(report.outcome === 'aborted' ? report.units : [], ['steady', 'stuck']);
    assert.ok(events.includes('abort:stuck'));
    assert.ok(!events.includes('drain:steady'), 'a unit whose dependents never drained is aborted');
    assert.ok(
      elapsed < deadlineMs + ABORT_GRACE_MS + 1000,
      `the shutdown took ${Math.round(elapsed)} ms`,
    );
    assert.ok(services.closed, 'the services close after an aborted drain');
  });

  it('aborts at once when the cut signal fires, whatever the deadline', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [{ roles: web, unit: recordingUnit('stuck', events, { neverIdle: true }) }],
      events,
    );
    const kernel = await start(services);
    const second = new AbortController();
    const shutting = kernel.shutdown({ deadlineMs: 600_000, signal: second.signal });
    second.abort();
    const report = await shutting;
    assert.equal(report.outcome, 'aborted');
    assert.deepEqual(events.slice(-2), ['abort:stuck', 'cleanup:units']);
  });

  it('follows a cut signal passed to a later shutdown call', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [{ roles: web, unit: recordingUnit('stuck', events, { neverIdle: true }) }],
      events,
    );
    const kernel = await start(services);
    const shutting = kernel.shutdown({ deadlineMs: 600_000 });
    const second = new AbortController();
    const again = kernel.shutdown({ signal: second.signal });
    second.abort();
    assert.equal(await again, await shutting);
    assert.equal((await shutting).outcome, 'aborted');
  });

  it('aborts a unit whose drain throws, and reports the error', async () => {
    const events: string[] = [];
    const failure = new Error('drain failed');
    const services = await servicesOf(
      [{ roles: web, unit: recordingUnit('broken', events, { drainError: failure }) }],
      events,
    );
    const report = await (await start(services)).shutdown({ deadlineMs: 5000 });
    assert.equal(report.outcome, 'aborted');
    assert.deepEqual(report.errors, [failure]);
    assert.ok(events.includes('abort:broken'));
  });
});

describe('kernel start', () => {
  it('aborts the started units, last first, when a start fails, and leaves the services open', async () => {
    const events: string[] = [];
    const failure = new Error('start failed');
    const services = await servicesOf(
      [
        { roles: web, unit: recordingUnit('one', events) },
        { roles: web, unit: recordingUnit('two', events) },
        { roles: web, unit: recordingUnit('three', events, { startError: failure }) },
        { roles: web, unit: recordingUnit('four', events) },
      ],
      events,
    );
    await assert.rejects(start(services), (error: unknown) => error === failure);
    assert.deepEqual(events, ['start:one', 'start:two', 'start:three', 'abort:two', 'abort:one']);
    assert.ok(!services.closed);
    await services.close();
    assert.equal(events.at(-1), 'cleanup:units');
  });

  it('refuses services it did not build, closed ones, and a second start', async () => {
    const events: string[] = [];
    await assert.rejects(start({} as Services), (error: unknown) =>
      KernelStageErrors.is(error, 'invalid_stage'),
    );
    const closed = await servicesOf([], events);
    await closed.close();
    await assert.rejects(start(closed), (error: unknown) =>
      KernelStageErrors.is(error, 'invalid_stage'),
    );
    const services = await servicesOf([], events);
    const kernel = await start(services);
    await assert.rejects(start(services), (error: unknown) =>
      KernelStageErrors.is(error, 'invalid_stage'),
    );
    await kernel.shutdown();
  });

  it('judges host units with the plugin units', async () => {
    const events: string[] = [];
    const services = await servicesOf([{ roles: web, unit: recordingUnit('plugin', events) }], []);
    await assert.rejects(
      start(services, {
        units: [{ roles: web, unit: recordingUnit('host', events), after: ['missing'] }],
      }),
      (error: unknown) => KernelStageErrors.is(error, 'unknown_unit'),
    );
    const again = await servicesOf([{ roles: web, unit: recordingUnit('plugin', events) }], []);
    const kernel = await start(again, {
      units: [{ roles: web, unit: recordingUnit('host', events), after: ['plugin'] }],
    });
    assert.deepEqual(kernel.units, ['plugin', 'host']);
    await kernel.shutdown();
    await services.close();
  });
});

describe('kernel adopt', () => {
  it('drains an adopted unit before the units started earlier, and release drains it alone', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [{ roles: web, unit: recordingUnit('base', events) }],
      events,
    );
    const kernel = await start(services);
    const first = await kernel.adopt(recordingUnit('listener', events));
    const second = await kernel.adopt(recordingUnit('released', events));
    assert.deepEqual(kernel.units, ['base', 'listener', 'released']);

    events.length = 0;
    assert.deepEqual(await second.release(), { outcome: 'drained', errors: [] });
    assert.deepEqual(events, ['drain:released', 'drained:released']);
    assert.deepEqual(kernel.units, ['base', 'listener']);

    events.length = 0;
    await kernel.shutdown({ deadlineMs: 5000 });
    assert.ok(events.indexOf('drained:listener') < events.indexOf('drain:base'));
    assert.deepEqual(await first.release(), { outcome: 'drained', errors: [] });
    await assert.rejects(kernel.adopt(recordingUnit('late', events)), (error: unknown) =>
      KernelStageErrors.is(error, 'invalid_stage'),
    );
  });

  it('refuses to adopt a unit named like a registered one', async () => {
    const events: string[] = [];
    const services = await servicesOf(
      [{ roles: web, unit: recordingUnit('base', events) }],
      events,
    );
    const kernel = await start(services);
    await assert.rejects(kernel.adopt(recordingUnit('base', events)), (error: unknown) =>
      KernelStageErrors.is(error, 'duplicate_unit'),
    );
    await kernel.shutdown();
  });
});
