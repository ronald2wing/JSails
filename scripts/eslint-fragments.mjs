/**
 * Loads the ESLint rule fragments under `eslint/` for `eslint.config.mjs`, so a
 * concern that needs lint rules adds one file instead of editing the shared
 * config.
 *
 * Fragment contract (`eslint/<name>.mjs`, loaded in name order, after the base
 * config and before Prettier's switch-offs):
 *
 * - `export default [...]`: flat-config objects, each naming the `files` it
 *   applies to. Two fragments that set the same rule for overlapping files
 *   override each other in name order, so a fragment owns the rules it sets.
 * - `export const rules = { '<name>': ruleModule }`: custom rules, registered as
 *   `jsails/<name>` and switched on by the fragment's own config objects.
 * - `export const restrictedSyntax = [{ name, files, ignores?, selector, message }]`:
 *   syntax bans. Each entry becomes its own rule, `jsails/<name>`, reporting
 *   every node `selector` (an ESLint selector) matches with `message`. Core
 *   `no-restricted-syntax` takes one option list per file, so two fragments
 *   using it would silently replace each other's bans; fragments therefore may
 *   not set it.
 *
 * Every custom and restricted-syntax rule lives in one `jsails` plugin, so a
 * name used by two fragments is an error rather than a silent override.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const RULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLUGIN = 'jsails';

/** A rule that reports every node `selector` matches. */
export function restrictedSyntaxRule({ selector, message }) {
  return {
    meta: { type: 'problem', schema: [], docs: { description: message } },
    create(context) {
      return {
        [selector](node) {
          context.report({ node, message });
        },
      };
    },
  };
}

function assertFragmentShape(file, configs, restricted, custom) {
  if (custom === null || typeof custom !== 'object' || Array.isArray(custom)) {
    throw new Error(`${file}: \`rules\` must be an object of rule modules`);
  }
  for (const [name, rule] of Object.entries(custom)) {
    if (!RULE_NAME.test(name) || typeof rule?.create !== 'function') {
      throw new Error(`${file}: custom rule "${name}" needs a kebab-case name and a create()`);
    }
  }
  if (!Array.isArray(configs)) {
    throw new Error(`${file}: the default export must be an array of flat-config objects`);
  }
  for (const config of configs) {
    if (config?.rules?.['no-restricted-syntax'] !== undefined) {
      throw new Error(
        `${file}: set syntax bans through \`export const restrictedSyntax\`, not no-restricted-syntax`,
      );
    }
  }
  if (!Array.isArray(restricted)) {
    throw new Error(`${file}: \`restrictedSyntax\` must be an array`);
  }
  for (const entry of restricted) {
    const { name, files, selector, message } = entry ?? {};
    if (typeof name !== 'string' || !RULE_NAME.test(name)) {
      throw new Error(`${file}: restrictedSyntax name must be kebab-case, got ${String(name)}`);
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`${file}: restrictedSyntax "${name}" must name the files it applies to`);
    }
    if (typeof selector !== 'string' || typeof message !== 'string' || message === '') {
      throw new Error(`${file}: restrictedSyntax "${name}" needs a selector and a message`);
    }
  }
}

/**
 * Builds the flat-config objects for a list of loaded fragments
 * (`[{ file, configs, restrictedSyntax, rules }]`, already in load order).
 */
export function composeFragments(fragments) {
  const rules = {};
  const out = [];
  const bans = [];
  const define = (file, name, rule) => {
    if (rules[name] !== undefined) {
      throw new Error(`${file}: rule "${PLUGIN}/${name}" is already defined by another fragment`);
    }
    rules[name] = rule;
  };
  for (const { file, configs, restrictedSyntax = [], rules: custom = {} } of fragments) {
    assertFragmentShape(file, configs, restrictedSyntax, custom);
    for (const [name, rule] of Object.entries(custom)) define(file, name, rule);
    out.push(...configs);
    for (const entry of restrictedSyntax) {
      define(file, entry.name, restrictedSyntaxRule(entry));
      bans.push({
        files: entry.files,
        ...(entry.ignores === undefined ? {} : { ignores: entry.ignores }),
        rules: { [`${PLUGIN}/${entry.name}`]: 'error' },
      });
    }
  }
  if (Object.keys(rules).length === 0) return out;
  return [{ plugins: { [PLUGIN]: { rules } } }, ...out, ...bans];
}

/** Imports every `*.mjs` fragment in `dirUrl` (name order) and composes them. */
export async function loadFragments(dirUrl) {
  const dir = fileURLToPath(dirUrl);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
  const fragments = [];
  for (const name of names) {
    const module = await import(pathToFileURL(join(dir, name)).href);
    fragments.push({
      file: `eslint/${name}`,
      configs: module.default,
      restrictedSyntax: module.restrictedSyntax,
      rules: module.rules,
    });
  }
  return composeFragments(fragments);
}
