/**
 * The activation mode's boundary, held over the shipped sources and the
 * plugin manifests of core and every package:
 *
 * - only the loader seals the mode, and only the plugin resolver reads it;
 * - only the plugin resolver mints a schema authority;
 * - no environment variable names the mode;
 * - no command that loads or runs an app takes a flag that names it. Only
 *   `jsails create` may, since a create flag chooses which literal the
 *   generated config states, not the mode of a running app;
 * - no settings schema offers it: no `@jsails/config` field, no JSON-schema
 *   settings property and no manifest setting is keyed by it, and no source
 *   but the app config schema lists its two values as a choice.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { BUILTIN_COMMANDS } from '../../src/cli/manifest.js';
import { toPosixId } from '../../src/support/project-paths.server.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** Every TypeScript source under core/src and packages/<name>/src, by repo-relative id. */
function sources(): ReadonlyMap<string, string> {
  const roots = [join(REPO, 'core', 'src')];
  const packages = join(REPO, 'packages');
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, 'src');
    if (existsSync(src)) roots.push(src);
  }
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) {
        files.set(toPosixId(relative(REPO, path)), readFileSync(path, 'utf8'));
      }
    }
  };
  for (const dir of roots) walk(dir);
  return files;
}

const SOURCES = sources();

function filesMatching(pattern: RegExp): string[] {
  return [...SOURCES].filter(([, text]) => pattern.test(text)).map(([id]) => id);
}

/** A name that names the mode: as a settings key, a flag or an option. */
const MODE_NAME = /activation|managed|plugins?[_-]?mode/i;

/** The two mode values listed together, as an enum, a choice or a schema `enum`. */
const MODE_CHOICE =
  /['"`]locked['"`]\s*,\s*['"`]managed['"`]|['"`]managed['"`]\s*,\s*['"`]locked['"`]/;

