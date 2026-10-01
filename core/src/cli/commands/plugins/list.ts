/**
 * The read-only `list`/`check` subcommands: discover the plugin packages the
 * app depends on (direct npm dependencies that self-identify through their
 * `package.json` `jsails` field, and the plugin packages those depend on) and
 * print them with provenance, or validate each plugin's `jsailsCompat` range
 * and declared plugin dependencies against the running framework version.
 * `--json` selects machine-readable output.
 */

import {
  checkPlugins,
  readFrameworkVersion,
  type CheckFinding,
  type CheckPluginsResult,
} from '../../../plugins/check.js';
import {
  discoverPlugins,
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type DiscoverPluginsResult,
  type PluginEdge,
  type PluginIssue,
} from '../../../plugins/discovery/index.js';

import type { PluginsDeps } from './index.js';

/** How a report is rendered: machine-readable JSON or the human layout. */
export interface ReportFormat {
  readonly json: boolean;
}

/** Shared `list`/`check` dispatch: plugins discovered under `deps.cwd`, then reported. */
export function runDiscoverCommand(
  subcommand: 'list' | 'check',
  format: ReportFormat,
  deps: PluginsDeps,
): number {
  let result: DiscoverPluginsResult;
  try {
    result = discoverPlugins({ rootDir: deps.cwd });
  } catch (error) {
    if (error instanceof PluginDiscoveryError) {
      deps.stderr(`jsails: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (subcommand === 'check') {
    const frameworkVersion = deps.frameworkVersion ?? readFrameworkVersion();
    return reportCheck(checkPlugins(result, frameworkVersion), format, deps);
  }
  return reportList(result, format, deps);
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
 * Render a plugin for the human `list` table: id@version, its npm package,
 * provenance (`root` for a direct dependency, `dependency` for a transitive
 * one), and, when non-empty, its `requiredBy`.
 */
function humanPluginLine(plugin: DiscoveredPlugin): string {
  const parts = [
    `${plugin.id}@${plugin.version}`,
    `[${plugin.packageName}]`,
    plugin.root ? 'root' : 'dependency',
  ];
  if (plugin.requiredBy.length > 0) {
    parts.push(`required by: ${plugin.requiredBy.join(', ')}`);
  }
  return parts.join(' ');
}

function pluginToJson(plugin: DiscoveredPlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    version: plugin.version,
    packageName: plugin.packageName,
    jsailsCompat: plugin.manifest.jsailsCompat,
    permissions: plugin.manifest.permissions,
    entry: plugin.manifest.entry,
    root: plugin.root,
    ...(plugin.requiredBy.length === 0 ? {} : { requiredBy: plugin.requiredBy }),
    ...(plugin.provenanceChain.length === 0 ? {} : { provenanceChain: plugin.provenanceChain }),
  };
}

/** Render the dependency edges as a compact `from -> to` list, or nothing. */
function edgesToJson(edges: readonly PluginEdge[]): Record<string, unknown> {
  return edges.length === 0 ? {} : { edges: edges.map(edgeToJson) };
}

/** A single directed edge as a compact string. */
function edgeToJson(edge: PluginEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

function issueToJson(issue: PluginIssue): Record<string, unknown> {
  return {
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
