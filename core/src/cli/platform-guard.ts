/**
 * The platform scope of the `jsails` bin, stated in code: Windows is supported
 * for development (create, dev, build, test), not for production serving,
 * which refuses with a value-free `platform.unsupported_platform` error instead of
 * running degraded: production assumes POSIX signals, file modes, and process
 * groups. The deploy verbs state their own scope in `@jsails/jamal`.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const PLATFORM_ERRORS = {
  unsupported_platform: {
    kind: 'internal',
    message: 'jsails serve runs only the development and test environments on Windows',
    context: { platform: ['win32'] },
    suggestion:
      'serve locally as JSAILS_ENV=development (the default) or test; Windows is supported for development, so serve production from Linux or macOS (for example in a container)',
  },
} as const;

/** The platform scope's codes, `platform.*`: a command that does not run on this platform. */
export const PlatformErrors: ErrorRegistry<'platform', typeof PLATFORM_ERRORS> = defineErrors(
  'platform',
  PLATFORM_ERRORS,
);

/**
 * The `NODE_ENV` values `jsails serve` runs on Windows: local work only. They
 * are the two values the runtime itself treats as non-production (the
 * server-components signing key is minted and the dev reload runs only there);
 * an unset or empty `NODE_ENV` under `jsails serve` is production to the
 * runtime, so it is refused here too rather than served degraded.
 */
const WINDOWS_SERVE_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Throws `platform.unsupported_platform` when `jsails serve` would run on Windows with
 * a `NODE_ENV` other than exactly `development` or `test`. Both arguments are
 * required: a default would turn an explicitly unset `NODE_ENV` back into the
 * current process's value.
 */
export function assertServeSupported(platform: NodeJS.Platform, nodeEnv: string | undefined): void {
  if (platform !== 'win32') return;
  if (nodeEnv !== undefined && WINDOWS_SERVE_ENVIRONMENTS.has(nodeEnv)) return;
  throw new PlatformErrors.Error('unsupported_platform', { platform });
}
