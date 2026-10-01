/**
 * Stages the JSails VS Code extension in `editors/vscode/dist/`: its manifest
 * (without the scripts that build it), entry, language configuration and
 * README, core's LICENSE, and `syntaxes/jsails.tmLanguage.json` generated from
 * the compiled `.jsails` grammar of `@jsails/content`, the one source of truth
 * for the language's highlighting. `npm run package` packs the staged
 * directory into a `.vsix`. Nothing generated is committed.
 *
 * Usage: node editors/vscode/build.mjs   (after `npm run build -w @jsails/content`)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repoRoot = join(here, '..', '..');

/** The compiled grammar module of `@jsails/content`. */
export const GRAMMAR_MODULE = join(
  repoRoot,
  'packages',
  'content',
  'dist',
  'src',
  'jsails-grammar.js',
);

/** The files copied into the extension as they are. */
const COPIED = ['extension.cjs', 'language-configuration.json', 'README.md'];

/**
 * A Shiki language registration as a TextMate grammar file: the display name,
 * scope and rules, without Shiki's language id and loading fields.
 */
export function textMateGrammar(registration) {
  const { displayName, scopeName, patterns, repository } = registration;
  return { name: displayName, scopeName, patterns, repository };
}

/** The extension manifest as packed: the source manifest without its build scripts. */
export function packedManifest(manifest) {
  const { scripts: _scripts, ...packed } = manifest;
  return packed;
}

/** Stage the extension into `out`, replacing what is there; returns `out`. */
export async function stageExtension(out = join(here, 'dist')) {
  if (!existsSync(GRAMMAR_MODULE)) {
    throw new Error('the .jsails grammar is not built: run npm run build -w @jsails/content');
  }
  const { jsailsGrammar } = await import(pathToFileURL(GRAMMAR_MODULE).href);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'syntaxes'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(packedManifest(manifest), null, 2)}\n`,
  );
  for (const file of COPIED) copyFileSync(join(here, file), join(out, file));
  copyFileSync(join(repoRoot, 'core', 'LICENSE'), join(out, 'LICENSE'));
  writeFileSync(
    join(out, 'syntaxes', 'jsails.tmLanguage.json'),
    `${JSON.stringify(textMateGrammar(jsailsGrammar), null, 2)}\n`,
  );
  return out;
}

if (import.meta.main) {
  const out = await stageExtension();
  console.log(`staged the extension in ${out}`);
}
