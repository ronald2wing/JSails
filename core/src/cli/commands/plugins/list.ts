/**
 * The read-only `list`/`check` subcommands: discover plugins from the two
 * supported sources (direct npm dependencies that self-identify via their
 * `package.json` `jsails` field, and the storage-backed plugins folder) and
 * print them with provenance, or validate each plugin's `jsailsCompat` range
 * against the running framework version. `--json` selects machine-readable
 * output.
 */

import { join, resolve } from 'node:path';

import { resolveDirWithin } from '../../../support/path-containment.server.js';

import { formatError } from '../../../errors/inspect.js';
import {
  checkPlugins,
  readFrameworkVersion,
  type CheckFinding,
  type CheckPluginsResult,
} from '../../../plugins/check.js';
import {
  DEFAULT_PLUGINS_DIR,
  discoverPlugins,
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type DiscoverPluginsResult,
  type PluginEdge,
  type PluginIssue,
} from '../../../plugins/discovery/index.js';
import { pluginSourceLabel } from '../../../plugins/provenance.js';

import type { ParsedValues, PluginsDeps } from './index.js';
import { explicitlySetFlags, rejectFlags } from './state.js';

/**
 * Resolve the plugins folder from `--dir`. A `--dir` that resolves outside cwd
 * (traversal or an absolute path landing elsewhere) is refused; otherwise the
 * default `<cwd>/storage/plugins` is used.
 */
export function resolvePluginsDir(cwd: string, dir: string | undefined): string {
  if (dir === undefined || dir === '') {
    return join(resolve(cwd), DEFAULT_PLUGINS_DIR);
  }
  return resolveDirWithin(
    cwd,
    dir,
    () => new Error('--dir escapes the working directory; choose a path inside it'),
  );
}

/** Shared `list`/`check` dispatch: flags gated, plugins discovered, then reported. */
export async function runDiscoverCommand(
  subcommand: 'list' | 'check',
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const rejected = rejectFlags(subcommand, explicitlySetFlags(values), deps);
  if (rejected !== undefined) {
    return rejected;
  }

  let pluginsDir: string;
  try {
    pluginsDir = resolvePluginsDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  let result: DiscoverPluginsResult;
  try {
    result = discoverPlugins({ rootDir: deps.cwd, pluginsDir });
  } catch (error) {
    if (error instanceof PluginDiscoveryError) {
      deps.stderr(`jsails: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (subcommand === 'check') {
    const frameworkVersion = deps.frameworkVersion ?? readFrameworkVersion();
    return reportCheck(
      checkPlugins(result, frameworkVersion),
      { json: values.json === true },
      deps,
    );
  }
  return reportList(result, { json: values.json === true }, deps);
}

/** How a report is rendered: machine-readable JSON or the human layout. */
interface ReportFormat {
  readonly json: boolean;
}

/** Print the `list` result as JSON or a human table. */
function reportList(
  result: DiscoverPluginsResult,
  format: ReportFormat,
  deps: PluginsDeps,
): number {
  if (format.json) {
    deps.stdout(
      JSON.stringify({
        plugins: result.plugins.map(pluginToJson),
        issues: result.issues.map(issueToJson),
        ...edgesToJson(result.edges),
      }),
    );
  } else {
    deps.stdout(`jsails plugins - ${result.plugins.length} plugin(s) discovered.`);
    for (const plugin of result.plugins) {
      deps.stdout(`  ${humanPluginLine(plugin)}`);
    }
    for (const issue of result.issues) {
      deps.stderr(`jsails: warning: ${issue.message}`);
    }
  }
  return 0;
}

/** Print the `check` result as JSON or a human list; exit 1 on any finding. */
function reportCheck(result: CheckPluginsResult, format: ReportFormat, deps: PluginsDeps): number {
  if (format.json) {
    deps.stdout(
      JSON.stringify({
        ok: result.ok,
        frameworkVersion: result.frameworkVersion,
        plugins: result.plugins.map(pluginToJson),
        findings: result.findings.map(findingToJson),
      }),
    );
  } else {
    deps.stdout(
      `jsails plugins check - framework ${result.frameworkVersion}: ` +
        `${result.findings.length} finding(s).`,
    );
    for (const finding of result.findings) {
      deps.stdout(`  ${finding.kind.padEnd(12)}${finding.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

/**
 * Render a plugin for the human `list` table: id@version, source, provenance
 * (`root` vs transitive `dependency`), and, when non-empty, its `requiredBy`.
 */
function humanPluginLine(plugin: DiscoveredPlugin): string {
  const parts = [`${plugin.id}@${plugin.version}`, `[${pluginSourceLabel(plugin.source)}]`];
  const provenance = provenanceLabel(plugin);
  if (provenance !== '') {
    parts.push(provenance);
  }
  const requiredBy = plugin.requiredBy ?? [];
  if (requiredBy.length > 0) {
    parts.push(`required by: ${requiredBy.join(', ')}`);
  }
  return parts.join(' ');
}

/** The provenance word: `root` for a direct dependency, `dependency` for a transitive one. */
function provenanceLabel(plugin: DiscoveredPlugin): string {
  if (plugin.source === 'bundle') {
    return '';
  }
  return plugin.root === true ? 'root' : 'dependency';
}

function pluginToJson(plugin: DiscoveredPlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    version: plugin.version,
    source: plugin.source,
    jsailsCompat: plugin.manifest.jsailsCompat,
    permissions: plugin.manifest.permissions,
    entry: plugin.manifest.entry,
    ...(plugin.packageName === undefined ? {} : { packageName: plugin.packageName }),
    ...(plugin.bundleDir === undefined ? {} : { bundleDir: plugin.bundleDir }),
    ...(plugin.root === undefined ? {} : { root: plugin.root }),
    ...(plugin.requiredBy === undefined || plugin.requiredBy.length === 0
      ? {}
      : { requiredBy: plugin.requiredBy }),
    ...(plugin.provenanceChain === undefined || plugin.provenanceChain.length === 0
      ? {}
      : { provenanceChain: plugin.provenanceChain }),
  };
}

/** Render the dependency edges as a compact `from -> to` list, or nothing. */
function edgesToJson(edges: readonly PluginEdge[] | undefined): Record<string, unknown> {
  return edges === undefined || edges.length === 0 ? {} : { edges: edges.map(edgeToJson) };
}

/** A single directed edge as a compact string. */
function edgeToJson(edge: PluginEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

function issueToJson(issue: PluginIssue): Record<string, unknown> {
  return {
    source: issue.source,
    code: issue.code,
    message: issue.message,
    ...(issue.path === undefined ? {} : { path: issue.path }),
    ...(issue.pluginId === undefined ? {} : { pluginId: issue.pluginId }),
  };
}

function findingToJson(finding: CheckFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    code: finding.code,
    message: finding.message,
    ...(finding.pluginId === undefined ? {} : { pluginId: finding.pluginId }),
    ...(finding.path === undefined ? {} : { path: finding.path }),
  };
}
