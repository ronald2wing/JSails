---
title: Theme Tokens
order: 24
section: Reference
---

# Theme Tokens

`@jsails/theme` is a **browser-safe** CSS custom-property token contract shared by
the admin renderer, the generated starter, and plugin authors. It has no I/O and
no `node:*` imports, so the module is safe for client-side code. A presentation
toggle here means switching the active named theme through `[data-theme]` blocks;
feature flags live in `@jsails/flags`, and messages in `jsails/i18n`.

## Core tokens

`coreThemeTokenNames` is the frozen array of the five fixed core tokens:

- `--jsails-bg`
- `--jsails-fg`
- `--jsails-accent`
- `--jsails-muted`
- `--jsails-border`

These names are semver-visible API: the admin renderer and the starter layout
reference them directly. The open `--jsails-*` namespace accepts any custom
property following that pattern, but only the core set is guaranteed to be
consumed by every surface.

## Deriving tokens from a seed

`deriveThemeTokens(seed)` derives the five core tokens from a `{ primary,
radius? }` seed via a dependency-free HSL transform. `primary` becomes
`--jsails-accent`; the remaining tokens are derived by varying lightness and
saturation. Hex colors produce a harmonic palette; a non-hex primary gets
sensible neutral defaults. The optional `radius` sets `--jsails-radius`.

```ts
import { deriveThemeTokens } from '@jsails/theme';

const tokens = deriveThemeTokens({ primary: '#2563eb', radius: '0.5rem' });
// => { '--jsails-bg': ..., '--jsails-fg': ..., '--jsails-accent': ...,
//      '--jsails-muted': ..., '--jsails-border': ..., '--jsails-radius': '0.5rem' }
```

## Resolving themes

Themes are an **ordered fold, not a parent graph**. `resolveThemeTokens(app,
contributions, options?)` folds four precedence layers, lowest to highest:

1. An implicit empty base `{}`.
2. Unnamed contributions, in registration order (spread-overwrite).
3. The **active** named theme's effective tokens, when `options.active` names
   one.
4. Application tokens (spread-overwrite, highest).

Two contributions sharing the same `name` are spread-merged
(`...earlier, ...later`) — later wins per key, never an error. There is no
`parent` field, no parent-graph resolution, and no `conflict`/`cycle`/
`unknown_parent` errors. The result is a `ThemeResolution`
`{ active, themes, activeName }` with every named theme's effective map
available in `themes`.

```ts
import { resolveThemeTokens } from '@jsails/theme';

const resolution = resolveThemeTokens(
  { '--jsails-accent': '#dc2626' }, // app tokens, highest precedence
  [
    { name: 'ocean', tokens: { '--jsails-accent': '#0891b2' } },
    { tokens: { '--jsails-radius': '0.25rem' } }, // unnamed contribution
  ],
  { active: 'ocean' },
);

resolution.activeName; // 'ocean'
resolution.active; // the folded active map
resolution.themes; // { ocean: { '--jsails-accent': '#0891b2' } }
```

## Emitting CSS

`themeTokensToCss(resolution)` emits `:root { active tokens }` plus one
`[data-theme="<name>"] { ... }` block per named theme (sorted), hardened against
control characters and `</style` injection. It returns `''` when empty. The
`[data-theme]` blocks are what make a runtime theme switch a pure presentation
toggle: flip the `data-theme` attribute on `<html>` and the browser repaints.

```ts
import { resolveThemeTokens, themeTokensToCss } from '@jsails/theme';

const css = themeTokensToCss(resolveThemeTokens(appTokens, contributions, { active }));
// => ":root { --jsails-bg: ...; }\n[data-theme=\"ocean\"] { --jsails-accent: #0891b2; }"
```

## The `ThemeTokens` service

`createThemeTokens(app, contributions, options?)` wraps `resolveThemeTokens`
into a `ThemeTokens` service with `resolve()` (frozen active map), `toCss()` (all
blocks), `themes()` (named maps), and `activeName()`.

## Wiring the plugin

`themePlugin({ tokens?, contributions?, active? })` exposes the resolved
`ThemeTokens` under the typed `themeToken` service token. `options.tokens` is the
application layer (highest precedence); `options.contributions` collects
`ThemeContribution` entries from each plugin's `PluginDescription.theme`
descriptor (inert declarative metadata, never resolved at import time);
`options.active` selects the initial active theme. Construction is inert — no
tokens resolve until `setup` runs.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { themePlugin } from '@jsails/theme';

