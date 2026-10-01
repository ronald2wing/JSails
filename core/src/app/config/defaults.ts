/**
 * The application config's default values and environment overrides.
 *
 * Dependency-free on purpose: the CLI dispatcher, `jsails mcp`, and the
 * introspection commands name the default config path before they decide
 * whether to load a config at all, and importing it from the Zod schema would
 * load Zod into every `jsails --help`.
 */

/** Default config module name, resolved against the working directory. */
export const DEFAULT_APP_CONFIG_PATH = 'jsails.app.js';
/** Default listen host. */
export const DEFAULT_APP_HOST = '127.0.0.1';
/** Default listen port. `0` is a valid, explicitly requested ephemeral port. */
export const DEFAULT_APP_PORT = 3000;
/**
 * Environment variable that overrides the config's listen host when the
 * config is loaded from a file. A container sets it to bind every interface
 * without editing the app's config.
 */
export const APP_HOST_ENV = 'JSAILS_HOST';
/** Environment variable that overrides the config's listen port (file-loaded configs). */
export const APP_PORT_ENV = 'JSAILS_PORT';
/** Default pages directory, relative to `rootDir`. */
export const DEFAULT_APP_PAGES_DIR = 'pages';
/** Default API directory, relative to `rootDir`. */
export const DEFAULT_APP_API_DIR = 'api';
/** Default static-assets directory, relative to `rootDir`. */
export const DEFAULT_APP_PUBLIC_DIR = 'public';
/** Default build output directory, relative to `rootDir`. */
export const DEFAULT_APP_OUT_DIR = 'out';
/** Default persistent-storage directory, relative to `rootDir`. */
export const DEFAULT_APP_STORAGE_DIR = 'storage';
/** Default health endpoint path. */
export const DEFAULT_HEALTH_PATH = '/up';
/** Default shutdown grace period in milliseconds before lingering sockets are dropped. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
/** Upper bound on the shutdown grace period in milliseconds. */
export const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;
