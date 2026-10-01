/**
 * Every first-party package that carries a `jsails` field ships a valid v1
 * manifest, and that static manifest agrees with the plugin its code declares.
 * This is the one manifest/runtime agreement gate, for both plugin contracts.
 *
 * The manifest is checked by the framework's own parser (`core/dist`), so the
 * gate and the runtime cannot disagree on what v1 means. The package's plugin
 * is the one `definePlugin` call in its `src/`, and the module that call
 * imports `definePlugin` from decides how agreement is read:
 *
 * - A plugin on the kernel contract (`jsails/kernel`) is read from its runtime
 *   definition in the built module, never from its source, so a lazy setup or
 *   schema module is no blind spot: the module exports a factory named after
 *   the package, its env declarations equal `jsails.env` exactly (name, kind,
 *   required, generate), it contributes a `schema` slot exactly when the
 *   manifest declares `jsails.schema`, and a plugin that provides services
 *   declares `services.provide`. Its services are its definition's literal
 *   `requires`/`provides` lists, or, when a list is computed from the
 *   options, those of its zero-config instance (`factory()`). A plugin that
 *   needs options has no such instance: its computed `requires` then names
 *   no unconditional dependency, and a computed `provides` cannot be read,
 *   which fails.
 * - A legacy `JsailsPlugin` (`jsails/extensions`) has no static descriptor,
 *   so its source is read: the `definePlugin({ ... })` call gives the plugin
 *   name, whether it owns tables (`schema.entities`; tables another migrator
 *   owns, `schema.unmanagedTables`, are not ownership), and the setup-context
 *   capabilities its `setup` destructures. A context object whose methods
 *   the capability gate checks one by one (`routes`, `interceptorRegistry`)
 *   counts as the methods called on it (`routes.transform`), in `setup` and,
 *   when `setup` hands the object on, on every binding the package types
 *   with its type (`HttpRoutes`); a `setup` that hands it on where no such
 *   binding exists fails, since its calls cannot be read. Each such
 *   capability, a `readiness` field, `services.provide(...)`, and a
 *   `replace: true` provide require the permission the setup-context
 *   capability gate demands for it (the gate's table is keyed by the same
 *   context paths), so a manifest can never under-declare what activating
 *   the plugin through the gated path would refuse, nor be pushed to declare
 *   a permission for a method it never calls. Every declared environment variable must be
 *   read somewhere in the package source. Its services are the identifiers
 *   of a literal `requires: [...]` and of each `services.provide(...)` in its
 *   setup, resolved to the token objects they name (an import, or an export
 *   of the plugin's own built module); an identifier that names no token
 *   fails.
 *
 * For both contracts, a service the plugin requires that another first-party
 * plugin provides makes that plugin a dependency the manifest's `plugins`
 * must name, with a range its version satisfies, so `jsails plugins check`
 * reports it missing and an uninstall of it is refused while the dependent
 * stays. Providers are keyed by token object, never by the name a source
 * happens to import it under, so a kernel provider (cache) and a legacy
 * consumer (config) meet on the same key.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'plugin-manifests';
export const description =
  'every first-party jsails manifest is v1 and agrees with its runtime plugin declaration';
export const needsBuild = true;

/**
 * Remove line and block comments outside string and template literals, so a
 * documentation example is never read as code and a slash-star inside a
 * string (a glob, a route pattern) never swallows the code after it.
 */
export function stripComments(text) {
  let out = '';
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end - 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}

/**
 * Split the body of the object literal that starts at `open` (a `{`) into its
 * top-level entries, skipping strings, template literals, and nested brackets.
 * Returns the entries and the index after the closing brace.
 */
export function topLevelEntries(text, open) {
  const entries = [];
  let depth = 0;
  let start = open + 1;
  let quote;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const last = text.slice(start, index).trim();
        if (last !== '') entries.push(last);
        return { entries, end: index + 1 };
      }
    } else if (char === ',' && depth === 1) {
      entries.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return { entries, end: text.length };
}

/** Import sources of the kernel's `definePlugin`. */
const KERNEL_SOURCES = [
  /^jsails\/kernel$/,
  /\/plugins\/contract\/define-plugin\.js$/,
  /\/kernel\/index\.js$/,
];

/** Import sources of the legacy identity helper. */
const LEGACY_SOURCES = [
  /^jsails$/,
  /^jsails\/extensions$/,
  /\/extensions\/plugin-contract\.js$/,
  /\/extensions\/index\.js$/,
];

