# Upgrading

Breaking changes between pre-release builds of JSails 1.0, one line per
removal or rename, with what to use instead. Nothing here has been released;
the list exists so an app built on an earlier checkout can follow the rebuild.

## Removed

- The `// #region` component dialect (`model`/`server`/`style`/`view` regions
  lowered by the compiler) is gone. The markers are plain comments again;
  author a component as plain TSX with `defineComponent`, or as a `.jsails`
  single-file component.
- The TSX multi-file server component layout is gone: `jsails
  make:server-component --mfc` no longer writes a `components/<name>/`
  directory of TSX parts. Multi-file components come back as a layout of
  `.jsails` components (a folder holding `<name>.jsails`, `<name>.ts`,
  `<name>.css` and `<name>.server.ts`), with `--mfc` generating it, when that
  support lands. Until then keep a component in one `components/<name>.tsx`.
- `jsails convert:component` is removed. Its replacement, `jsails convert`,
  will switch a `.jsails` component between the one-file and folder layouts.
- `compilerPlugin` is no longer exported from `jsails/build`, and the web
  starters' `vite.config.js` no longer lists it. Delete it from your own
  `vite.config.js`. `.jsails` components are compiled by the framework's own
  build when that support lands; until then a `.jsails` file is not built.
- `jsails live:list` is removed. Publications are registered by application
  code at runtime, so the command could not list them; read them from the
  publication registry your app constructs.
- The `@jsails/signals` package is removed. The bus itself stays in
  `jsails/signals`: provide it from one of your own plugins with
  `services.provide(signalsToken, new RegistrySignalBus(interceptorRegistry))`
  in `setup`, and drop `'@jsails/signals'` from `plugins.use`.
- The top-level `publicOrigin` config key is removed: set `server.origin`. The
  bare count `JSAILS_TRUSTED_PROXIES=1` is now `hops=1` (or set
  `server.trustedProxies`).
- `@jsails/auth`'s `trustedProxies` option and its exports
  `resolveClientAddress`, `parseTrustedProxies`, `clientAddressKey`,
  `socketAddress`, `TRUSTED_PROXIES_ENV` and `CLIENT_ADDRESS_HEADER` are
  removed: read `context.client` (resolved by the framework from
  `server.trustedProxies`).
- `createPluginInstaller` no longer takes `lookupHost`, and `PluginFetch`,
  `HostLookup` and `InstallPluginInput.validateUrl` are removed: pass a
  `GuardedFetch` (from `createGuardedFetch` in `jsails/support/server`) as
  `fetch`, and list bare host names in `allowedHosts`.
- Jamal is no longer part of `jsails`: install `@jsails/jamal` as a
  regular dependency, since a deploy runs from a production install
  (`jsails jamal` forwards to it). The `jsails/deploy` and
  `jsails/jamal` subpaths, the `deployments` config key, the static-host and
  hardening generators, the ONCE preset, and `jamal deploy --target/--write`,
  `dev`, `harden`, `targets`, `registry`, `audit` and `snapshot` are removed;
  the deploy guide covers static hosts, hardening and database dumps. Rename
  `jamal.config.js` to `jamal.config.ts` and type it with `defineJamal`.
  `createOnDemandTlsAllowlist` is imported from `jsails/app`.
- `.jsails` files: add `lang="ts"` to every `<script>`, move a `<server>` block
  into a `.server.ts` module, and pass `stateSchema`, `authorize` and
  `actions` to `defineLive({...})` instead of exporting them. Write bindings
  as `:name="expr"` (not `name={expr}`), events as `@name`, and replace
  `js-bind:`, `js-on:`, `js-submit`, `js-call`, `js-intersect`, `js-visible`,
  `js-content`, `js-once` and `js-is`; each diagnostic carries a fix-it.
- Plugin manifests are v1 (`manifestVersion: 1`, with name, summary,
  publisher, apiTier and registered `permissions`). `pluginManifestSchema`,
  `jsailsPackageFieldSchema`, `PERMISSION_PATTERN` and `PluginManifest` are
  removed: use `checkPluginManifest`, `parsePackageManifest`,
  `parseBundleManifest` and `PluginManifestV1`. A bundle may not declare
  `autoload`, commands, generators or env, and `checksums`/`signature` are no
  longer manifest fields. `exportPluginSnapshot(state)` takes no plugins
  directory.
- `jsails build:meta`, `jsails inject:auto-imports` and `jsails test` no
  longer ignore what they do not read: an unknown flag or a positional
  argument now fails with exit 2, and `--help` prints usage instead of running
  the command. Drop stray arguments from scripts that call them.
