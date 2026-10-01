/**
 * The published entry points: every `exports` subpath resolves (through the
 * package's own name) to built files, and the browser-safe entries, the root
 * and `./client`, load no `node:*` module, no provider or MCP SDK, no
 * server-only `jsails` module, and none of the server-only subpaths. The
 * module graph is recorded by loading each entry in a fresh Node process
 * under the `browser` condition with a resolve hook, so it is the graph Node
 * really links, not a guess from the source text. A file a dependency maps
 * to `false` in its package.json `browser` field (as `object-inspect` does
 * for its `util` fallback) is left out with everything it loads, because a
 * browser bundler never includes it.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { SPAWN_CONCURRENCY } from '../spawn-concurrency.js';

const run = promisify(execFile);

interface Resolution {
  readonly specifier: string;
  readonly parent: string | null;
  readonly url: string;
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${packageRoot}package.json`, 'utf8')) as {
  readonly name: string;
  readonly exports: Readonly<Record<string, string | { types: string; default: string }>>;
};

const SUBPATHS = ['.', './client', './anthropic', './openai-compatible', './testing', './mcp'];

// Loads ENTRY with a resolve hook registered first and prints every
// resolution as JSON. Hooks see only modules imported after registration.
const RECORDER = `
import { registerHooks } from 'node:module';
const seen = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    seen.push({ specifier, parent: context.parentURL ?? null, url: result.url });
    return result;
  },
});
await import(process.env.ENTRY);
process.stdout.write(JSON.stringify(seen));
`;

async function moduleGraph(specifier: string): Promise<readonly Resolution[]> {
  const entry = import.meta.resolve(specifier);
  const { stdout } = await run(
    process.execPath,
    ['--conditions=browser', '--input-type=module', '--eval', RECORDER],
    { env: { ...process.env, ENTRY: entry }, cwd: packageRoot },
  );
  return JSON.parse(stdout) as Resolution[];
}

const SERVER_PACKAGES = /\/node_modules\/(?:@anthropic-ai\/|openai\/|@modelcontextprotocol\/)/;
const SERVER_SUBPATHS = /\/packages\/ai\/dist\/src\/(?:anthropic|openai-compatible|testing|mcp)\//;

/** Whether the nearest package.json maps this file to `false` for browsers. */
function browserExcluded(url: string): boolean {
  if (!url.startsWith('file:')) return false;
  const file = fileURLToPath(url);
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      const { browser } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { browser?: unknown };
      if (typeof browser !== 'object' || browser === null) return false;
      const key = `./${relative(dir, file).split(sep).join('/')}`;
      const map = browser as Record<string, unknown>;
      return map[key] === false || map[key.replace(/\.js$/, '')] === false;
    }
    if (dirname(dir) === dir) return false;
  }
}

/** The graph a browser bundler would include. */
function browserGraph(graph: readonly Resolution[]): Resolution[] {
  const excluded = new Set<string>();
  return graph.filter((resolution) => {
    if (
      (resolution.parent !== null && excluded.has(resolution.parent)) ||
      browserExcluded(resolution.url)
    ) {
      excluded.add(resolution.url);
      return false;
    }
    return true;
  });
}

function violations(graph: readonly Resolution[]): string[] {
  const found: string[] = [];
  for (const { specifier, url } of browserGraph(graph)) {
    if (url.startsWith('node:')) found.push(`builtin ${specifier}`);
    else if (SERVER_PACKAGES.test(url)) found.push(`sdk ${specifier}`);
    else if (SERVER_SUBPATHS.test(url)) found.push(`server subpath ${url}`);
    else if (/\.server\.js$/.test(url)) found.push(`server module ${url}`);
  }
  return found;
}

describe('package exports', () => {
  it('declares exactly the six subpaths, each with types and a default', () => {
    assert.deepEqual(
      Object.keys(manifest.exports).filter((key) => key !== './package.json'),
      SUBPATHS,
    );
    for (const subpath of SUBPATHS) {
      const target = manifest.exports[subpath];
      assert.ok(typeof target === 'object', subpath);
      assert.ok(existsSync(`${packageRoot}${target.types}`), `${subpath} types`);
      assert.ok(existsSync(`${packageRoot}${target.default}`), `${subpath} default`);
    }
  });

  it('resolves every subpath through the package name to its built barrel', () => {
    for (const subpath of SUBPATHS) {
      const target = manifest.exports[subpath];
      assert.ok(typeof target === 'object');
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      assert.equal(
        fileURLToPath(import.meta.resolve(specifier)),
        fileURLToPath(new URL(target.default, `file://${packageRoot}`)),
      );
    }
  });
});

// Each graph test waits on its own child process and shares no state with
// the others, so a few overlap instead of one cold start after another.
describe('browser-safe entries', { concurrency: SPAWN_CONCURRENCY }, () => {
  for (const specifier of ['@jsails/ai', '@jsails/ai/client']) {
    it(`${specifier} loads no node:*, SDK, or server-only module`, async () => {
      const graph = await moduleGraph(specifier);
      assert.ok(graph.length > 1, 'the recorder saw the graph');
      assert.deepEqual(violations(graph), []);
      // From the package itself, only zod and the browser-safe core entries.
      const bare = new Set(
        graph
          .filter(
            ({ specifier: name, parent }) =>
              !name.startsWith('.') &&
              !name.startsWith('file:') &&
              parent !== null &&
              parent.includes('/packages/ai/dist/src/'),
          )
          .map(({ specifier: name }) => name),
      );
      assert.ok(
        [...bare].every(
          (name) => name === 'zod' || name === 'jsails/support' || name === 'jsails/errors',
        ),
        [...bare].join(', '),
      );
    });
  }

  it('the recorder does flag a server entry', async () => {
    const graph = await moduleGraph('@jsails/ai/mcp');
    assert.ok(violations(graph).some((found) => found.startsWith('server subpath')));
  });

  it('leaves out only what a dependency maps away for browsers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-ai-browser-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'dep', browser: { './fallback.js': false } }),
      );
      const index = pathToFileURL(join(dir, 'index.js')).href;
      const fallback = pathToFileURL(join(dir, 'fallback.js')).href;
      const graph: Resolution[] = [
        { specifier: './fallback', parent: index, url: fallback },
        { specifier: 'util', parent: fallback, url: 'node:util' },
        { specifier: 'fs', parent: index, url: 'node:fs' },
      ];
      assert.deepEqual(violations(graph), ['builtin fs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
