/**
 * The lifecycle plan through the stages: for each role set the kernel starts
 * exactly the units registered for those roles, in dependency order, while
 * every role set opens the same services, and its dedicated units are those
 * no left-out role registers; a plan with an unknown, duplicate
 * or cyclic unit is refused in every process; and a process-local transport
 * used by roles split across processes is refused (`kernel.adapter_not_shared`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KernelStageErrors } from '../../src/kernel/errors.js';
import { dedicatedUnits } from '../../src/kernel/lifecycle-plan.js';
import { openServices } from '../../src/kernel/open-services.js';
import { start } from '../../src/kernel/start.js';
import type { PluginInstance } from '../../src/plugins/contract/instance.js';
import type { PluginRole } from '../../src/plugins/contract/lifecycle.js';
import { graphOf, recordingUnit, unitPlugin } from './lifecycle-fixture.js';

const rootDir = import.meta.dirname;

/** Plugins registering units for every kind of role set, recording on `events`. */
function rolePlugins(events: string[]) {
  const store = unitPlugin(
    'store',
    [{ roles: ['web', 'worker'], unit: recordingUnit('store', events) }],
    events,
  );
  const warm = unitPlugin(
    'warm',
    [
      {
        roles: ['web'],
        unit: recordingUnit('warm', events),
        options: { after: ['store'] },
      },
    ],
    events,
  );
  const consumer = unitPlugin(
    'consumer',
    [
      {
        roles: ['worker'],
        unit: recordingUnit('consumer', events),
        options: { after: ['store'] },
      },
    ],
    events,
  );
  const exporter = unitPlugin(
    'exporter',
    [{ roles: ['export'], unit: recordingUnit('exporter', events) }],
    events,
  );
  return [store, warm, consumer, exporter];
}

describe('the lifecycle plan', () => {
  const cases: readonly (readonly [readonly PluginRole[], readonly string[]])[] = [
    [['web'], ['store', 'warm']],
    [['worker'], ['store', 'consumer']],
    [
      ['web', 'worker'],
      ['store', 'warm', 'consumer'],
    ],
    [['export'], ['exporter']],
    [[], []],
  ];
  for (const [roles, expected] of cases) {
    it(`starts exactly ${JSON.stringify(expected)} for the roles ${JSON.stringify(roles)}, with every service`, async () => {
      const events: string[] = [];
      const plugins = rolePlugins(events);
      const services = await openServices(
        graphOf(
          plugins.map(({ instance }) => instance),
          roles,
        ),
        { rootDir },
      );
      for (const { token } of plugins) {
        assert.ok(
          services.registry.tryGet(token) !== undefined,
          'every role set opens every service',
        );
      }
      assert.equal(
        services.registrations.length,
        4,
        'every registration is known in every process',
      );
      const kernel = await start(services);
      assert.deepEqual(kernel.units, expected);
      assert.deepEqual(
        events,
        expected.map((name) => `start:${name}`),
      );
      const report = await kernel.shutdown({ deadlineMs: 5000 });
      assert.deepEqual(report, { outcome: 'drained', errors: [] });
      assert.ok(services.closed);
    });
  }

  it('names as dedicated only the units registered for no role the process leaves out', async () => {
    const cases: readonly (readonly [readonly PluginRole[], readonly string[]])[] = [
      [['web'], ['warm']],
      [['worker'], ['consumer']],
      [
        ['web', 'worker'],
        ['store', 'warm', 'consumer'],
      ],
    ];
    for (const [roles, expected] of cases) {
      const services = await openServices(
        graphOf(
          rolePlugins([]).map(({ instance }) => instance),
          roles,
        ),
        { rootDir },
      );
      assert.deepEqual(dedicatedUnits(services.units, new Set(roles)), expected, roles.join('+'));
      await services.close();
    }
  });

  it('orders by after, registration order breaking ties', async () => {
    const events: string[] = [];
    const late = unitPlugin('late', [
      { roles: ['web'], unit: recordingUnit('a', events), options: { after: ['c'] } },
      { roles: ['web'], unit: recordingUnit('b', events) },
      { roles: ['web'], unit: recordingUnit('c', events) },
    ]);
    const services = await openServices(graphOf([late.instance], ['web']), { rootDir });
    const kernel = await start(services);
    assert.deepEqual(kernel.units, ['b', 'c', 'a']);
    await kernel.shutdown({ deadlineMs: 5000 });
  });

  /** Open `instances` for `roles` and return the refusal. */
  async function refusal(
    instances: readonly PluginInstance[],
    roles: readonly PluginRole[],
  ): Promise<unknown> {
    try {
      const services = await openServices(graphOf(instances, roles), { rootDir });
      await services.close();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('refuses an unknown, a duplicate or a cyclic unit in every process, closing what setup opened', async () => {
    for (const roles of [['web'], ['worker'], []] as const) {
      const events: string[] = [];
      const unknown = unitPlugin(
        'unknown',
        [{ roles: ['worker'], unit: recordingUnit('u', events), options: { after: ['nobody'] } }],
        events,
      );
      assert.ok(KernelStageErrors.is(await refusal([unknown.instance], roles), 'unknown_unit'));
      assert.deepEqual(events, ['cleanup:unknown'], 'a refused plan closes the plugins');

      const first = unitPlugin('first', [{ roles: ['web'], unit: recordingUnit('same', events) }]);
      const second = unitPlugin('second', [
        { roles: ['worker'], unit: recordingUnit('same', events) },
      ]);
      assert.ok(
        KernelStageErrors.is(
          await refusal([first.instance, second.instance], roles),
          'duplicate_unit',
        ),
      );

      const cycle = unitPlugin('cycle', [
        { roles: ['web'], unit: recordingUnit('x', events), options: { after: ['y'] } },
        { roles: ['worker'], unit: recordingUnit('y', events), options: { after: ['x'] } },
      ]);
      assert.ok(KernelStageErrors.is(await refusal([cycle.instance], roles), 'unit_cycle'));
      assert.ok(!events.some((event) => event.startsWith('start:')), 'nothing started');
    }
  });

  describe('the reach rule', () => {
    /** A producer for web and a consumer for worker on one transport of `reach`. */
    function transportPlugins(reach: 'process' | 'shared') {
      const events: string[] = [];
      const transport = { name: 'queue', reach };
      return unitPlugin('queue', [
        { roles: ['web'], unit: recordingUnit('producer', events), options: { transport } },
        {
          roles: ['worker'],
          unit: recordingUnit('consumer', events),
          options: { transport, after: ['producer'] },
        },
      ]).instance;
    }

    it('refuses a process-local transport used by a role this process does not run', async () => {
      const web = await refusal([transportPlugins('process')], ['web']);
      assert.ok(KernelStageErrors.is(web, 'adapter_not_shared'));
      assert.deepEqual((web as { context?: unknown }).context, {
        transport: 'queue',
        role: 'worker',
      });
      const worker = await refusal([transportPlugins('process')], ['worker']);
      assert.ok(KernelStageErrors.is(worker, 'adapter_not_shared'));
      assert.deepEqual((worker as { context?: unknown }).context, {
        transport: 'queue',
        role: 'web',
      });
    });

    it('accepts it when the process runs every role on it, or none of them', async () => {
      for (const roles of [['web', 'worker'], [], ['export']] as const) {
        assert.equal(await refusal([transportPlugins('process')], roles), undefined);
      }
    });

    it('accepts a shared transport split across processes', async () => {
      for (const roles of [['web'], ['worker']] as const) {
        assert.equal(await refusal([transportPlugins('shared')], roles), undefined);
      }
    });
  });
});