/**
 * How a source file declares plugins: `undefined` when it calls no
 * `definePlugin`, else `{ contract: 'kernel' | 'legacy' }`, or `{ error }`
 * when `definePlugin` comes from anywhere else.
 */
export function classifyDeclaration(source) {
  const code = stripComments(source);
  if (!/(?<!function\s+)\bdefinePlugin\s*[(<]/.test(code)) return undefined;
  const imports = [
    ...code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g),
  ].filter(([, names]) =>
    names.split(',').some((part) => part.trim().split(/\s+as\s+/)[0] === 'definePlugin'),
  );
  if (imports.length !== 1) {
    return { error: 'calls definePlugin without one import of it' };
  }
  const specifier = imports[0][2];
  if (KERNEL_SOURCES.some((pattern) => pattern.test(specifier))) return { contract: 'kernel' };
  if (LEGACY_SOURCES.some((pattern) => pattern.test(specifier))) return { contract: 'legacy' };
  return { error: `imports definePlugin from ${specifier}, which is neither contract` };
}

/** The built module of a repo-relative source file: `<workspace>/dist/src/<path>.js`. */
export function builtModule(file) {
  const match = /^(core|packages\/[^/]+)\/src\/(.+)\.tsx?$/.exec(file);
  return match === null ? undefined : `${match[1]}/dist/src/${match[2]}.js`;
}

/** Order-insensitive text of env declarations, for comparison. */
function envKey(variables) {
  return variables
    .map((variable) =>
      [variable.name, variable.kind, Boolean(variable.required), Boolean(variable.generate)].join(
        ':',
      ),
    )
    .sort()
    .join(',');
}

/**
 * Failure messages for a kernel plugin's runtime definition against its
 * package manifest (`manifest`, already parsed with defaults), with
 * `describeEnv` the framework's `describePluginEnv`.
 */
