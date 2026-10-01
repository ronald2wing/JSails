/**
 * The JSails VS Code extension's entry: on the first `.jsails` document it
 * activates the TypeScript 7 extension, which activates only on TypeScript and
 * JavaScript documents (docs/design/sfc.md §7). The language and its grammar
 * are contributed declaratively in `package.json`. CommonJS, because that is
 * what every VS Code the extension supports loads.
 */
'use strict';

/** The TypeScript 7 extension (`extensionDependencies` installs it). */
const TYPESCRIPT_EXTENSION = 'TypeScriptTeam.native-preview';

/**
 * Activate the TypeScript 7 extension through `vscode`'s API. Highlighting
 * needs nothing from it, so a missing one (disabled by the user) is left alone.
 */
async function activateWith(vscode) {
  const typescript = vscode.extensions.getExtension(TYPESCRIPT_EXTENSION);
  if (typescript !== undefined) await typescript.activate();
}

/** VS Code's entry point. */
async function activate() {
  await activateWith(require('vscode'));
}

module.exports = { TYPESCRIPT_EXTENSION, activate, activateWith };
