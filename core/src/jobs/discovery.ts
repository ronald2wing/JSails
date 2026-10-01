/**
 * Job discovery: load compiled `*.job.js` modules from a directory tree.
 *
 * The jobs directory is a convention, not a registry. Each top-level `.js` or
 * `.mjs` file default-exports one job class or object definition. Helpers,
 * tests, and `index` modules belong outside the scanned surface (subdirectories
 * are ignored). The queue name is the definition's explicit name, otherwise the
 * camel-cased file basename.
 *
 * No import graph is walked: importing a job module lets Node resolve its own
 * imports normally. Only entry files are selected.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { camelCase } from 'es-toolkit/string';

import {
  createJobRegistry,
  jobDefinitionName,
  type JobDefinition,
  type JobRegistry,
} from './registry.js';

/** Raised when a discovered job module is malformed. Value-free. */
export class JobDiscoveryError extends Error {
  readonly code: 'load_failed' | 'invalid_export' | 'invalid_name' | 'duplicate_name';

  constructor(code: JobDiscoveryError['code'], message: string) {
    super(message);
    this.name = 'JobDiscoveryError';
    this.code = code;
  }
}

function isJobModuleFile(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (name === 'index.job.js' || name === 'index.job.mjs') return false;
  return name.endsWith('.job.js') || name.endsWith('.job.mjs');
}

/** `billing/send-invoice.job.js` → `billing.sendInvoice`. */
function jobNameFromRelative(relative: string): string {
  const withoutSuffix = relative.replace(/\.job\.m?js$/i, '');
  return withoutSuffix
    .split('/')
    .map((segment) => camelCase(segment))
    .join('.');
}

function walkJobFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), relative);
        continue;
      }
      if (entry.isFile() && isJobModuleFile(entry.name)) {
        files.push(relative);
      }
    }
  };
  walk(dir, '');
  return files;
}

/**
 * Load every `*.job.js` module under `dir` (recursive; helpers without the suffix are ignored). A missing directory is an empty
 * registry (a worker with no jobs is valid; schedules will reject unknown names).
 */
export async function loadJobRegistryFromDirectory(dir: string): Promise<JobRegistry> {
  let files: string[];
  try {
    files = walkJobFiles(dir);
  } catch (error) {
    if (isEnoent(error)) {
      return createJobRegistry({});
    }
    throw error;
  }

  const definitions: Record<string, JobDefinition> = Object.create(null) as Record<
    string,
    JobDefinition
  >;

  for (const relative of files) {
    const absolute = join(dir, relative);
    let module: unknown;
    try {
      module = await import(pathToFileURL(absolute).href);
    } catch {
      throw new JobDiscoveryError('load_failed', `failed to load job module "${relative}"`);
    }
    const definition = (module as { default?: unknown }).default;
    if (!isJobDefinition(definition)) {
      throw new JobDiscoveryError(
        'invalid_export',
        `job module "${relative}" must default-export a job class or definition`,
      );
    }
    const explicit = jobDefinitionName(definition);
    const name = explicit ?? jobNameFromRelative(relative);
    if (typeof name !== 'string' || name.trim() === '') {
      throw new JobDiscoveryError('invalid_name', `job module "${relative}" has an invalid name`);
    }
    if (definitions[name] !== undefined) {
      throw new JobDiscoveryError('duplicate_name', `duplicate job name "${name}"`);
    }
    if (typeof definition === 'function' && definition.jobName === undefined) {
      Object.defineProperty(definition, 'jobName', {
        value: name,
        enumerable: false,
        configurable: true,
      });
    }
    definitions[name] = definition;
  }

  return createJobRegistry(definitions);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isJobDefinition(value: unknown): value is JobDefinition {
  if (typeof value === 'function') {
    const candidate = value as unknown as {
      readonly schema?: unknown;
      readonly prototype?: { readonly handle?: unknown };
    };
    return candidate.schema !== undefined && typeof candidate.prototype?.handle === 'function';
  }
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { schema?: unknown }).schema !== undefined &&
    typeof (value as { handler?: unknown }).handler === 'function'
  );
}
