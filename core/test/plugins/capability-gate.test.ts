/** Tests for the setup-context capability gate: each key of its permission table names the context path whose call demands that permission. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PluginContext } from '../../src/extensions/plugin-contract.js';
import {
  gatePluginCapabilities,
  PLUGIN_CAPABILITY_PERMISSIONS,
  PluginPermissionError,
} from '../../src/plugins/capability-gate.js';

/** Keys that name a plugin field or a provide option, not a context path. */
const NOT_CONTEXT_PATHS = new Set(['replaceService', 'readiness']);

/** A context whose every member is a callable no-op, so the gate is all a call meets. */
function inertContext(): PluginContext {
  const noop = (): void => {};
  const registry = new Proxy({}, { get: () => noop });
  return {
    services: registry,
    rootDir: '/app',
    routes: registry,
    configureRequestScope: noop,
    configureGuard: noop,
    onServe: noop,
    intercept: noop,
    observe: noop,
    interceptorRegistry: registry,
  } as unknown as PluginContext;
}

/** The permission a call to the context path `path` demands of an undeclared plugin. */
function demandedBy(path: string): string | undefined {
  let demanded: string | undefined;
  const plugin = gatePluginCapabilities(
    {
      name: 'probe',
      setup(context) {
        const [head, method] = path.split('.') as [string, string | undefined];
        const member = (context as unknown as Record<string, unknown>)[head];
        try {
          if (method === undefined) (member as () => void)();
          else (member as Record<string, () => void>)[method]?.();
        } catch (error) {
          if (!(error instanceof PluginPermissionError)) throw error;
          demanded = error.permission;
        }
      },
    },
    'probe',
    [],
  );
  assert.equal(plugin.setup(inertContext()), undefined);
  return demanded;
}

describe('PLUGIN_CAPABILITY_PERMISSIONS', () => {
  it('keys every gated call by its context path, with the permission it demands', () => {
    for (const [path, permission] of Object.entries(PLUGIN_CAPABILITY_PERMISSIONS)) {
      if (NOT_CONTEXT_PATHS.has(path)) continue;
      assert.equal(demandedBy(path), permission, path);
    }
  });

  it('demands http.transform for routes.transform and http.guard for routes.guard', () => {
    assert.equal(demandedBy('routes.transform'), 'http.transform');
    assert.equal(demandedBy('routes.guard'), 'http.guard');
    assert.equal(demandedBy('routes.add'), 'http.routes');
  });
});
