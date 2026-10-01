/**
 * `@jsails/database/model` is offline code: importing it, in a fresh
 * process, resolves no `typeorm` module, so build tools and the
 * schema-portability gate can load model specs without the ORM. A control
 * import of `typeorm` itself proves the probe sees CommonJS loads.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// The compiled test runs from dist/test/model; the package root is three up.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every module URL a fresh process resolves while importing `specifier`. */
function resolvedModules(specifier: string): string[] {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({
      resolve(specifier, context, next) {
        const result = next(specifier, context);
        seen.push(result.url);
        return result;
      },
    });
    await import(${JSON.stringify(specifier)});
    process.stdout.write(JSON.stringify(seen));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(output) as string[];
}

const TYPEORM_MODULE = /[\\/]node_modules[\\/]typeorm[\\/]/;

describe('@jsails/database/model', () => {
  it('loads no typeorm module', () => {
    const modules = resolvedModules('@jsails/database/model');
    assert.ok(
      modules.some((url) => url.includes('/dist/src/model/index.js')),
      'the subpath resolved to the model barrel',
    );
    assert.deepEqual(
      modules.filter((url) => TYPEORM_MODULE.test(url)),
      [],
    );
  });

  it('would see typeorm if it were loaded', () => {
    const modules = resolvedModules('typeorm');
    assert.ok(modules.filter((url) => TYPEORM_MODULE.test(url)).length > 1);
  });
});
