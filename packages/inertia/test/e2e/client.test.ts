/**
 * The scenario table against the subject client: @inertiajs/react 3.11.0
 * running on `preact/compat` through the resolve-hook alias, in happy-dom,
 * against the engine over a loopback socket.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { CERTIFIED_CLIENT, CERTIFIED_REACT_API } from './module-graph.js';

import { SCENARIOS } from './scenarios.js';
import { openSession } from './session.js';

describe('real client on preact/compat', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const session = await openSession('preact');
      try {
        await scenario.run(session);
      } finally {
        await session.close();
      }
    });
  }
});

describe('certified client', () => {
  it('is the installed one, so a version bump goes through this suite', async () => {
    const installed: Record<string, string> = {};
    for (const [name, entry] of [
      ['@inertiajs/core', '../package.json'],
      ['@inertiajs/react', '../package.json'],
      ['react', './package.json'],
      ['react-dom', './package.json'],
    ] as const) {
      const manifest: unknown = JSON.parse(
        await readFile(new URL(entry, import.meta.resolve(name)), 'utf8'),
      );
      installed[name] = String(Reflect.get(Object(manifest), 'version'));
    }
    assert.deepEqual(installed, CERTIFIED_CLIENT);
  });

  it('uses only the inventoried React APIs, each provided by preact/compat', async () => {
    const source = await readFile(new URL(import.meta.resolve('@inertiajs/react')), 'utf8');
    const used = new Map<string, Set<string>>();
    const add = (module: string, name: string): void => {
      const names = used.get(module) ?? new Set<string>();
      names.add(name);
      used.set(module, names);
    };
    for (const match of source.matchAll(
      /import\s+([^;]*?)\s+from\s+"(react(?:-dom)?(?:\/[a-z-]+)?)"/gsu,
    )) {
      const [, clause = '', module = ''] = match;
      const named = /\{([^}]*)\}/su.exec(clause)?.[1] ?? '';
      for (const entry of named.split(',')) {
        const name = entry.trim().split(/\s+as\s+/u)[0] ?? '';
        if (name !== '') add(module, name);
      }
      const defaultName = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/u.exec(clause.trim())?.[1];
      if (defaultName !== undefined) {
        for (const member of source.matchAll(new RegExp(`\\b${defaultName}\\.(\\w+)`, 'gu'))) {
          add(module, member[1] ?? '');
        }
      }
    }
    assert.deepEqual(
      Object.fromEntries([...used].map(([module, names]) => [module, [...names].sort()])),
      CERTIFIED_REACT_API,
    );

    const compat: Readonly<Record<string, string>> = {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
    };
    for (const [module, names] of Object.entries(CERTIFIED_REACT_API)) {
      const target = compat[module];
      assert.ok(target !== undefined);
      const exports: unknown = await import(target);
      const defaults: unknown = Reflect.get(Object(exports), 'default');
      for (const name of names) {
        const provided: unknown =
          Reflect.get(Object(exports), name) ?? Reflect.get(Object(defaults), name);
        assert.ok(provided !== undefined, `${target} lacks ${name}`);
      }
    }
  });
});
