/**
 * Runs one npm script in every workspace, dependencies first.
 *
 * `npm run <script> --workspaces` visits workspaces in glob order, which builds
 * `@jsails/admin` before the `@jsails/auth` it imports. This runner derives the
 * order from each workspace's declared dependencies instead, so adding a
 * package never means editing a hand-maintained chain, and an undeclared or
 * cyclic edge fails loudly here rather than working by accident of ordering.
 *
 * Workspaces run one at a time and the first failure stops the run. A
 * workspace without the script is skipped.
 *
 * Usage: node scripts/run-workspaces.mjs <script>
 */
import { exitStatus, npm, run } from './subprocess.mjs';
import { readManifest, repoRoot, workspaceDirs } from './workspaces.mjs';

const [script, ...rest] = process.argv.slice(2);
if (script === undefined || rest.length > 0) {
  console.error('Usage: node scripts/run-workspaces.mjs <script>');
  process.exit(2);
}

const workspaces = new Map();
for (const dir of workspaceDirs()) {
  const pkg = readManifest(dir);
  workspaces.set(pkg.name, pkg);
}

/** Kahn's algorithm; ties break by name so the order is stable across machines. */
function topologicalOrder() {
  const dependents = new Map([...workspaces.keys()].map((name) => [name, []]));
  const pending = new Map();
  for (const [name, pkg] of workspaces) {
    const deps = new Set(
      [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]
        .flatMap((group) => Object.keys(group ?? {}))
        .filter((dep) => workspaces.has(dep) && dep !== name),
    );
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

  if (order.length !== workspaces.size) {
    const cyclic = [...pending].filter(([, count]) => count > 0).map(([name]) => name);
    console.error(`Workspace dependency cycle among: ${cyclic.sort().join(', ')}`);
    process.exit(1);
  }
  return order;
}

for (const name of topologicalOrder()) {
  if (workspaces.get(name).scripts?.[script] === undefined) continue;
  const outcome = await run(npm, ['run', script, '--workspace', name], { cwd: repoRoot });
  if (outcome.code !== 0) {
    console.error(`\n"${script}" failed in ${name}`);
    process.exit(exitStatus(outcome));
  }
}
