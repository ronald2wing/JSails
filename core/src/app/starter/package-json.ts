/**
 * Generated `package.json` rewriting for the starter scaffold.
 *
 * `buildPackageJson` rewrites the bundled `package.json.template` in place: it
 * sets the validated project name and the resolved `jsails` dependency, then
 * merges the extra runtime dependencies and npm scripts. The template is
 * JSON-parsed and re-stringified; nothing is executed.
 */

/**
 * The Node flags that load the app's `.env` files into a plain `node` script.
 * `auth:migrate` and `user:create` import `@jsails/auth` directly instead of
 * going through the `jsails` CLI (which assembles the environment itself), so
 * without these flags a variable kept only in `.env` would be missing. Node
 * never overrides a real environment variable with a file value, and a later
 * file wins over an earlier one, matching the CLI's precedence for these two
 * files.
 */
export const ENV_FILE_FLAGS = '--env-file-if-exists=.env --env-file-if-exists=.env.local';

/** Extra npm scripts always merged into `package.json`. */
export const EXTRA_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  'auth:migrate': `node ${ENV_FILE_FLAGS} scripts/auth-migrate.mjs`,
  'db:push': 'node scripts/db-push.mjs',
  'user:create': `node ${ENV_FILE_FLAGS} scripts/create-user.mjs`,
});

/**
 * Rewrite the parsed package template: set the validated name and the resolved
 * `jsails` dependency, then merge the extra dependencies and scripts. The
 * template is JSON-parsed and re-stringified; nothing is executed.
 */
export function buildPackageJson(
  template: string,
  name: string,
  dependency: string,
  extraScripts: Readonly<Record<string, string>> = EXTRA_SCRIPTS,
  extraDependencies: Readonly<Record<string, string>> = {},
): string {
  const parsed = JSON.parse(template) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  parsed.name = name;
  if (parsed.dependencies !== undefined) {
    parsed.dependencies['jsails'] = dependency;
  }
  parsed.dependencies ??= {};
  Object.assign(parsed.dependencies, extraDependencies);
  parsed.scripts ??= {};
  Object.assign(parsed.scripts, extraScripts);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
