/**
 * Collects everything the loaded-set gate judges, for the repo at `root`:
 * the loaded set of every public entry and every scenario (one fresh process
 * each, run concurrently), the browser closure of every browser-tier entry,
 * and core's own browser-safe declaration.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { listWorkspaces, loadParser } from '../api-report.mjs';
import { browserClosure, entryFileMap } from './browser-closure.mjs';
import { pool, probe, publicEntries, summarize } from './loaded-set.mjs';
import { ENTRIES, SCENARIOS } from './policy.mjs';
import { prepareScenario } from './scenarios.mjs';

/**
 * The browser-safe subpaths core declares (`declaredBrowserSafeSubpaths`), or
 * undefined when the build does not export it.
 */
export async function declaredBrowserSafe(root) {
  const file = join(root, 'core', 'dist', 'src', 'symbols', 'framework-symbol-catalog-scan.js');
  if (!existsSync(file)) return undefined;
  const module = await import(pathToFileURL(file).href);
  return typeof module.declaredBrowserSafeSubpaths === 'function'
    ? module.declaredBrowserSafeSubpaths()
    : undefined;
}

/**
 * Measures the repo. Returns `{ workspaces, entries, loaded, closures,
 * declared }`: `loaded` maps an entry or scenario name to its summary (see
 * `summarize`) plus `workspace`; `closures` maps a browser-tier entry to its
 * browser closure. `only` restricts the measured names (entries and scenarios).
 */
export async function measure({
  root,
  entries: entryPolicy = ENTRIES,
  scenarios = SCENARIOS,
  only,
  withScenarios = true,
  declared = true,
}) {
  const workspaces = listWorkspaces(root);
  const entries = publicEntries(workspaces);
  const wanted = (name) => only === undefined || only.includes(name);
  const tasks = [];
  for (const { entry, workspace, file } of entries) {
    if (!wanted(entry)) continue;
    tasks.push(async () => {
      const record = await probe({ mode: 'import', file }, { cwd: root, label: entry });
      return [entry, { ...summarize(record, workspaces), workspace }];
    });
  }
  if (withScenarios) {
    for (const name of Object.keys(scenarios)) {
      if (!wanted(name)) continue;
      tasks.push(async () => {
        const scenario = prepareScenario(name, root);
        try {
          const record = await probe(scenario.target, { cwd: scenario.cwd, label: name });
          return [name, { ...summarize(record, workspaces), workspace: undefined }];
        } finally {
          scenario.cleanup();
        }
      });
    }
  }
  const loaded = new Map(await pool(tasks));

  const parseSync = await loadParser(root);
  const files = entryFileMap(entries);
  const cache = new Map();
  const closures = new Map();
  for (const { entry, file } of entries) {
    if (!wanted(entry) || entryPolicy[entry]?.tier !== 'browser') continue;
    closures.set(entry, browserClosure(parseSync, file, files, cache));
  }

  return {
    workspaces,
    entries,
    loaded,
    closures,
    declared: declared ? await declaredBrowserSafe(root) : undefined,
  };
}
