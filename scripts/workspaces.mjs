/**
 * The monorepo as the repo tooling sees it: the repository root, the workspace
 * directories the root `package.json` declares, a manifest reader, and the
 * workspace dependency graph with its topological order. Every script under
 * `scripts/` resolves paths through this module so there is one definition of
 * where the repo is, which packages it contains, and the order they build and
 * publish in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path of the repository root (the parent of `scripts/`). */
export const repoRoot = resolve(import.meta.dirname, '..');

/** Parses `<dir>/package.json`. */
export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * Expands the root `workspaces` globs into absolute directories, in the order
 * the root manifest lists them. Only a trailing `/*` is supported, which is
 * the only glob form this repo uses.
 */
export function workspaceDirs() {
  const { workspaces } = readManifest(repoRoot);
  return workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(repoRoot, pattern)];
    const parent = join(repoRoot, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  });
}

/** Every workspace manifest, keyed by package name, with its directory. */
export function readWorkspaces() {
  const workspaces = new Map();
  for (const dir of workspaceDirs()) {
    const manifest = readManifest(dir);
    workspaces.set(manifest.name, { dir, manifest });
  }
  return workspaces;
}

/**
 * Each workspace's in-repo dependencies: the other workspaces it names in
 * `dependencies`, `devDependencies`, or `peerDependencies`.
 */
export function workspaceGraph(workspaces) {
  const graph = new Map();
  for (const [name, { manifest }] of workspaces) {
    graph.set(
      name,
      new Set(
        [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
          .flatMap((group) => Object.keys(group ?? {}))
          .filter((dep) => workspaces.has(dep) && dep !== name),
      ),
    );
  }
  return graph;
}

/**
 * The workspaces in dependency order (Kahn's algorithm). Ties break by name so
 * the order is stable across machines; a cycle throws, naming its members.
 */
export function topologicalOrder(graph) {
  const dependents = new Map([...graph.keys()].map((name) => [name, []]));
  const pending = new Map();
  for (const [name, deps] of graph) {
    pending.set(name, deps.size);
    for (const dep of deps) dependents.get(dep).push(name);
  }

  const ready = [...pending].filter(([, count]) => count === 0).map(([name]) => name);
  const order = [];
  while (ready.length > 0) {
    ready.sort();
    const name = ready.shift();
    order.push(name);
    for (const dependent of dependents.get(name)) {
      const remaining = pending.get(dependent) - 1;
      pending.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length !== graph.size) {
    const cyclic = [...pending].filter(([, count]) => count > 0).map(([name]) => name);
    throw new Error(`Workspace dependency cycle among: ${cyclic.sort().join(', ')}`);
  }
  return order;
}
