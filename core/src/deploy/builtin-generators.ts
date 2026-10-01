/**
 * Built-in deploy-generator adapters.
 *
 * Each adapter wraps a pure generator without changing it: the underlying
 * function still owns validation and option defaults. The adapter only checks
 * that the input is a plain object (an unknown caller may pass anything), then
 * maps the generator's string fields onto portable relative file paths.
 *
 * Local backing services (databases, Valkey) are not generators: `jamal dev`
 * plans them into `.jamal/compose.yml` from `jamal.config.js` (see
 * `jamal/compose.ts`).
 *
 * File-path choices follow the field semantics:
 * - ONCE emits the app image build (`Dockerfile.once` + `.dockerignore`) and a
 *   `jsails.once.js` config wrapper, the Basecamp ONCE deployment preset.
 * - The server-hardening generator emits a single `config/harden-server.sh` UFW
 *   script (reviewed and run by a human; never executed by JSails).
 * - The four static-hosting generators emit a single config each — `vercel.json`,
 *   `netlify.toml`, `wrangler.toml`, and the GitHub Pages workflow — so a
 *   static export can ship to a static host instead of a container.
 */

import { generateOnceConfig, type OnceConfigOptions } from './once-config.js';
import { generateServerHardeningConfig, type ServerHardeningOptions } from './hardening-config.js';
import {
  generateCloudflarePagesConfig,
  generateGitHubPagesConfig,
  generateNetlifyStaticConfig,
  generateVercelStaticConfig,
  type CloudflarePagesOptions,
} from './hosting-config.js';
import type { DeploymentGenerator } from './registry.js';
import { isPlainObject } from '../json/shape.js';

/** Deterministic built-in generator ids, in registration order. */
export const BUILTIN_DEPLOYMENT_GENERATOR_IDS = [
  'once',
  'harden-server',
  'vercel-static',
  'netlify-static',
  'cloudflare-pages',
  'github-pages',
] as const;

/** A built-in generator id. */
export type BuiltinDeploymentGeneratorId = (typeof BUILTIN_DEPLOYMENT_GENERATOR_IDS)[number];

/**
 * Read a generator input as a plain options object. Only the container shape
 * is checked here; every field is validated by the wrapped generator, which
 * also applies its own defaults. `undefined` becomes `{}` so a built-in can be
 * generated with no argument.
 */
function asOptions<T extends object>(input: unknown): T {
  if (input === undefined) return {} as unknown as T;
  if (!isPlainObject(input)) {
    throw new TypeError('deployment generator input must be a plain object');
  }
  return input as unknown as T;
}

const onceGenerator: DeploymentGenerator<unknown> = {
  name: 'once',
  generate(input: unknown) {
    const { dockerfile, dockerignore, jsailsConfig } = generateOnceConfig(
      asOptions<OnceConfigOptions>(input),
    );
    return {
      files: {
        'Dockerfile.once': dockerfile,
        '.dockerignore': dockerignore,
        'jsails.once.js': jsailsConfig,
      },
    };
  },
};

const hardenServerGenerator: DeploymentGenerator<unknown> = {
  name: 'harden-server',
  generate(input: unknown) {
    const { script } = generateServerHardeningConfig(asOptions<ServerHardeningOptions>(input));
    return {
      files: {
        'config/harden-server.sh': script,
      },
    };
  },
};

const vercelStaticGenerator: DeploymentGenerator<unknown> = {
  name: 'vercel-static',
  generate(input: unknown) {
    const { vercelJson } = generateVercelStaticConfig(asOptions(input));
    return { files: { 'vercel.json': vercelJson } };
  },
};

const netlifyStaticGenerator: DeploymentGenerator<unknown> = {
  name: 'netlify-static',
  generate(input: unknown) {
    const { netlifyToml } = generateNetlifyStaticConfig(asOptions(input));
    return { files: { 'netlify.toml': netlifyToml } };
  },
};

const cloudflarePagesGenerator: DeploymentGenerator<unknown> = {
  name: 'cloudflare-pages',
  generate(input: unknown) {
    const { wranglerToml, headers } = generateCloudflarePagesConfig(
      asOptions<CloudflarePagesOptions>(input),
    );
    return { files: { 'wrangler.toml': wranglerToml, _headers: headers } };
  },
};

const githubPagesGenerator: DeploymentGenerator<unknown> = {
  name: 'github-pages',
  generate(input: unknown) {
    const { workflow, nojekyll } = generateGitHubPagesConfig(asOptions(input));
    return {
      files: {
        '.github/workflows/pages.yml': workflow,
        '.nojekyll': nojekyll,
      },
    };
  },
};

/** Built-in adapters in deterministic registration order. */
export const BUILTIN_DEPLOYMENT_GENERATORS: readonly DeploymentGenerator<unknown>[] = Object.freeze(
  [
    onceGenerator,
    hardenServerGenerator,
    vercelStaticGenerator,
    netlifyStaticGenerator,
    cloudflarePagesGenerator,
    githubPagesGenerator,
  ],
);