export function checkAgreement({ label, definition, manifest, describeEnv }) {
  const failures = [];
  const env = definition.env === undefined ? [] : describeEnv(definition.name, definition.env);
  if (envKey(env) !== envKey(manifest.env ?? [])) {
    failures.push(`${label}: the plugin's env declarations differ from jsails.env`);
  }
  const ownsSchema = definition.contributes.includes('schema');
  if (ownsSchema !== (manifest.schema !== undefined)) {
    failures.push(
      ownsSchema
        ? `${label}: the plugin contributes a schema but the manifest declares none`
        : `${label}: the manifest declares a schema but the plugin contributes none`,
    );
  }
  if (definition.providesServices && !manifest.permissions.includes('services.provide')) {
    failures.push(`${label}: the plugin provides services but the manifest lacks services.provide`);
  }
  return failures;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The setup-context objects whose methods the capability gate checks one by
 * one, each with the type a binding of it is declared with when a plugin
 * hands it to a helper.
 */
const GATED_OBJECTS = Object.freeze({
  routes: 'HttpRoutes',
  interceptorRegistry: 'InterceptorRegistry',
});

/** `text` with every regular-expression metacharacter escaped. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The methods called on the identifier `local` in `text` (`local.method(` or
 * `local?.method(`), and whether `local` also appears other than as such a
 * call, which hands the object on where these calls cannot see it.
 */
export function memberCalls(text, local) {
  const name = escapeRegExp(local);
  const calls = [
    ...text.matchAll(
      new RegExp(`(?<![\\w$.])${name}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'),
    ),
  ];
  const uses = text.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g'))?.length ?? 0;
  return { methods: new Set(calls.map((match) => match[1])), escapes: uses > calls.length };
}

/** The names `text` declares with the type `type` (`name: Type`, `name?: Type`). */
export function typedBindings(text, type) {
  const pattern = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*${escapeRegExp(type)}(?![\\w$<.])`,
    'g',
  );
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];
}

/**
 * The capabilities one destructured context binding stands for: its name, or
 * for a {@link GATED_OBJECTS} entry the `name.method` path of each method
 * called on it, or `{ error }` when `setup` hands it on and no binding in
 * `packageText` carries its type.
 */
function bindingCapabilities({ name, local }, body, packageText) {
  if (!Object.hasOwn(GATED_OBJECTS, name)) return [name];
  const { methods, escapes } = memberCalls(body, local);
  if (escapes) {
    const receivers = typedBindings(packageText, GATED_OBJECTS[name]);
    if (receivers.length === 0) {
      return {
        error:
          `setup hands ${name} on, and no binding typed ${GATED_OBJECTS[name]} ` +
          'shows the calls made on it',
      };
    }
    for (const receiver of receivers) {
      for (const method of memberCalls(packageText, receiver).methods) methods.add(method);
    }
  }
  return [...methods].sort().map((method) => `${name}.${method}`);
}

/**
 * What a package's source declares about its plugin: `{ name, schema,
 * capabilities, readiness, provides, replaces, requires, provided }`, or
 * `{ error }`. `capabilities` are setup-context paths (see
 * {@link bindingCapabilities}); `packageSource`, the package's whole source,
 * is where a context object `setup` hands on is followed. `requires` lists
 * the identifiers of a literal `requires` array (a computed one is
 * conditional, so it names no unconditional dependency), and `provided` the
 * tokens its `setup` passes to `services.provide`.
 */
export function analyzePluginSource(source, packageSource = source) {
  const text = stripComments(source);
  const calls = [...text.matchAll(/\bdefinePlugin\(\s*\{/g)];
  if (calls.length !== 1) {
    return { error: `expected one definePlugin({ ... }) call in src/, found ${calls.length}` };
  }
  const open = calls[0].index + calls[0][0].length - 1;
  const { entries } = topLevelEntries(text, open);
  const key = (entry) => /^(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(entry)?.[1];

  const nameEntry = entries.find((entry) => key(entry) === 'name');
  const nameMatch = nameEntry === undefined ? null : /^name:\s*'([^']+)'$/.exec(nameEntry);
  if (nameMatch === null) return { error: 'the plugin name is not a string literal' };

  const schemaEntries = entries.filter(
    (entry) => key(entry) === 'schema' || (entry.startsWith('...') && /\bschema:/.test(entry)),
  );
  const schema = schemaEntries.some((entry) => /\bentities\b/.test(entry))
    ? 'entities'
    : schemaEntries.length > 0
      ? 'unmanaged'
      : undefined;

  const setupEntry = entries.find((entry) => key(entry) === 'setup');
  let capabilities = [];
  if (setupEntry !== undefined) {
    const params = /^(?:async\s+)?setup\s*\(\s*(\{[^}]*\})?\s*(\)?)/.exec(setupEntry);
    if (params === null || (params[1] === undefined && params[2] !== ')')) {
      return { error: 'setup must destructure its context so its capabilities can be read' };
    }
    const body = setupEntry.slice(params[0].length);
    const packageText = stripComments(packageSource);
    const bindings = (params[1] ?? '{}')
      .slice(1, -1)
      .split(',')
      .map((part) => {
        const [name, local = name] = part.split(':').map((side) => side.split('=')[0].trim());
        return { name, local };
      })
      .filter((binding) => binding.name !== '');
    for (const binding of bindings) {
      const found = bindingCapabilities(binding, body, packageText);
      if (!Array.isArray(found)) return found;
      capabilities.push(...found);
    }
  }
  const requiresEntry = entries.find((entry) => key(entry) === 'requires');
  const requiresList =
    requiresEntry === undefined ? null : /^requires:\s*\[([^\]]*)\]$/.exec(requiresEntry);
  return {
    name: nameMatch[1],
    schema,
    capabilities,
    readiness: entries.some((entry) => key(entry) === 'readiness'),
    provides: setupEntry !== undefined && /\bservices\.provide\(/.test(setupEntry),
    replaces: setupEntry !== undefined && /\breplace:\s*true\b/.test(setupEntry),
    requires: (requiresList?.[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => IDENTIFIER.test(part)),
    provided:
      setupEntry === undefined
        ? []
        : [...setupEntry.matchAll(/\bservices\.provide\(\s*([A-Za-z_$][\w$]*)/g)].map(
            (match) => match[1],
          ),
  };
}

/**
 * The value-named imports of a source file: local name to `{ specifier,
 * imported }`. Type-only imports name no runtime value and are left out.
 */
export function valueImports(source) {
  const imports = new Map();
  const code = stripComments(source);
  for (const [, clause, names, specifier] of code.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (clause !== undefined) continue;
    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '' || trimmed.startsWith('type ')) continue;
      const [imported, local = imported] = trimmed.split(/\s+as\s+/).map((name) => name.trim());
      imports.set(local, { specifier, imported });
    }
  }
  return imports;
}

/** Whether `value` is a service token (`createServiceToken`'s frozen record). */
function isServiceToken(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    typeof value.live === 'boolean' &&
    'key' in value
  );
}

/**
 * The token objects a legacy plugin's identifiers name: `{ requires,
 * provides, unresolved }`. `imports` is {@link valueImports} of the plugin's
 * source, `load(specifier)` resolves an import to its module namespace (or
 * `undefined`), and `own` is the namespace of the plugin's own built module,
 * for a token it declares itself.
 */
export async function resolveLegacyServices({ analysis, imports, load, own }) {
  const unresolved = [];
  const resolveAll = async (identifiers) => {
    const tokens = [];
    for (const identifier of identifiers) {
      const imported = imports.get(identifier);
      const module = imported === undefined ? own : await load(imported.specifier);
      const value = module?.[imported === undefined ? identifier : imported.imported];
      if (isServiceToken(value)) tokens.push(value);
      else if (!unresolved.includes(identifier)) unresolved.push(identifier);
    }
    return [...new Set(tokens)];
  };
  return {
    requires: await resolveAll(analysis.requires),
    provides: await resolveAll(analysis.provided),
    unresolved,
  };
}

/**
 * The services of a kernel plugin's factory: `{ requires, provides }` token
 * objects, or `{ error }`. A literal list comes from the definition; a
 * computed one from the zero-config instance, so the tokens a plugin needs
 * or offers with no options at all are what the dependency rule reads.
 *
 * A plugin that refuses to be configured without options
 * (`config.invalid_options`) has no such instance, and the two lists are then
 * read in the direction the dependency rule needs. Its computed `requires`
 * names no unconditional dependency, since every token in it depends on
 * options the app chooses (the rule the legacy source reader applies to a
 * computed list), so the gate never pushes a plugin to accept a configuration
 * it should refuse just to be read. A computed `provides` cannot be read that
 * way: another plugin's unconditional requirement may rest on it, so that
 * plugin fails, and so does a factory that throws anything else.
 */
export function kernelServices(factory) {
  const { definition } = factory;
  if (definition.requires !== undefined && definition.provides !== undefined) {
    return { requires: definition.requires, provides: definition.provides };
  }
  let instance;
  try {
    instance = factory();
  } catch (error) {
    if (error?.code === 'config.invalid_options' && definition.provides !== undefined) {
      return { requires: definition.requires ?? [], provides: definition.provides };
    }
    return {
      error:
        'the plugin computes its services from options it cannot do without, ' +
        'so its dependencies cannot be read',
    };
  }
  return {
    requires: definition.requires ?? instance.requires,
    provides: definition.provides ?? instance.provides,
  };
}

/**
 * Which first-party plugin provides each service token, from `packages`
 * (`{ dir, pkg, services }` each, `services.provides` the token objects):
 * token object to `{ dir, id, version }`, or `null` when more than one
 * provides it (either satisfies a requirement, so neither is a dependency).
 */
export function serviceProviders(packages) {
  const providers = new Map();
  for (const { dir, pkg, services } of packages) {
    for (const token of services?.provides ?? []) {
      const provider = { dir, id: pkg.jsails.id, version: pkg.jsails.version };
      providers.set(token, providers.has(token) ? null : provider);
    }
  }
  return providers;
}

/**
 * Failure messages for the plugin dependencies of one package: each service
 * it requires (`services.requires`, token objects) that another first-party
 * plugin provides must be named in the manifest's `plugins` with a range the
 * provider's version satisfies.
 */
function checkDependencies({ label, dir, manifest, services, providers, satisfies }) {
  const failures = [];
  const dependencies = manifest.plugins ?? [];
  for (const token of services?.requires ?? []) {
    const provider = providers.get(token);
    if (provider === undefined || provider === null || provider.dir === dir) continue;
    const dependency = dependencies.find((each) => each.id === provider.id);
    if (dependency === undefined) {
      failures.push(
        `${label}: the plugin requires ${token.name}, which packages/${provider.dir} provides, ` +
          `but the manifest's plugins do not name ${provider.id}`,
      );
    } else if (!satisfies(provider.version, dependency.range)) {
      failures.push(
        `${label}: the manifest requires ${provider.id} ${dependency.range}, ` +
          `which its version ${provider.version} does not satisfy`,
      );
    }
  }
  return failures;
}

/** The permissions a source analysis requires, given the capability gate's table. */
export function requiredPermissions(analysis, capabilityPermissions) {
  const required = new Set();
  for (const capability of analysis.capabilities) {
    const permission = capabilityPermissions[capability];
    if (permission !== undefined) required.add(permission);
  }
  if (analysis.readiness) required.add(capabilityPermissions.readiness);
  if (analysis.replaces) required.add(capabilityPermissions.replaceService);
  if (analysis.provides) required.add('services.provide');
  return [...required].sort();
}

/**
 * Failure messages for one package: `dir` (its directory name), `pkg` (its
 * package.json), `pluginSource` (the file that declares the plugin), `source`
 * (its whole src/ text, for the env check), `check` (the
 * framework's checkPluginManifest), `capabilityPermissions` (the
 * capability gate's table), `services` (the package's own `{ requires,
 * provides }` token objects, with `unresolved` legacy identifiers or an
 * `error`), `providers` ({@link serviceProviders}), `satisfies(version,
 * range)` (the framework's semver check), and for a kernel plugin
 * `definition` (the runtime definition of the built module's factory named
 * after the package, or `undefined` when it exports none) and `describeEnv`
 * (the framework's describePluginEnv).
 */
export function checkPackage({
  dir,
  pkg,
  pluginSource,
  source,
  check,
  capabilityPermissions,
  services,
  providers = new Map(),
  satisfies = () => true,
  definition,
  describeEnv,
}) {
  const label = `packages/${dir}`;
  const result = check(pkg.jsails, 'package');
  if (!result.ok) {
    return result.issues.map(
      (issue) => `${label}: jsails.${issue.path.join('.') || '(manifest)'}: ${issue.message}`,
    );
  }
  const manifest = result.manifest;
  const failures = [];
  if (pkg.name !== `@jsails/${dir}`) failures.push(`${label}: package name is not @jsails/${dir}`);
  if (manifest.id !== `jsails-${dir}`) failures.push(`${label}: manifest id is not jsails-${dir}`);
  if (manifest.publisher !== 'jsails') failures.push(`${label}: publisher is not jsails`);
  if (manifest.version !== pkg.version) {
    failures.push(`${label}: manifest version differs from the package version`);
  }
  if (services?.error !== undefined) failures.push(`${label}: ${services.error}`);
  for (const identifier of services?.unresolved ?? []) {
    failures.push(`${label}: ${identifier} names no service token the gate can resolve`);
  }
  const dependencyFailures = () =>
    checkDependencies({ label, dir, manifest, services, providers, satisfies });

  if (classifyDeclaration(pluginSource)?.contract === 'kernel') {
    if (definition === undefined) {
      return [...failures, `${label}: exports no definePlugin factory named "${dir}"`];
    }
    return [
      ...failures,
      ...checkAgreement({ label, definition, manifest, describeEnv }),
      ...dependencyFailures(),
    ];
  }

  const analysis = analyzePluginSource(pluginSource, source);
  if (analysis.error !== undefined) return [...failures, `${label}: ${analysis.error}`];
  if (analysis.name !== dir) {
    failures.push(`${label}: definePlugin name "${analysis.name}" is not "${dir}"`);
  }
  if (analysis.schema === 'entities' && manifest.schema === undefined) {
    failures.push(`${label}: the plugin declares schema entities but the manifest has no schema`);
  }
  if (analysis.schema !== 'entities' && manifest.schema !== undefined) {
    failures.push(`${label}: the manifest declares schema but the plugin owns no entities`);
  }
  const declared = new Set(manifest.permissions);
  for (const permission of requiredPermissions(analysis, capabilityPermissions)) {
    if (!declared.has(permission)) {
      failures.push(
        `${label}: the plugin needs "${permission}" but the manifest does not declare it`,
      );
    }
  }
  for (const variable of manifest.env ?? []) {
    if (!new RegExp(`\\b${variable.name}\\b`).test(source)) {
      failures.push(`${label}: env ${variable.name} is declared but never read in src/`);
    }
  }
  return [...failures, ...dependencyFailures()];
}

/** Every `.ts`/`.tsx` file under `dir` as `{ path, text }`, in path order. */
function readSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/** The source files whose code, comments aside, calls `definePlugin`. */
function pluginCandidates(files) {
  return files.filter((file) => /\bdefinePlugin\(/.test(stripComments(file.text)));
}

/**
 * The one source file that declares the plugin (the file whose code, comments
 * aside, calls `definePlugin`), or every candidate when there is not exactly one.
 */
export function pluginSourceFile(files) {
  const candidates = pluginCandidates(files);
  return candidates.length === 1
    ? candidates[0].text
    : candidates.map((file) => file.text).join('\n');
}

/**
 * The plugin declaration of a package, its whole source text, and the path of
 * the declaring file when there is exactly one.
 */
function packageSources(dir) {
  const files = readSources(dir);
  const candidates = pluginCandidates(files);
  return {
    pluginSource: pluginSourceFile(files),
    pluginPath: candidates.length === 1 ? candidates[0].path : undefined,
    source: files.map((file) => file.text).join('\n'),
  };
}

/** The absolute path of the built module of `pluginPath`, or `undefined` when it is not built. */
function builtPath(repoRoot, pluginPath) {
  const built = builtModule(relative(repoRoot, pluginPath).split(sep).join('/'));
  return built === undefined || !existsSync(join(repoRoot, built))
    ? undefined
    : join(repoRoot, built);
}

/**
 * A loader of the modules a plugin's built module at `built` imports: a
 * relative specifier resolves beside it (`dist/` mirrors `src/`), a bare one
 * as the package at `packageDir` resolves it. A module that cannot be found
 * loads as `undefined`, so its identifiers fail as unresolved.
 */
function moduleLoader(built, packageDir) {
  const require = createRequire(join(packageDir, 'package.json'));
  return async (specifier) => {
    let path;
    try {
      path = specifier.startsWith('.')
        ? join(dirname(built), specifier)
        : require.resolve(specifier);
    } catch {
      // Unresolvable: the caller reports each identifier it should have named.
      return undefined;
    }
    return existsSync(path) ? import(pathToFileURL(path).href) : undefined;
  };
}

/** The services a package's plugin declares, read for the contract it is on. */
async function packageServices({ built, packageDir, pluginSource, source, factory }) {
  const kernel = classifyDeclaration(pluginSource)?.contract === 'kernel';
  if (kernel) return factory === undefined ? undefined : kernelServices(factory);
  const analysis = analyzePluginSource(pluginSource, source);
  if (analysis.error !== undefined) return undefined;
  if (built === undefined) {
    return { error: 'the plugin module is not built, so its services cannot be read' };
  }
  return resolveLegacyServices({
    analysis,
    imports: valueImports(pluginSource),
    load: moduleLoader(built, packageDir),
    own: await import(pathToFileURL(built).href),
  });
}

export async function run({ repoRoot }) {
  const dist = join(repoRoot, 'core', 'dist', 'src', 'plugins');
  const [
    { checkPluginManifest },
    { PLUGIN_CAPABILITY_PERMISSIONS },
    { isPluginFactory },
    { describePluginEnv },
    { satisfiesRange },
  ] = await Promise.all(
    [
      'manifest/index.js',
      'capability-gate.js',
      'contract/define-plugin.js',
      'contract/env-variables.js',
      'manifest/semver.js',
    ].map((path) => import(pathToFileURL(join(dist, path)).href)),
  );
  const packagesRoot = join(repoRoot, 'packages');
  const packages = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = join(packagesRoot, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (pkg.jsails === undefined) continue;
    const { pluginSource, pluginPath, source } = packageSources(
      join(packagesRoot, entry.name, 'src'),
    );
    const packageDir = join(packagesRoot, entry.name);
    const built = pluginPath === undefined ? undefined : builtPath(repoRoot, pluginPath);
    const kernel = built !== undefined && classifyDeclaration(pluginSource)?.contract === 'kernel';
    const factory = kernel
      ? Object.values(await import(pathToFileURL(built).href)).find(
          (value) => isPluginFactory(value) && value.definition.name === entry.name,
        )
      : undefined;
    packages.push({
      dir: entry.name,
      pkg,
      pluginSource,
      source,
      definition: factory?.definition,
      services: await packageServices({ built, packageDir, pluginSource, source, factory }),
    });
  }
  if (packages.length === 0) return ['no package under packages/ carries a jsails manifest'];
  const providers = serviceProviders(packages);
  return packages.flatMap((each) =>
    checkPackage({
      ...each,
      check: checkPluginManifest,
      capabilityPermissions: PLUGIN_CAPABILITY_PERMISSIONS,
      providers,
      satisfies: satisfiesRange,
      describeEnv: describePluginEnv,
    }),
  );
}