/** A quoted `--activation`, `--managed` or `--plugins-mode` in code. */
const MODE_FLAG = /['"`]--(?:activation|managed|plugins-mode)\b/;

/** The sources that implement `jsails create`, whose flags choose the literal a template writes. */
function isCreateSource(id: string): boolean {
  return (
    id === 'core/src/cli/commands/create.ts' ||
    id === 'core/src/cli/commands/create-git.ts' ||
    id === 'core/src/app/scaffold.ts' ||
    id.startsWith('core/src/app/starter/')
  );
}

interface Node {
  readonly type: string;
  readonly [field: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue;
    if (Array.isArray(value)) found.push(...value.filter(isNode));
    else if (isNode(value)) found.push(value);
  }
  return found;
}

function keyName(property: Node): string | undefined {
  if (property.type !== 'Property' || property['computed'] === true) return undefined;
  const key = property['key'] as Node;
  if (key.type === 'Identifier') return key['name'] as string;
  if (key.type === 'Literal' && typeof key['value'] === 'string') return key['value'];
  return undefined;
}

function propertyValue(object: Node, name: string): Node | undefined {
  const property = (object['properties'] as Node[]).find((entry) => keyName(entry) === name);
  return property === undefined ? undefined : (property['value'] as Node);
}

function objectKeys(object: Node | undefined): string[] {
  if (object?.type !== 'ObjectExpression') return [];
  return (object['properties'] as Node[]).flatMap((entry) => keyName(entry) ?? []);
}

/**
 * The settings keys a source declares: the fields of every `defineConfig`
 * call (`@jsails/config`) and the `properties` of every JSON-schema object
 * literal (`type: 'object'`, a plugin settings schema).
 */
function settingsKeysOf(program: Node): string[] {
  const keys: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'CallExpression') {
      const callee = node['callee'] as Node;
      const name =
        callee.type === 'Identifier'
          ? callee['name']
          : callee.type === 'MemberExpression'
            ? (callee['property'] as Node)['name']
            : undefined;
      if (name === 'defineConfig') {
        for (const argument of node['arguments'] as Node[]) {
          if (argument.type === 'ObjectExpression') {
            keys.push(...objectKeys(propertyValue(argument, 'fields')));
          }
        }
      }
    }
    if (node.type === 'ObjectExpression') {
      const type = propertyValue(node, 'type');
      if (type?.type === 'Literal' && type['value'] === 'object') {
        keys.push(...objectKeys(propertyValue(node, 'properties')));
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return keys;
}

/** A parsed source: its text with every comment blanked, and its settings keys. */
interface Parsed {
  /** The text with comments blanked, so documentation never reads as code. */
  readonly code: string;
  readonly keys: readonly string[];
}

/** Parses `text` once for both checks that need its syntax. */
function parse(file: string, text: string): Parsed {
  const result = parseSync(file, text, { sourceType: 'module' });
  let code = text;
  for (const comment of result.comments) {
    code =
      code.slice(0, comment.start) +
      ' '.repeat(comment.end - comment.start) +
      code.slice(comment.end);
  }
  return { code, keys: settingsKeysOf(result.program as unknown as Node) };
}

function settingsKeys(file: string, text: string): readonly string[] {
  return parse(file, text).keys;
}

function withoutComments(file: string, text: string): string {
  return parse(file, text).code;
}

/**
 * The sources the syntax checks parse. A flag declaration or a settings key
 * that names the mode spells the name in the source text, so a file whose text
 * does not match {@link MODE_NAME} cannot hold one, unless it writes the name
 * with escapes (`'\u0061ctivation'` is the key `activation`), which any `\u`
 * or `\x` keeps in. Parsing only these (about a tenth of the shipped sources),
 * once each, instead of every source twice, was most of this file's time and
 * memory.
 */
const PARSED: ReadonlyMap<string, Parsed> = new Map(
  [...SOURCES]
    .filter(([, text]) => MODE_NAME.test(text) || /\\[ux]/.test(text))
    .map(([id, text]) => [id, parse(id, text)]),
);

/** Every `package.json` manifest of core and the packages, by repo-relative id. */
function manifests(): ReadonlyMap<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  const dirs = ['core', ...readdirSync(join(REPO, 'packages')).map((name) => `packages/${name}`)];
  for (const dir of dirs) {
    const path = join(REPO, dir, 'package.json');
    if (existsSync(path)) {
      found.set(
        `${dir}/package.json`,
        JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
      );
    }
  }
  return found;
}

/** The setting keys a manifest's `jsails.settings` schema declares, at any depth. */
function manifestSettingKeys(manifest: Record<string, unknown>): string[] {
  const settings = (manifest['jsails'] as { readonly settings?: unknown } | undefined)?.settings;
  const keys: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const properties = (value as { readonly properties?: unknown }).properties;
    if (properties !== null && typeof properties === 'object') {
      keys.push(...Object.keys(properties));
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(settings);
  return keys;
}

describe('the activation boundary', () => {
  it('reads every shipped source', () => {
    assert.ok(SOURCES.has('core/src/kernel/activation/mode.ts'));
    assert.ok(SOURCES.size > 100);
  });

  it('lets only the loader seal the mode and only the resolver read it', () => {
    assert.deepEqual(filesMatching(/activation\/mode\.js['"]/), [
      'core/src/kernel/load-app.ts',
      'core/src/kernel/resolve-plugins.ts',
    ]);
    assert.deepEqual(filesMatching(/\bsealActivationMode\b/), [
      'core/src/kernel/activation/mode.ts',
      'core/src/kernel/load-app.ts',
    ]);
    assert.deepEqual(filesMatching(/\bsealedActivationMode\b/), [
      'core/src/kernel/activation/mode.ts',
      'core/src/kernel/resolve-plugins.ts',
    ]);
  });

  it('lets only the resolver mint a schema authority', () => {
    assert.deepEqual(filesMatching(/\bmintSchemaAuthority\b/), [
      'core/src/kernel/activation/schema-authority.ts',
      'core/src/kernel/resolve-plugins.ts',
    ]);
  });

  it('names the mode in no environment variable', () => {
    assert.deepEqual(filesMatching(/\bJSAILS_[A-Z_]*(?:ACTIVATION|PLUGINS?_MODE|MANAGED)\b/), []);
  });

  it('lets no command but create take a flag that names the mode', () => {
    const commands = BUILTIN_COMMANDS.filter((command) => command.name !== 'create');
    const names = commands.map((command) => command.name);
    assert.ok(names.includes('serve') && names.includes('db:push'));
    const flags = commands.flatMap((command) =>
      Object.keys(command.options)
        .filter((flag) => MODE_NAME.test(flag))
        .map((flag) => `${command.name} --${flag}`),
    );
    assert.deepEqual(flags, []);
    const declarations = [...PARSED]
      .filter(([id]) => !isCreateSource(id))
      .filter(([, { code }]) => {
        return (
          MODE_FLAG.test(code) ||
          /(?:\b(?:activation|managed)|['"]plugins-mode['"])\s*:\s*\{\s*type\s*:\s*['"](?:boolean|string)['"]/.test(
            code,
          )
        );
      })
      .map(([id]) => id);
    assert.deepEqual(declarations, []);
  });

  it('offers the mode in no settings schema', () => {
    assert.deepEqual(filesMatching(MODE_CHOICE), ['core/src/app/config/schema.ts']);
    const keyed = [...PARSED].flatMap(([id, { keys }]) =>
      keys.filter((key) => MODE_NAME.test(key)).map((key) => `${id}: ${key}`),
    );
    assert.deepEqual(keyed, []);
    const manifestKeyed = [...manifests()].flatMap(([id, manifest]) => [
      ...manifestSettingKeys(manifest)
        .filter((key) => MODE_NAME.test(key))
        .map((key) => `${id}: ${key}`),
      ...(MODE_CHOICE.test(JSON.stringify(manifest['jsails'] ?? null)) ? [`${id}: choice`] : []),
    ]);
    assert.deepEqual(manifestKeyed, []);
  });

  it('finds the settings and flag shapes the checks above refuse', () => {
    const config = `defineConfig('site', { fields: { pluginActivation: choice({ options: ['locked', 'managed'] }) } });`;
    assert.deepEqual(settingsKeys('a.ts', config), ['pluginActivation']);
    assert.ok(MODE_CHOICE.test(config));
    assert.ok(
      MODE_CHOICE.test(`const settings = z.object({ mode: z.enum(['managed', 'locked']) });`),
    );
    assert.deepEqual(
      settingsKeys(
        'b.ts',
        `const schema = { type: 'object', properties: { activation: { type: 'string' } } };`,
      ),
      ['activation'],
    );
    assert.deepEqual(
      manifestSettingKeys({
        jsails: { settings: { type: 'object', properties: { managed: {} } } },
      }),
      ['managed'],
    );
    assert.ok(MODE_FLAG.test(withoutComments('c.ts', `if (args.includes('--managed')) run();`)));
    assert.equal(
      MODE_FLAG.test(withoutComments('d.ts', '/** `--managed` (with `--blog`) */\nrun();')),
      false,
    );
  });

  it('finds an escaped key and a declaration split by a comment, parsing few sources', () => {
    const escaped = `const schema = { type: 'object', properties: { '\\u0061ctivation': {} } };`;
    assert.equal(MODE_NAME.test(escaped), false);
    assert.deepEqual(settingsKeys('e.ts', escaped), ['activation']);
    const split = `const options = { managed: /* the mode */ { type: 'boolean' } };`;
    assert.match(withoutComments('f.ts', split), /managed\s*:\s*\{\s*type\s*:\s*'boolean'/);
    assert.ok(PARSED.size < SOURCES.size / 2, `${PARSED.size} of ${SOURCES.size} parsed`);
  });
});
