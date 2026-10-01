/**
 * The private VS Code extension (`editors/vscode`): its staged directory holds
 * the grammar generated from `@jsails/content`'s `.jsails` grammar, a manifest
 * whose contributions agree with that grammar, and core's LICENSE; and its
 * activation activates the TypeScript 7 extension it depends on.
 *
 * Staging reads the content package's build, as every CI leg, `npm test` and
 * `npm run check` build before the tooling tests.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  GRAMMAR_MODULE,
  packedManifest,
  stageExtension,
  textMateGrammar,
} from '../../editors/vscode/build.mjs';
import { repoRoot } from '../workspaces.mjs';

const extension = createRequire(import.meta.url)('../../editors/vscode/extension.cjs');
const SOURCE = join(repoRoot, 'editors', 'vscode');

let staged;
let grammar;

before(async () => {
  staged = await stageExtension(mkdtempSync(join(tmpdir(), 'jsails-vscode-')));
  ({ jsailsGrammar: grammar } = await import(pathToFileURL(GRAMMAR_MODULE).href));
});

after(() => {
  if (staged !== undefined) rmSync(staged, { recursive: true, force: true });
});

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every scope the grammar embeds another language under: content names and included grammars. */
function embeddedScopes(rule, found = new Set()) {
  if (typeof rule !== 'object' || rule === null) return found;
  if (
    typeof rule.contentName === 'string' &&
    /^(?:source|meta\.embedded)\./.test(rule.contentName)
  ) {
    found.add(rule.contentName);
  }
  if (typeof rule.include === 'string' && rule.include.startsWith('source.')) {
    found.add(rule.include.split('#')[0]);
  }
  for (const child of Object.values(rule)) embeddedScopes(child, found);
  return found;
}

describe('the staged VS Code extension', () => {
  it('holds the grammar generated from @jsails/content, without Shiki fields', () => {
    const generated = json(join(staged, 'syntaxes', 'jsails.tmLanguage.json'));
    assert.deepEqual(generated, JSON.parse(JSON.stringify(textMateGrammar(grammar))));
    assert.deepEqual(Object.keys(generated), ['name', 'scopeName', 'patterns', 'repository']);
    assert.equal(generated.scopeName, grammar.scopeName);
    assert.deepEqual(generated.repository, JSON.parse(JSON.stringify(grammar.repository)));
  });

  it('contributes the language and grammar the grammar names', () => {
    const manifest = json(join(staged, 'package.json'));
    assert.deepEqual(manifest, packedManifest(json(join(SOURCE, 'package.json'))));
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.private, true);
    const [language] = manifest.contributes.languages;
    const [contributed] = manifest.contributes.grammars;
    assert.equal(language.id, grammar.name);
    assert.deepEqual(language.extensions, ['.jsails']);
    assert.equal(contributed.language, grammar.name);
    assert.equal(contributed.scopeName, grammar.scopeName);
    assert.deepEqual(manifest.activationEvents, [`onLanguage:${grammar.name}`]);
    assert.deepEqual(manifest.extensionDependencies, [extension.TYPESCRIPT_EXTENSION]);
    for (const file of [contributed.path, language.configuration, manifest.main, 'README.md']) {
      assert.ok(existsSync(join(staged, file)), `${file} is staged`);
    }
    json(join(staged, language.configuration));
  });

  it('maps every embedded scope of the grammar to a language', () => {
    const [contributed] = json(join(staged, 'package.json')).contributes.grammars;
    assert.deepEqual(
      [...embeddedScopes(grammar)].sort(),
      Object.keys(contributed.embeddedLanguages).sort(),
    );
  });

  it("ships core's LICENSE", () => {
    assert.equal(
      readFileSync(join(staged, 'LICENSE'), 'utf8'),
      readFileSync(join(repoRoot, 'core', 'LICENSE'), 'utf8'),
    );
  });
});

describe('the VS Code extension entry', () => {
  it('activates the TypeScript 7 extension', async () => {
    const asked = [];
    let activations = 0;
    const vscode = {
      extensions: {
        getExtension(id) {
          asked.push(id);
          return {
            async activate() {
              activations += 1;
            },
          };
        },
      },
    };
    await extension.activateWith(vscode);
    assert.deepEqual(asked, ['TypeScriptTeam.native-preview']);
    assert.equal(activations, 1);
  });

  it('leaves a missing TypeScript 7 extension alone', async () => {
    await extension.activateWith({ extensions: { getExtension: () => undefined } });
  });
});
