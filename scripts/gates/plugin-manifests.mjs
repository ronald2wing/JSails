/**
 * Every first-party package that carries a `jsails` field ships a valid v1
 * manifest, and that static manifest agrees with the plugin its code declares.
 *
 * The manifest is checked by the framework's own parser (`core/dist`), so the
 * gate and the runtime cannot disagree on what v1 means. Agreement is read
 * from the package source until plugins carry a static descriptor: the one
 * `definePlugin({ ... })` call in the package's `src/` gives the plugin name,
 * whether it owns tables (`schema.entities`; tables another migrator owns,
 * `schema.unmanagedTables`, are not ownership), and the setup-context
 * capabilities its `setup` destructures. Each such capability, a `readiness`
 * field, `services.provide(...)`, and a `replace: true` provide require the
 * permission the setup-context capability gate demands for it, so a manifest
 * can never under-declare what activating the plugin through the gated path
 * would refuse. Every declared environment variable must be read somewhere in
 * the package source.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * What a package's source declares about its plugin: `{ name, schema,
 * capabilities, readiness, provides, replaces }`, or `{ error }`.
 */
export function analyzePluginSource(source) {
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
    capabilities = (params[1] ?? '{}')
      .slice(1, -1)
      .split(',')
      .map((part) => part.split(':')[0].trim())
      .filter((part) => part !== '');
  }
  return {
    name: nameMatch[1],
    schema,
    capabilities,
    readiness: entries.some((entry) => key(entry) === 'readiness'),
    provides: setupEntry !== undefined && /\bservices\.provide\(/.test(setupEntry),
    replaces: setupEntry !== undefined && /\breplace:\s*true\b/.test(setupEntry),
  };
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
 * framework's checkPluginManifest), and `capabilityPermissions` (the
 * capability gate's table).
 */
export function checkPackage({ dir, pkg, pluginSource, source, check, capabilityPermissions }) {
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

  const analysis = analyzePluginSource(pluginSource);
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
  return failures;
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

/**
 * The one source file that declares the plugin (the file whose code, comments
 * aside, calls `definePlugin`), or every candidate when there is not exactly one.
 */
export function pluginSourceFile(files) {
  const candidates = files.filter((file) => /\bdefinePlugin\(/.test(stripComments(file.text)));
  return candidates.length === 1
    ? candidates[0].text
    : candidates.map((file) => file.text).join('\n');
}

/** The plugin declaration file and the whole source text of a package. */
function packageSources(dir) {
  const files = readSources(dir);
  return {
    pluginSource: pluginSourceFile(files),
    source: files.map((file) => file.text).join('\n'),
  };
}

export async function run({ repoRoot }) {
  const dist = join(repoRoot, 'core', 'dist', 'src', 'plugins');
  const { checkPluginManifest } = await import(
    pathToFileURL(join(dist, 'manifest', 'index.js')).href
  );
  const { PLUGIN_CAPABILITY_PERMISSIONS } = await import(
    pathToFileURL(join(dist, 'capability-gate.js')).href
  );
  const packagesRoot = join(repoRoot, 'packages');
  const failures = [];
  let checked = 0;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = join(packagesRoot, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (pkg.jsails === undefined) continue;
    checked += 1;
    failures.push(
      ...checkPackage({
        dir: entry.name,
        pkg,
        ...packageSources(join(packagesRoot, entry.name, 'src')),
        check: checkPluginManifest,
        capabilityPermissions: PLUGIN_CAPABILITY_PERMISSIONS,
      }),
    );
  }
  if (checked === 0) failures.push('no package under packages/ carries a jsails manifest');
  return failures;
}
