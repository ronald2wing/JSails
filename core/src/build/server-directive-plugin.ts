/**
 * The `'use server'` Vite/Rolldown plugin: a thin `transform` wrapper over the
 * pure {@link stripServerDirectives} rewrite.
 *
 * Construction is inert and bundler-agnostic: the returned object is
 * structurally compatible with any bundler exposing an `enforce`/`transform`
 * hook pair, and imports no bundler code. It runs `enforce: 'pre'` so the strip
 * happens before any other transform sees the server bodies, and only on client
 * builds — the server build keeps the real implementations.
 *
 * Pair it with `cleanBundlePlugin`: this transform reduces a `'use server'`
 * module to throwing stubs and refuses a function-level directive;
 * `cleanBundlePlugin` is the belt-and-suspenders assertion that a `*.server.*`
 * module never reaches a client chunk at all.
 */

import {
  ServerDirectiveError,
  stripServerDirectives,
  type ServerDirectiveSourceMap,
} from './server-directive.js';

/** Options for {@link serverDirectivePlugin}. */
export interface ServerDirectivePluginOptions {
  /**
   * Extensions the transform applies to. Defaults to every TypeScript and
   * JavaScript module extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.mtsx`, `.js`,
   * `.jsx`, `.mjs`, `.cjs`), so a directive in any module the bundler can load
   * is honored or refused, never skipped.
   */
  readonly include?: readonly string[];
  /**
   * When `true`, the transform is skipped entirely (e.g. a server build that
   * must keep the real bodies). Defaults to `false` so a client build is safe
   * unless it explicitly opts out.
   */
  readonly server?: boolean;
}

/** The subset of the bundler's output options the source-map guard reads. */
export interface ServerDirectiveOutputOptions {
  readonly sourcemap?: boolean | 'inline' | 'hidden' | null;
  readonly sourcemapExcludeSources?: boolean | null;
}

const DEFAULT_INCLUDE = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mtsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** The synthetic id Vite passes for CSS/asset requests that must never be parsed. */
const CSS_QUERY = /\.(css|scss|sass|less|styl)(\?|$)/i;

/** A dependency path segment: third-party code is not the app's server seam. */
const NODE_MODULES = /[/\\]node_modules[/\\]/;

/** True when `id` (a Vite module id, possibly with a query) matches one of the extensions. */
function applies(id: string, include: readonly string[]): boolean {
  if (CSS_QUERY.test(id)) {
    return false;
  }
  const clean = id.split('?')[0] ?? id;
  return !NODE_MODULES.test(clean) && include.some((extension) => clean.endsWith(extension));
}

/**
 * Build the plugin. `transform` returns `null` for a module without the
 * `'use server'` prologue so the bundler skips its own re-parse; otherwise it
 * returns the stub module and a map back to the original positions. A
 * function-level directive throws, failing the build. A module that cannot carry a directive
 * (the text `use server` appears nowhere in it) is never parsed.
 *
 * `renderStart` refuses a client build that emits source maps with embedded
 * sources while any module was stripped: the bundler embeds each module's
 * *original* text as `sourcesContent`, so the published `.map` would carry the
 * server bodies this plugin removed. Set `build.sourcemap: false` or
 * `sourcemapExcludeSources: true` for the client output.
 *
 * The stripped set is never cleared at build start: a watch rebuild reuses the
 * cached transform of an unchanged module, so `transform` does not run for it
 * again and a cleared set would let its original text into the next maps. An
 * id leaves the set only when it is transformed again without a directive.
 */
export function serverDirectivePlugin(options: ServerDirectivePluginOptions = {}): {
  name: string;
  enforce: 'pre';
  transform(
    code: string,
    id: string,
  ): { code: string; map: ServerDirectiveSourceMap | null } | null;
  renderStart(outputOptions: ServerDirectiveOutputOptions): void;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const isServer = options.server === true;
  const stripped = new Set<string>();

  return {
    name: 'jsails-use-server-directive',
    enforce: 'pre',
    transform(code, id) {
      if (isServer) {
        return null;
      }
      if (!applies(id, include) || !code.includes('use server')) {
        stripped.delete(id);
        return null;
      }
      const result = stripServerDirectives(code, id);
      if (!result.hadDirective) {
        stripped.delete(id);
        return null;
      }
      stripped.add(id);
      return { code: result.code, map: result.map };
    },
    renderStart(outputOptions) {
      const emitsSources =
        outputOptions.sourcemap !== undefined &&
        outputOptions.sourcemap !== null &&
        outputOptions.sourcemap !== false &&
        outputOptions.sourcemapExcludeSources !== true;
      if (isServer || !emitsSources || stripped.size === 0) {
        return;
      }
      throw new ServerDirectiveError(
        'unsupported_sourcemap',
        `client source maps would embed the original text of ${stripped.size} 'use server' module(s); disable build.sourcemap or set sourcemapExcludeSources for the client build`,
      );
    },
  };
}
