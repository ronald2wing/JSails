---
title: Inertia
order: 41
section: Reference
---

# Inertia

`@jsails/inertia` is a minimal server-side adapter for the
[Inertia](https://inertiajs.com) page protocol. It builds the page object,
answers an Inertia visit with JSON and a full page load with HTML, and covers
partial reloads, shared and deferred props, asset versioning, and error bags.
It ships no client router and no view layer: your frontend adapter resolves
components and renders them.

```ts
import { createInertiaPage, inertiaVersion, renderInertiaPage } from '@jsails/inertia';

const version = inertiaVersion({ 'app.js': 'a1b2c3', 'app.css': 'd4e5f6' });

export function GET(request: Request): Response {
  const page = createInertiaPage({
    component: 'Tasks/Index',
    props: { tasks: [{ id: 1, title: 'Write docs' }] },
    url: new URL(request.url).pathname,
    version,
  });
  return renderInertiaPage(page, { request });
}
```

## The page object

`createInertiaPage({ component, props?, url, version?, flash? })` returns
`{ component, props, url, version }` (plus `flash` when given). `component` and
`url` are required; a missing one is a value-free `TypeError`. `props` defaults
to `{}` and `version` to `null`.

## Rendering

`renderInertiaPage(page, { request, shell? })` picks the representation from
the request:

- **Inertia visit** (the request has an `X-Inertia` header): `200` JSON of the
  page object with `X-Inertia: true`. When the request is a `GET` whose
  `X-Inertia-Version` differs from the page's non-null `version`, the answer is
  the protocol's `409` with `X-Inertia-Location: <page.url>`, so the client
  does a full reload and picks up the new assets.
- **Full page load**: `200` HTML. The page object is JSON, HTML-escaped, in the
  `data-page` attribute of `<div id="app">`, so a prop value can never close
  the attribute or open a tag.

Both representations live at the same URL, so both responses carry
`Vary: X-Inertia`; a shared cache or CDN then keeps them apart. Neither sets
`Cache-Control`: set it on the returned response when a page may be cached.

The `shell` option replaces the default document. It must contain the
placeholder `{{page}}` exactly once (zero or two is a `TypeError`). The page
element is spliced in verbatim, so `$&`, `` $` ``, `$'`, or `$$` inside a prop
stays literal.

```ts
const shell =
  '<!DOCTYPE html><html><head><script type="module" src="/app.js"></script></head>' +
  '<body>{{page}}</body></html>';
return renderInertiaPage(page, { request, shell });
```

## Asset version

`inertiaVersion(assets)` hashes an asset map (`Record<string, string>`, such as
a build manifest) with SHA-256 over the sorted keys and returns the first 8 hex
characters, or `null` for no assets. Pass it as the page `version` so a deploy
that changes an asset turns stale client visits into a `409` reload.

## Partial reloads

`resolveInertiaProps(page, request)` applies `X-Inertia-Partial-Data` (keep
these dot-paths) or `X-Inertia-Partial-Except` (drop these). Partial-Data wins
when both are present, and the result is always a new object. The headers are
client input: a path with a `__proto__`, `constructor`, or `prototype` segment
is ignored, so it can neither reach `Object.prototype` nor create such a key.

```ts
const props = resolveInertiaProps(page, request);
return renderInertiaPage({ ...page, props }, { request });
```

## Shared and deferred props

`mergeSharedProps(page, shared)` adds props every page needs (the signed-in
user, flash messages); the page's own props win on a collision.

`resolveDeferredProps(deferred, context)` resolves a map of
`{ group?, resolve(context) }` entries in parallel and returns the values by
key. A throwing resolver rejects the call unchanged, so the caller decides how
to fail.

## Error bags

`resolveErrorBag(request)` reads `X-Inertia-Error-Bag` (trimmed; `undefined`
when absent or empty). `errorsFor(errors, bag)` returns the full `errors` when
there is no bag, and otherwise the bag's own nested object. A bag name that is
missing, inherited (`toString`), or forbidden (`__proto__`, `constructor`,
`prototype`) yields `{}`, so a crafted header can never hand you
`Object.prototype` as the error map.

```ts
const bag = resolveErrorBag(request);
const page = createInertiaPage({
  component: 'Auth/Login',
  props: { errors: errorsFor(validationErrors, bag) },
  url: '/login',
});
```

## Limits

- **No client side.** Install an Inertia client adapter for your view library;
  this package only speaks the server half of the protocol.
- **No SSR.** The HTML response is the shell plus the page element; server
  rendering of components is up to the app.
- **No redirect helpers.** Return a `303` yourself after a non-GET Inertia
  visit, as the protocol expects.