export default {
  plugins: {
    use: [
      ['@jsails/theme', { active: 'ocean' }],
    ],
  },
};
```

The admin panel consumes the theme service through an optional
`tryGet(themeToken)`, and its `theme` option (`'light' | 'dark' | 'system'`)
maps to the document's `data-theme` attribute. The starter `Layout` renders
`ThemeTokens.toCss()`, which includes the full `[data-theme]` blocks for runtime
theme switching.

## Next steps

- [Feature Flags](/docs/flags) — boolean gates, scopes, and A/B testing.
- [Internationalization](/docs/i18n) — catalogs, pluralization, and the `I18n` facade.
- [Admin Panel](/docs/admin) — how the panel consumes the theme service.

## Declarative templates and previews

Theme packages can declare package-relative `templates`, `partials`, and a
`preview` path in their manifest. `preview` is validated as a safe relative path;
template/partial entries are likewise validated and remain inert metadata until
an app chooses to load them. No theme code is imported or executed.

`parseThemeTemplate(raw)` and `renderThemeTemplate(template, slots)` provide a
small, safe template format for themes that need layout structure:

```ts
import { parseThemeTemplate, renderThemeTemplate } from '@jsails/theme';

const template = parseThemeTemplate({
  version: 1,
  name: 'post',
  contentType: 'article',
  root: {
    type: 'element',
    tag: 'article',
    attributes: { class: 'post' },
    children: [
      { type: 'element', tag: 'h1', children: [{ type: 'slot', name: 'title' }] },
      { type: 'element', tag: 'div', children: [{ type: 'slot', name: 'body' }] },
    ],
  },
});

const html = renderThemeTemplate(template, {
  title: 'Post title', // escaped text
  body: renderRichText(post.blocks), // already-sanitized HTML slot
});
```

The renderer allows only a fixed tag/attribute vocabulary, escapes text and
attribute values, rejects `script`/event/style attributes, rejects
`javascript:`/`data:`/`file:` URLs, bounds depth and node count, and fails closed
with `ThemeTemplateError`. Slot values are inserted verbatim and must be
pre-sanitized by the framework (for example, canonical rich-text output); never
pass client HTML as a slot.

## Child themes and inheritance

A theme package may declare a `parent` theme name:

```json
{
  "name": "storefront-dark",
  "version": "1.0.0",
  "parent": "neutral",
  "tokens": { "--jsails-accent": "#22d3ee" }
}
```

Inheritance follows Magento's recursive parent-chain model, not WordPress'
two-level cap:

- The child is the active package; the parent is inherited indirectly.
- Tokens merge parent-first, so the child overrides individual properties.
- `preview`, `description`, `author`, `templates`, `partials`, `contentTypes`,
  and `settingsSchema` inherit when the child omits them.
- A parent may be activated directly. A child may also declare its own parent.
- Missing parents, cycles, self-parenting, and chains deeper than 32 fail with a
  value-free `ThemePackageError`; a broken chain never partially activates.

`registry.lineage(name)` returns the root-to-child chain, `registry.resolve(name)`
returns the effective package with tokens/metadata merged, and
`registry.resolveActive()` returns the effective active package.
`themes()` and `toCss()` use effective token maps for every package, so a child's
`[data-theme]` block includes every inherited token while still overriding its
own.

This keeps child themes update-safe: the child only stores what it changes, and
future parent releases reach it without copying the parent theme.

## Jello Elementor

`jello-elementor` is the built-in functional blog theme. It ships:

- soft editorial tokens (warm paper background, berry accent, rounded surfaces);
- scoped CSS for the shell and blog layouts;
- header, footer, blog index, archive, single-post, and error layouts;
- no executable theme code.

It is the default built-in theme for the generated blog. The header and footer
are rendered for blog pages only; the home, tasks, about, admin, and SaaS
shells keep their app-owned layouts.

Switch it in the admin theme page, or persist a different `theme.active`
setting. The built-in `neutral` and `night` themes remain available; `night`
inherits from `neutral`. When a selected theme has no blog layout (for example
`neutral`), the blog falls back to its plain discovery markup rather than
failing.
