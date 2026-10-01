/**
 * The child process of the loaded-set collector (`loaded-set.mjs`): it
 * registers synchronous module hooks before anything else loads, runs one
 * target, and on exit writes every module URL the process loaded, plus the
 * importer of each, to a JSON file.
 *
 * The hooks are `module.registerHooks` resolve and load hooks, which see ESM
 * `import`, a dynamic `import()` and CommonJS `require` alike, so a CommonJS
 * package (typeorm, bullmq) is counted module by module and an eager dynamic
 * import is as visible as a static one.
 *
 * Usage: node probe.mjs <out.json> import <file-url>
 *        node probe.mjs <out.json> main <file-path> [...argv]   run a CLI entry as the main module
 *        node probe.mjs <out.json> scenario <file-url> [...args] await the module's default export
 */
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const [outFile, mode, target, ...rest] = process.argv.slice(2);

const loaded = new Set();
const importers = new Map();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (context.parentURL !== undefined && !importers.has(result.url)) {
      importers.set(result.url, context.parentURL);
    }
    return result;
  },
  load(url, context, nextLoad) {
    loaded.add(url);
    return nextLoad(url, context);
  },
});

process.on('exit', () => {
  const record = [...loaded].map((url) => [url, importers.get(url) ?? null]);
  writeFileSync(outFile, JSON.stringify(record));
});

if (mode === 'import') {
  await import(target);
} else if (mode === 'main') {
  // A CLI entry (the `jsails` bin) runs when it is loaded, reading `process.argv`.
  process.argv = [process.execPath, target, ...rest];
  await import(pathToFileURL(target).href);
} else if (mode === 'scenario') {
  const scenario = await import(target);
  await scenario.default(rest);
} else {
  throw new Error(`probe: unknown mode ${mode}`);
}
