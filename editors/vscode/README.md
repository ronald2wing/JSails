# JSails for VS Code

The `jsails` language for `.jsails` single-file components: syntax
highlighting for their `<script lang="ts">`, `<template>` and `<style>`
blocks, with template expressions (`{{ }}`, `:x`, `@x`, `#x` and `js-*`
values) highlighted as TypeScript.

Types come from TypeScript itself. The extension depends on the TypeScript 7
extension (`TypeScriptTeam.native-preview`) and activates it when a `.jsails`
file opens, so `.ts` and `.tsx` files that import components get the full
language features. Hover and completion inside `.jsails` files wait for
TypeScript 7.1's content mappers (docs/design/sfc.md §6 and §7).

Formatting is Prettier's `vue` parser, which the repository configures for
`**/*.jsails`; no extension setting is needed.

## Building

This directory is private and not an npm workspace. The grammar is generated
from `packages/content/src/jsails-grammar.ts`, so build the content package
first:

```sh
npm run build -w @jsails/content
npm --prefix editors/vscode run build     # stages editors/vscode/dist/
npm --prefix editors/vscode run package   # packs editors/vscode/jsails.vsix
```

`package` fetches `@vscode/vsce` at a pinned version through `npx`; nothing is
installed into the repository.
