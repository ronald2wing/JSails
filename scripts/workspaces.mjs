/**
 * The monorepo as the repo tooling sees it: the repository root, the workspace
 * directories the root `package.json` declares, a manifest reader, and the
 * workspace dependency graph with its topological order. Every script under
 * `scripts/` resolves paths through this module so there is one definition of
 * where the repo is, which packages it contains, and the order they build and
 * publish in.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path of the repository root (the parent of `scripts/`). */
export const repoRoot = resolve(import.meta.dirname, '..');

/** Parses `<dir>/package.json`. */
export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * Expands the root `workspaces` globs of the repository at `root` into
 * absolute directories, in the order the root manifest lists them. Only a
 * trailing `/*` is supported, which is the only glob form this repo uses.
 *
 * A glob matches only directories that hold a `package.json`, as npm's own
 * workspace mapping does: a removed package leaves its ignored build output
 * (`dist/`) behind in a checkout that built it, and that leftover is not a
 * workspace.
 */
export function workspaceDirs(root = repoRoot) {
  const { workspaces } = readManifest(root);
  return workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .filter((dir) => existsSync(join(dir, 'package.json')));
  });
}

/** Every workspace manifest, keyed by package name, with its directory. */
export function readWorkspaces(root = repoRoot) {
  const workspaces = new Map();
  for (const dir of workspaceDirs(root)) {
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
