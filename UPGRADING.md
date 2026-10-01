# Upgrading

Breaking changes between pre-release builds of JSails 1.0, one line per
removal or rename, with what to use instead. Nothing here has been released;
the list exists so an app built on an earlier checkout can follow the rebuild.

## Removed

- `configureHttp` is removed from the extension and plugin setup context,
  with `HttpExtensionHook`, `HttpHookRegistration`, `ExtensionRuntime.httpHooks`
  and `createApp`'s `httpHooks` option: no plugin receives the Hono app.
  Register each route with `routes.add({ methods, path, access, credentials?,
  body?, timeoutMs?, handler })`, answering from the route's request context
  (`ctx.request`, `ctx.session`, `ctx.body`) with a `Response`; serve a whole
  Hono app with `routes.mount(prefix, app.fetch, { access })`. A route that
  accepts the session cookie is refused `403 access.cross_site` for a
  cross-site unsafe request before its handler runs; declare `credentials: []`
  for one that reads no session.
- `hookRoute` and `HookRouteLimits` (`jsails/extensions`) are removed:
  `routes.add` and `routes.mount` take `body` and `timeoutMs` in their spec.
- `defineDeclarativePlugin`'s `http` hook is now `routes`, called with the
  plugin's registrar: `routes: (routes) => routes.add({ ... })`. A spec that
  still declares `http` throws `declarative_plugin.removed_option`, and one
  with any other key the spec does not have throws
  `declarative_plugin.unknown_option`.
- The app config's `middleware` map and `globalMiddleware` are removed
  (`config.removed_option` names the replacement), and so are `configureMiddleware`, middleware
  names in a route module's `middleware` export (`RouteMiddlewareRef`; an entry
  is the function itself) and `createApp`'s `globalMiddleware` and
  `middlewareMap`. A wall in front of every request is a guard (`http.guards`,
  `configureGuard`); a rewrite of every answer of a route kind is
  `routes.transform(kinds, fn)`; anything else is the route's own
  `middleware`.
- The `http.middleware` permission is removed: `routes.transform` requires
  `http.transform`.
- The `hook` route kind, the `route-owned` access kind (`routeOwnedAccess`)
  and `hook:<plugin>` surface ids are gone from the route table and the
  surface registry: every route's surface id is its methods and pattern.
- The introspection `pipeline` section lists one `middleware` stage (no
  `middleware-global`/`middleware-route`) and no longer reports
  `middleware.registered` or `middleware.globalCount`; the `config` section
  drops `middlewareNames` and `globalMiddlewareCount`.

- `defineAppConfig` is removed: default-export `defineApp({ env, config })`
  from `jsails.config.ts` (or keep a plain config object in `jsails.app.js`).
- `loadAppConfig` is removed from `jsails` and `jsails/app`: call
  `loadApp({ configPath, cwd, env })` from `jsails/kernel`, and hand the
  `LoadedApp` to `createApplication(app)` and `resolvePlugins(app)`.
- `normalizeUseEntry` is removed: put a `definePlugin` instance in
  `plugins.use`; the kernel resolves and orders the graph.
- `jsails app:shape` is removed. The legacy `shape` key it reported on is
  ledgered for removal; `jsails describe` lists the plugin graph.
- `plugins.managed` is removed (`config.removed_option`): state
  `plugins: { activation: { mode: 'managed' } }` as a literal in the config.
  The default, `{ mode: 'locked' }`, runs only `plugins.use`.
- `plugins.force` is removed (`config.removed_option`): declare dependencies
  with the `requires` and `provides` of `definePlugin` instances.
- The `{ specifier, ... }` descriptor form of a `plugins.use` entry is
  removed (`config.removed_option`): put the plugin's `definePlugin`
  instance in `plugins.use`.
- The app config schema is strict: an unknown key is refused at load, with
  its block named (`config.server: unrecognized config field`), never
  ignored. Remove the key, or move it to the plugin that reads it.
- A config that loads app code through a `#` subpath import or its own
  package name (`#app/models/user.ts`, `my-app/models/user.ts`) is refused
  like a relative path into the app: import npm packages and erasable
  modules under `config/` only, and name app code with `moduleRef`.
- A `config(env)` function that returns a promise is refused
  (`config.async_config`) instead of loading as an empty config: return the
  config object itself, and do asynchronous work in a plugin's `setup`.
  A config module whose default export is a promise or a class instance is
  refused the same way.

- The `// #region` component dialect (`model`/`server`/`style`/`view` regions
  lowered by the compiler) is gone. The markers are plain comments again;
  author a component as plain TSX with `defineComponent`, or as a `.jsails`
  single-file component.
- A compiled `.jsails` template now writes `data-s="<id>"` on its outermost
  elements and on the outermost elements of the slot content it passes,
  whether or not the component has a `<style scoped>` block, so its HTML
  differs from the same markup written in TSX. Writing `data-s` on a tag in a
  `.jsails` template is now `sfc.reserved_attribute`; rename the attribute.
  `<style scoped>`, which was `sfc.not_lowered`, now compiles.
- `IslandPropsError`, `parseIslandProps` and `MAX_PROPS_LENGTH` are removed
  from `jsails/client`. A `data-jsails-props` value the browser cannot decode
  is reported as an `island.props_invalid`, `island.props_unparseable` or
  `island.props_too_large` error (`IslandErrors` from `jsails/view`); render
  islands with `<Island>` (or a `.jsails` island tag), which refuses such
  props on the server. `IslandProps` from `jsails/client` is now the one
  declaration of `jsails/view` (`IslandProps<P>`); without a type argument it
  is the same untyped record.
- The TSX multi-file server component layout is gone: `jsails
  make:server-component --mfc` no longer writes a `components/<name>/`
  directory of TSX parts, and `components/card/card.tsx` is now the ordinary
  component `card/card`, not `card`. Multi-file components are a layout of
  `.jsails` components: a folder `<name>/` holding `<name>.jsails`,
  `<name>.ts`, `<name>.css`, `<name>.scoped.css` and `<name>.server.ts`.
  `jsails make:page|server-component <name> --mfc` generates one in a project
  that syncs `.jsails` sidecars (`.jsails/sfc`), which the app build does not
  do yet. Keep a TSX component in one `components/<name>.tsx`.
- `jsails convert:component` is removed. Its replacement, `jsails convert
  <path>`, switches a `.jsails` component between the one-file and folder
  layouts (to a folder only in a project that syncs `.jsails` sidecars).
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
- `jamal.config.ts` may no longer name `JSAILS_TRUSTED_PROXIES` in `env` (as a
  key or an alias): every verb that loads the config refuses it. A generated
  `jamal.config.ts` from an earlier checkout sets `JSAILS_TRUSTED_PROXIES:
  'hops=1'` there; delete that entry, since `jamal deploy` now passes the
  setting for the proxies it runs. Behind a CDN or a load balancer, declare it
  with `proxy: { forwardHeaders: true, upstreamCidrs: [<its published
  ranges>] }` instead of a hand-written count.
- An app deployed with jamal should not set `server.trustedProxies` in its
  app config: the deploy check `jamal deploy` now runs (`jsails check
  --deploy`) refuses a value that differs from the setting jamal passes.
  Remove it and let the deploy state the topology.
- `@jsails/auth`'s `trustedProxies` option and its exports
  `resolveClientAddress`, `parseTrustedProxies`, `clientAddressKey`,
  `socketAddress`, `TRUSTED_PROXIES_ENV` and `CLIENT_ADDRESS_HEADER` are
  removed: read `context.client` (resolved by the framework from
  `server.trustedProxies`).
- The plugin installer, the plugin state store and managed activation are
  removed: `createPluginInstaller`, `extractTarGz`, `PluginStateStore`,
  `createDatabasePluginStateStore`, `pluginStateEntities`,
  `DatabasePluginState`, `resolvePluginEnablement`, `loadPluginEnablement`,
  `activatePlugins`, `exportPluginSnapshot`, `importPluginSnapshot`,
  `parsePluginSnapshot`, `resolveDownloadsCapability` and their types are
  gone from `jsails/plugins` and `jsails`. No database row or file activates
  plugin code in either mode: install the plugin with npm and list its
  instance in `plugins.use`. Remove `pluginStateEntities` from
  `jsails.database.js`; `jsails db:push` then plans to drop the
  `jsails_plugin_state` table, which it applies only with
  `--allow-destructive`, so keep the rows elsewhere first if you need them.
- `plugins.enabled`, `plugins.downloads`, `plugins.stateSource`,
  `plugins.pluginsDir` and `plugins.allowLoadFailures` are removed
  (`config.removed_option`): delete them from the app config.
- `jsails plugins install`, `uninstall`, `enable`, `disable`, `rollback`,
  `resolve`, `export` and `import` are removed (a usage error, exit 2).
  `jsails plugins list|check` read the app's `package.json` and
  `node_modules` only and take no `--dir`, `--config` or `--db-config`.
- `@jsails/admin-plugin-manager` (`pluginManagerAdmin`,
  `firstPartyPluginDirectory`) is removed: drop it from `package.json` and
  from the admin plugins. The release no longer writes
  `first-party-digests.json`.
- `discoverPlugins` reads npm dependencies only: its `pluginsDir`,
  `enabled`, `disabled` and `activeVersions` options, the
  `jsails.plugins.disabled` opt-out in the app's `package.json`,
  `DiscoverPluginsResult.skipped` and `disabled`, `DiscoveredPlugin.source`
  and `bundleDir`, `PluginIssue.source` and `detail`, and the `disabled`
  check finding are gone; `packageName`, `root`, `requiredBy`,
  `provenanceChain` and `edges` are always present. Discovery never lists a
  directory, so `PluginFs` is `{ readFileSync }` alone and `PluginDirent` is
  gone: drop `readdirSync` from an injected facade.
- `PluginGraph.issues` and the `managed` graph origin are removed, and the
  graph gains `liveOnly`: the declared plugins (framework, `plugins.use` and
  extensions) that only work in a live process, which a static export leaves
  out. The `plugins` section of `jsails describe` is `{ graph, liveOnly }`,
  `liveOnly` naming that set (it named only live extensions that
  `plugins.enabled` listed), and that of `GET /_jsails/introspect` is
  `{ graph }`, each node `{ name, origin }`; `enabled`, `conflicts`,
  `disabledManaged` and `sources` are gone.
- A generated `jamal.config.ts` no longer shares `service: 'jsails-app'`:
  `jsails create` writes the app's name. In an existing app, set `service`
  (and `image`) to a name unique to the app, such as its package name
  (lowercase letters, digits, `_` and `-`, at most 63 characters). Its local
  Compose project, containers, and volumes are then named after it, so the
  next `jamal up` starts with empty volumes. To keep the old local data, dump
  it before the rename (`npx jamal exec db -- mariadb-dump ...`) and load it
  after; once no other app uses the old project, remove its volumes with
  `docker volume ls --filter label=com.docker.compose.project=jsails-app`
  and `docker volume rm`. Until every app on the machine has its own name,
  a `jamal` verb run in one app while another app's `jsails-app` containers
  exist refuses with `project_in_use` instead of taking them over. On a server already deployed under the old
  `service`, the app's containers and `<service>_<name>` volumes follow the
  name too: keep the old name there, or move the data before deploying the
  new one.
- `jamal down` still keeps the named volumes; deleting them is now
  `jamal down --volumes` (confirm by typing the project name, or `--yes`).
- `@jsails/jamal` pins its `jsails` peer to the exact lockstep version: keep
  the two packages on the same release. `npx jamal` now resolves the project's
  environment itself (its local verbs read `.env` in development), so a
  variable you exported only to make `npx jamal up` see `.env` values is no
  longer needed.
- Jamal's server verbs (`deploy`, `rollback`, `status`, `app`, `accessory`,
  `domain`, `lock`, `backup`, `restore`, `prune`, `secrets`, `cache-proxy`)
  run as `JSAILS_ENV` (default `production`) and read no `.env` file: a
  `$NAME` in `.jamal/secrets*` that used to resolve from `.env`, `.env.local`
  or `.env.production` resolves from the real environment or
  `config/credentials/<env>.enc` instead. Move each deploy-time value there.
  If the environment has sealed credentials, the verbs need its key
  (`JSAILS_CREDENTIALS_KEY` or `config/credentials/<env>.key`) and stop with
  `credentials.missing_key` without it. Run a verb for another environment
  with `JSAILS_ENV=staging npx jamal deploy`, never `NODE_ENV=staging`. A
  server verb started from inside a `jsails` process resolved for another
  environment stops with `environment.inherited_mismatch`; call it from the
  shell or the CI step directly.
- `jamal deploy` and `jamal rollback` deliver the credentials key ring to the
  app container themselves when the environment has sealed credentials. Remove
  `JSAILS_CREDENTIALS_KEY=$(cat config/credentials/production.key)` (or any
  other `JSAILS_CREDENTIALS_KEY` entry) from `.jamal/secrets*`, and a
  `JSAILS_CREDENTIALS_KEY: secret(...)` entry from `config.env`: both are now
  refused (`reserved_secret`, and an invalid config). A CI job keeps setting
  `JSAILS_CREDENTIALS_KEY` in its environment; that is where the deploy reads
  the key from. A deploy for an environment other than production needs a
  clear `JSAILS_ENV` entry in `config.env` naming it, or the deploy stops with
  `jamal_credentials.environment_mismatch`; the release passes the `NODE_ENV`
  it derives.
- jamal's config refuses, when it loads, a `config.env` key or alias that the
  environment resolver reserves: remove any `NODE_ENV`, `JSAILS_SECRETS_FILE`,
  `JSAILS_ENV_RESOLVED` or `JSAILS_DEBUG` entry (set `JSAILS_ENV` instead of
  `NODE_ENV`), and give `JSAILS_ENV` a literal value (or a `secret()` with
  `clear: true`) under its own name, never through the env file.
- A JSails command started beneath another one resolved for a different
  project directory stops with `environment.inherited_foreign_project`. A
  script or test that runs `jsails` in another project passes it an
  environment without `JSAILS_ENV_RESOLVED` and the values its parent
  resolved.
- `JSAILS_ENV` names the environment and `NODE_ENV` is derived from it:
  replace `NODE_ENV=staging` with `JSAILS_ENV=staging`, and never set a
  `NODE_ENV` that contradicts it (`environment.conflict`). `.env`,
  `.env.<name>`, `.env.local`, the secrets file and the credentials may not
  set `NODE_ENV`, `JSAILS_ENV`, `JSAILS_CREDENTIALS_KEY`,
  `JSAILS_SECRETS_FILE`, `JSAILS_ENV_RESOLVED` or `JSAILS_DEBUG`.
- Only development and test read `.env` files. In any other environment
  (production, staging, ...) move the values from `.env` and `.env.<name>`
  (`.env.production` included) into the real environment, a
  `JSAILS_SECRETS_FILE`, or the sealed credentials.
- Rename `.env.testing` to `.env.test`.
- An app-running command (`serve`, `work`, `db:push`, `test`, project
  commands, ...) stops with `credentials.missing_key` in every environment,
  development and test included, when the environment's document is sealed and
  no key opens it.
- `EnvironmentError` and `EnvironmentErrorCode` are removed: check
  `EnvironmentErrors.is(error)` (codes `environment.invalid_variable` and
  `environment.invalid_environment`, issues in `error.payload.issues`). The
  `JSAILS_CREDENTIALS_LOADED` and `JSAILS_ENVIRONMENT_LOADED` markers are
  gone; a child process inherits its parent's resolution through
  `JSAILS_ENV_RESOLVED`.
- `currentRequestId()` (`jsails/app`) is removed: use
  `currentContext()?.requestId` from `jsails/context`.
- A job dispatched during a tenant request now runs in that tenant and locale.
  A handler that relied on every job starting with no tenant calls
  `runWithoutTenant` itself. Jobs queued with the old `__jsailsRequestId`
  option before the upgrade lose their request id; the option is now
  `__jsailsContext` and is reserved.
- `registerComponent`, `registeredComponents`, `clearComponentRegistry` and
  `bootstrapComponents` are removed. Components are registered per app: by
  default from the generated `.jsails/components.registry` entries, or from an
  explicit `components` map. A hand-built runtime takes
  `createComponentRegistry(await loadComponentEntries({ rootDir }))`;
  `loadComponentEntries` requires the app root and no longer takes
  `modulePath`.
- A component's `name` must equal its id: its path under `components/`,
  kebab-cased (`components/TaskList.tsx` is `task-list`).
- `createServerComponentsRuntime`: `components` takes a `ComponentRegistry`;
  the store moves to a top-level `store` option; `uploads.downloadSigner`
  becomes `downloads: { signer }`; `runtime.update`, `handleUpload` and
  `handleDownload` become `runtime.routes.{update,upload,download}(request,
  context, report)`, which return a `Response`; the render option `origin` is
  removed.
- The `serverComponentsPlugin` options `uploads.maxConcurrent`,
  `maxConcurrentPerSubject`, `idleTimeoutMs`, `timeoutMs` and
  `snapshotTimeoutMs` move to `limits.upload.{maxConcurrent,
  maxConcurrentPerPrincipal, idleMs, totalMs}`. Downloads need `downloads:
  {}`. An upload past its deadline answers 503 `timeout` (it was 400), and a
  throwing `authorize` answers 503 and is reported (it was 403/500 and
  silent).
- `DownloadReferenceClaims` requires `origin` and `page`, and a reference
  whose claims exceed 8 KiB is refused when it is signed. `defineForm`'s
  `rules` option is removed, and unknown options throw.
  `importGeneratedRegistry` returns the module namespace or `undefined`
  instead of a boolean. `ComponentUpdateTestResult` (`jsails/testing`) gains
  `reported`.
- The server-component update protocol is version 2, with no v1 path. A
  request carries `v: 2` and `have: { render, slots }` (the render tag the
  client shows and the nested children it holds) instead of `children`; a
  request without `v: 2` answers 400 `protocol_mismatch`. A reply is a union
  keyed by `kind` (`unchanged`, `render`, `invalid`, `error`,
  `protocol_mismatch`), and the top-level `redirect` and `download` move to
  `effects.redirect` and `effects.download`. The types are
  `ComponentUpdateRequest` and `ComponentUpdateResponse` (`jsails/server-components`).
- Nested children are no longer restored from snapshots the client sends.
  `RestoreOffer`, `ComponentNestedSnapshot`, `ServerComponentRenderOptions.restore`,
  `MAX_NESTED_SNAPSHOTS`, `MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH`,
  `MAX_NESTED_SNAPSHOT_LENGTH` and `MAX_NESTED_SLOT_LENGTH` are removed: a child
  the client holds is kept by reference, the held list is bounded by
  `MAX_HAVE_SLOTS_BYTES` and each slot by `MAX_SLOT_LENGTH`. A parent no
  longer re-renders its kept children: an action that changed a child's data
  calls `context.refreshChild(key)` or `context.refreshChildren()` on its third
  argument, now a `ServerComponentActionContext`.
- `renderNested` resolves to `VNode | null`: a child whose `authorize` does not
  return exactly `true` is `null` (it rendered nothing) instead of a thrown
  `NestedComponentError`. Rendering one `key` twice in a render throws
  `duplicate_slot`, and a slot or component id longer than `MAX_SLOT_LENGTH`
  throws `invalid_config`.
- `SnapshotPayload.revision` is removed, and an unchanged state keeps its token
  byte for byte. A custom `ComponentSigner` implements `renewalDue(snapshot)`:
  `true` when re-signing the verified token now would extend its expiry and is
  due. A hand-written `ServerComponentsRuntime` (a test fake) implements
  `renderChild`.
- `jsails/testing`: `ComponentRenderResult` gains `render` (the render tag);
  `ComponentUpdateTestResult` gains `kind`, `render` and `effects` (read
  `effects.redirect` and `effects.download`); `ComponentUpdateOptions` takes
  `render` and `slots` to state what the test client holds.
- A hand-written `ExtensionContext` or `PluginContext` (a test fake) needs
  `rootDir`, the absolute app root. `runExtensions(extensions)` takes it too:
  call `runExtensions(extensions, { rootDir })` with an absolute path (the app
  config's directory, or a fixture directory in a test); a missing or
  relative root throws `extension.invalid_root` instead of using the working
  directory. `useValkeyConnections(services)` becomes
  `useValkeyConnections({ services, rootDir })`: pass the setup context, or
  both of its fields. `defaultAppPrefix` (and `defaultQueuePrefix`) need the
  app root as their first argument. A `jobsPlugin({ jobsDir })` relative path
  now resolves against the app root rather than the working directory.
  `importGeneratedRegistry(name, { rootDir })` and `bootstrapModels({ rootDir
  })` require the absolute app root too.
- Disks: replace `disk.put(key, data, { contentType })` with `disk.write(key,
  bytes, { maxBytes, contentType })` (`maxBytes` is required, and a string
  must be encoded first); `disk.get(key)` with `readBytes(disk, key, {
  maxBytes })` or `readText`; `disk.exists(key)` with `(await disk.stat(key))
  !== null` and `disk.size(key)` with `(await disk.stat(key))?.size`;
  `disk.stream(key, { range })` with `disk.read(key, { range })`; and
  `putStream(key, source, { maxBytes })` with `write`.
- Replace `disk.list(prefix)` and `listPage` with paged `disk.list(prefix, {
  limit, cursor })`. A prefix now matches whole segments (`a` matches `a/1`,
  not `ab`), and `S3Disk` cursors are no longer raw S3 continuation tokens.
- Replace `isUrlDisk`/`diskUrl`/`disk.url(key, { expiresIn, disposition,
  filename, contentType })` with `isDiskUrlSigner(disk) && disk.signedUrl(key,
  { expiresInMs, contentDisposition: { type, filename }, contentType })`; all
  three options are required.
- Replace `instanceof DiskError` and `error.code === 'not_found'` with
  `DiskErrors.is(error, 'not_found')`: codes are now `disk.*`, and
  `DiskRangeError` is `disk.invalid_range`. Plugin and environment errors are
  `filesystem.*` (`FilesystemErrors`, replacing `FileSystemError`) and variant
  errors `variant.*` (`VariantErrors`, replacing `VariantError`); option
  mistakes are `disk.invalid_option` or `filesystem.invalid_option`, no longer
  `TypeError`.
- A custom `Disk` implements all six methods (`write`, `read`, `stat`,
  `delete`, `deletePrefix`, `list`); check it with `runDiskContract` from
  `@jsails/filesystem/testing`. `LocalDisk` refuses keys under a reserved
  temp-file name (`.<12 hex>.tmp`) and, on Windows, the reserved device names;
  `deletePrefix` requires a non-empty prefix.
- On SeaweedFS (the S3 store `jamal` provisions) outside a `jamal` container,
  set `S3_CONDITIONAL_WRITES=false` (or `conditionalWrites: false`), so
  `ifAbsent` writes are refused instead of overwriting.
- `.jsails` files outside `pages/`, `components/`, `islands/` and `mail/` are
  now views, server-rendered components named after their file; live
  components belong in `components/`. `app/components` is no longer a
  convention directory, and `CLIENT_COMPONENT_EXTENSIONS` is gone.
- The loose `PageProps` type is removed from `jsails` and `jsails/pages`: type
  a page's props as `PageProps<typeof load>` from `jsails/view`, or write
  `Record<string, unknown>` where they are genuinely untyped.
- `jamal app details` and `jamal accessory details` print one JSON object of
  selected `docker inspect` fields (`Id`, `Name`, `Created`, `Image`, `Cmd`,
  `Labels`, `State`, `RestartCount`, `RestartPolicy`, `Mounts`, `Networks`),
  never the container's environment. Read a variable on the server with
  `docker inspect` there if you must.
- Credentials are format v2, and a v1 document is refused
  (`credentials.unsupported_version`). Before upgrading, decrypt each
  `config/credentials/<env>.enc` with the earlier build into a plain dotenv
  file outside the repository; after upgrading, move the old document aside,
  run `jsails credentials init --env <env> --from <file>`, and delete the
  plain file. `jsails credentials regenerate`, `--order` and `--yes` are
  removed: change a document with `edit`, `set` (the value on stdin), `unset`
  or `import`, and replace its key with `rotate` and `rotate --finish`. A
  sealed document may only define plain variable names.
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
- A server-rendered app created earlier has no Dockerfile, so `jamal deploy`
  stops with `missing_dockerfile`. Run `npx jsails make:dockerfile`
  (`--health-path` if `healthPath` is not `/up`, `--no-healthcheck` if it is
  `false`), commit `package-lock.json`, and add
  `volumes: { storage: '/app/storage' }` to `jamal.config.ts` so uploads
  survive deploys.
- `npm run verify:integrations -- --require docker` is now `--require jamal`;
  `JSAILS_TEST_DOCKER=1` runs real containers through a generated app (a built
  tree, network access for the install, and Docker with the Compose plugin)
  instead of probing the daemon.
- Import `JsailsError`, `isJsailsError`, `formatError`, `errnoCode`, `isErrno`
  and `serializeError` from `jsails/errors` instead of `jsails/support`,
  `jsails/support/server` or `jsails/plugin-sdk`. Declare your own errors with
  `defineErrors` from `jsails/errors` instead of subclassing `JsailsError`.
- `instanceof StrError` (and `NumError`, `TimeError`, `ArrError`,
  `AsyncError`, `EncodingError`, `UrlError`, `CryptographyError`,
  `FilesError`, `MediaError`, `CookieError`, `FrontmatterError`,
  `GuardedFetchError`) becomes `StrErrors.is(error[, code])`;
  `CliCommandError` and `SignatureError` checks become `CommandErrors.is` and
  `SignatureErrors.is`. Codes are now `domain.code`: `guarded_fetch.timeout`,
  not `timeout`.
- Model columns use portable types: `bigint` reads as a JS bigint, `decimal`
  as a string, `date`/`time` as canonical strings, and strings compare case-
  and trailing-space-sensitively on every database. `dependent` takes
  `destroy` or `nullify` only.
- `cachePlugin({ valkeyUrl, onError })`, `livePlugin({ valkeyUrl,
  createLogClient, createBusClient })` and `attachBroadcast({ valkeyUrl })`
  are gone. List `valkeyPlugin({ url, onError })` ahead of its consumers, or
  set `VALKEY_URL`, and pass `valkey: services.get(valkeyToken)` to
  `attachBroadcast`.
- `new ValkeyCacheStore`, `new ValkeyMutexStore`, `createValkeyChangeLog`,
  `createValkeyChangeBus` and `new BullMQAdapter` take `{ connections }` (a
  `ValkeyConnections`) instead of `valkeyUrl`, and never close it. Importing
  `ioredis` in plugin code fails lint: take a client from
  `services.get(valkeyToken)`.
- Default Valkey key prefixes are now `<package
  name>:<NODE_ENV>:cache|mutex|live`, so cache entries, locks and live streams
  under `jsails:*` are not read after upgrading. `jobsPlugin`'s default queue
  prefix stays `<package name>:<NODE_ENV>` and does not follow `valkeyPlugin({
  appPrefix })`; set `prefix` in both `jobsPlugin` and the worker runtime
  config to rename it. With the offline queue off, `command`-role calls made
  while reconnecting reject `unavailable` instead of queueing.
- Rich text is version 2. Add `import { blogRichTextUpgrade } from
  '@jsails/blog'` and `export const dataMigrations = { blogRichTextUpgrade };`
  to `jsails.database.js`, then run `npm run db:push`. A body it cannot
  upgrade fails the run, naming the rows as `table#id`, and nothing is
  written; fix those rows and push again. Until it has run, reading an old
  body fails with `unreadable_body`. Remove `editor: editorJsAdapter` from
  `blogAdmin`, `blogPlugin` and admin `richText` fields; replace
  `blogEditorRendererToken` with `renderRichText(post.blocks)`; import
  `richTextToPlainText` from `jsails/rich-text`. A custom editor emits a
  normalised `RichTextDocument`; there is no adapter registry.
- The rich-text editor is ProseMirror. `editorJsToRichText`,
  `richTextToEditorJs`, `EditorConversionError` and the `EditorJs*` types are
  removed from `@jsails/editor`, which now exports `mountRichTextEditor`. A
  page that rendered `<div data-jsails-island="rich-text"
  data-jsails-props={{ name, document }}>` renders `<RichTextField name
  value={document} />` from `@jsails/editor/server` instead; the island no
  longer reads `document` from its props. `RichTextEditor` loses `onInvalid`
  (its `onChange` documents are always valid). Catch
  `RichTextRenderErrors.is(error, 'invalid_document')` (codes
  `rich_text_render.*`) instead of `RichTextRenderError`.
- Admin `richText` fields: drop `required` (it is refused); an absent or
  blank value reaches `save` as no key, so a custom `save` that wrote
  `values.body` unconditionally must skip it when absent on update.
- `CacheStore` has no `remember`, `increment` or other optional member: it is
  `get`, `getMany`, `set`, `add`, `delete`, `namespace` and `close`, and holds
  strings or `Uint8Array`s. Replace `remember` with `get` then `set` (or your
  own single-flight), and a claim built on `increment` with `add`. TTLs must
  be whole milliseconds from 1 to one year; errors are `CacheErrors` codes
  (`cache.invalid_ttl`, `cache.unavailable`, …) instead of `CacheError`.
- `MutexStore`, `MemoryMutexStore`, `ValkeyMutexStore`, `LeaseMutexStore`,
  `isMutexStore`, `supportsLeases`, `mutexToken` and `MutexError` are gone.
  Use `LeaseStore` (`MemoryLeaseStore`, `ValkeyLeaseStore`, `leaseToken`):
  `acquire` returns a `Lease` or `null`, and `renew`/`release` take the lease.
  `cachePlugin({ mutex })` becomes `cachePlugin({ leases })`, and the jobs
  runtime's `overlapMutex` becomes `overlapLeases`.
- `services.get(cacheToken)` is a `CacheService`; call `.cache('<name>')` for
  your namespace's `CacheStore`. The page cache uses the `pages` namespace.
  Closing a namespace view no longer stops it: the view is shared by every
  consumer of its name, so only the root store's `close` stops anything.
  The Valkey lease prefix is `<app prefix>:lease` (it was `:mutex`), and the
  rate-limit counters moved out of the cache to `<app prefix>:ratelimit`.
- `FixedWindowRateLimiter` and `throttle` take `connections` (the app's
  `ValkeyConnections`) instead of a `store`, and count apart from every cache.
- `SharedBatchCoordinator` records each item with `add` and needs a store with
  `add` and `getMany`; its persisted layout changed, so batches in flight
  during the upgrade do not settle.
- `@jsails/webhook` drops the `unsupported_replay_guard` code: every cache
  store has `add`. `claimReplayKey(cache, key, windowSeconds)` no longer takes
  the endpoint id, and a replay window or doubled tolerance above one year is
  refused, whether set on the endpoint, on a custom verifier, or passed to
  `verifyWebhookRequest` (which throws `invalid_endpoint` before reading the
  request).
- `createApp({ renderPage })` and the `RenderPage` type are gone: pass
  `renderer`, a `PageRenderer` (`preactPageRenderer` from `jsails/pages` is
  the built-in one).
- Middleware is a function of the route's request context: `RouteMiddleware`
  is `(context, next) => Response` for a route module's `middleware` export,
  `defineApi`'s and `routes.add`'s `middleware`; the Hono form (`AppMiddlewareHandler`, `(c, next)`
  staging headers on `c.res`) is not accepted there. Rewrite `async (c, next)
  => { await next(); c.res.headers.set('x-a', '1'); }` as `async (context,
  next) => Respond.withHeaders(await next(), { 'x-a': '1' })`, reading
  `context.session` and `context.request` instead of `c.var`/`c.req`. A
  middleware must return a `Response`, and calling `next()` twice throws
  `route.next_called_twice`.
- `registerIntrospectRoute` and `assertNoIntrospectRouteCollision` are removed
  from `jsails/introspect`: set `introspect` in the app config and `createApp`
  serves the endpoint as a framework route; a route at a framework path fails
  assembly with `route.reserved_path`.
- `@jsails/mcp`'s `McpPublicAccess` type is removed and `publicAccess` /
  `isPublicAccess` are core's (`jsails/api`): `McpAccess` is `AccessRef |
  object`, and a `publicAccess` reason is one line of at most 200 characters.
- A page or layout import failure is `route_module.import_failed` (a
  TypeScript path `route_module.invalid_path`), no longer `PageRenderError`
  `import_failed`: match `error.code === 'route_module.import_failed'`
  instead of a `PageRenderError`.
- Two routes with the same method and pattern fail assembly
  (`route.duplicate_route`) instead of the first registered answering, and so
  does a route under a registrar `mount` (`route.mount_overlap`). Discovery
  refuses an `index` (or a file named like the directory) beside an optional
  catch-all `[[...slug]]`, which already answers that path: keep one of the
  two.
- The server-component transport routes, like health, readiness and
  introspection, are compiled before every other route, and each framework
  path answers a method it does not serve with a 405 instead of reaching a
  catch-all.
- Per-route body caps are a `body` declaration: replace an API module's
  `export const maxBodyBytes = n` with `export const body = { kind: 'raw',
  maxBytes: n }` (or `'json'`, `'form'`, matching what the handler reads), a
  `defineApi` or `RouteSpec` member `maxBodyBytes: n` with `body: { kind,
  maxBytes: n }`, and read the body through `ctx.body` (`json(schema)`,
  `form()`, `bytes()`, `stream()`). Outside production a reader of an
  undeclared kind throws `body.undeclared_read`. `routeBodyLimit` is removed:
  a route declares its body through the registrar (`routes.add({ body })` or
  `routes.mount(prefix, fetch, { access, body })`).
- A route that takes file uploads declares `body: { kind: 'multipart',
  maxBytes, parts }` and reads `ctx.body.multipart()` instead of buffering the
  body with `ctx.body.form()`, `request.formData()` or Hono's `parseBody()`;
  framework code may no longer call the last two
  (`jsails/no-buffered-body-parse`). `BodyKind` gains `'multipart'`, so an
  exhaustive switch over it needs a case, and a hand-written `RequestBody`
  (a test double) needs a `multipart()` member.
- A server-component upload whose body carries a part after the file is
  answered `413 too_large` instead of `400 invalid_request`.
- `maxBodyBytes` (app config and `createApp`) is at most 100 MiB
  (`MAX_ROUTE_BODY_BYTES`); a larger value fails config validation, and
  `createApp` throws `BodyLimitError` (`invalid_body_limit`) where it threw a
  `TypeError`. A route that takes more than 100 MiB cannot; one that takes more
  than the app-wide cap declares its own `body`.
- A chunked body (no `Content-Length`) on a route declaring a larger cap is
  read up to that cap instead of the app-wide one, and a request the access
  gate refuses is answered `403` without its body being read where it used to
  get `413`. A handler that catches a body read error and answers something
  else still yields `413`.
- Every route has a deadline: `server.handlerTimeoutMs` (default 30000) or its
  own `timeoutMs`. A route that legitimately runs longer declares `timeoutMs`
  (`0` disables it), and an admin page through `defineAdminPage({ timeoutMs
  })`; a streamed answer is past the deadline once returned, and declares
  `stream: { timeoutMs }` to bound its idle gaps. `onError` receives a new
  phase, `timeout`. The server-components transport routes run under their
  lane's `totalMs` plus the app's deadline.
- `ServerComponentRoutes` (`jsails/server-components`) carries `laneTotalMs`
  (`update`, `upload`, `download`): code that builds its own routes object for
  `createApp` supplies it.
- `createHttpServer` answers `Expect: 100-continue` only when the request's
  body is first read, and the request is emitted as an ordinary `request`
  event; an app listening for `checkContinue` itself on that server must not
  also answer it.
- `PIPELINE_STAGES` (`jsails/introspect`) lists `body-length`, `deadline` and
  `body-verdict` in place of `body-limit`.
- `cachePlugin`, `flagsPlugin`, `loggingPlugin` and `filesystemPlugin` take
  no instances. Replace `cachePlugin({ store: new MemoryCacheStore() })` with
  `cachePlugin({ store: 'memory' })`, and a custom store with a plugin that
  provides it under `cacheStoreToken` plus `cachePlugin({ store:
  cacheStoreToken })`; a custom lease store is provided under `leaseToken`.
  Replace `flagsPlugin({ store })` with a plugin that provides the store under
  `featureStoreToken` plus `flagsPlugin({ store: featureStoreToken })`, import
  `createDatabaseFlagStore`, `JsailsFeatureFlag` and `flagsEntities` from
  `@jsails/flags/database`, and drop `flags` from `flagsAdmin` and
  `defineFlagsAdminPage`. Pass `diagnostics: diagnosticsToken` and `signals:
  signalsToken` to `loggingPlugin` instead of a recorder and a bus. Replace
  `filesystemPlugin({ disks: { [files.name]: files.disk } })` with
  `filesystemPlugin({ disks: { files: { driver: 'env' } } })` (or `local` and
  `memory` specs). Where you still need the disk itself, resolve the plugin's
  own disk on each use (`createMediaLibrary({ disk: () =>
  facade(filesystemToken).disk('files'), diskName: 'files' })`) rather than
  building a second one with `createDiskFromEnv(process.env, { rootDir })`. A
  `FILESYSTEM_DISK=` that renders blank now fails boot instead of selecting
  the local disk.
- `routingPlugin` and the default export of `jsails/routing` are gone: the
  framework adds the routing plugin itself, so remove `'jsails/routing'` from
  `plugins.use`. `routeManifestToken` stays.
- `mailPlugin({ transport })` takes a `mailTransportToken` (or a keyed
  member) another plugin provides, not a transport instance; provide your
  transport from a plugin of your own. `previews` entries need JSON preview
  props and unique names, and an invalid option is `config.invalid_options`
  instead of a `TypeError`. `MAIL_URL` and `SMTP_URL` are read from the
  resolved environment before setup, not from `process.env` at the first send.
- `webhookPlugin({ cache })` takes a namespace name of the application cache
  (default `webhooks`), not a cache store: add `cachePlugin` (over Valkey when
  the app runs more than one instance) and drop the store you built. An
  invalid endpoint fails with `config.invalid_options`, not
  `WebhookError('invalid_endpoint')`.
- `notificationsPlugin({ database: store })` becomes a plugin of yours that
  provides the store under `notificationStoreToken` plus
  `notificationsPlugin({ database: notificationStoreToken })`; the plugin no
  longer provides the store or declares the table, so add
  `notificationEntities` to your data source. Import `notificationEntities`,
  `JsailsNotification`, `NOTIFICATIONS_TABLE`, `NOTIFICATION_TYPE_LENGTH` and
  `createDatabaseNotificationStore` from `@jsails/notifications/database`.
  `broadcast: { publisher }` takes a function returning the publisher, not a
  publisher object, and invalid options fail with `config.invalid_options`.
- `devReloadMiddleware` (`jsails/dev`) is replaced by `devReloadTransform`, a
  response transform; `devPlugin` registers it itself. A plugin that read
  `NODE_ENV` to gate a development surface reads `mode` from its setup context.
- A serve hook (`onServe`) that attaches something the server's drain cannot
  see (a WebSocket server, any `upgrade` listener) returns it as a
  `ServeAttachment` (`{ name, drain(deadline) }`); one that adds an `upgrade`
  listener and returns nothing fails the serve with
  `serve.missing_attachment`. `ExtensionRuntime.serveHooks` lists
  `{ hook, owner }` registrations instead of bare hooks. A participant's
  `drain` must not await the HTTP server's own close (Socket.IO's
  `io.close()` does): that waits on every connection of the server. A custom
  `BroadcastAdapter` whose `close` closes the server declares a `drain` on its
  handle that disconnects its clients and leaves the server alone.
- `ShutdownTimeoutError` (the `timed_out` rejection of `close()`) is
  replaced by `serve.shutdown_timeout`: test it with
  `ServeErrors.is(error, 'shutdown_timeout')` from `jsails/app`.
- An endless stream must be declared live (`Respond.eventStream`, or
  `Respond.stream(source, init, { live: true })`) to end when the server
  drains; a bare `text/event-stream` answer from a plain Hono app outside the
  JSails request handler is no longer ended early.
- `jsails work` reads the app config (`jsails.app.js`, or `--config`), not
  `jsails.runtime.js`: move the worker's registry, adapter, `schedules`,
  `overlapLeases`, `failedJobs`, `jobTimeoutMs` and `shutdownTimeoutMs` onto
  `jobsPlugin(...)` there. An app with no unit of its own for the `worker`
  role fails with `kernel.no_units`; a unit every role registers (the
  `valkey` connection, `jobs.producer`) does not count, so an app that lists
  `valkeyPlugin` without `jobsPlugin` is refused instead of idling. Over the
  in-memory jobs adapter run `jsails serve --with worker`; a web-only or
  worker-only process over it is refused (`kernel.adapter_not_shared`).
  `jsails dev` serves the web and worker roles together, so it runs an app on
  the in-memory adapter and runs the jobs it dispatches.
- `jobsPlugin` is no longer dispatch-only: it registers the `jobs.worker`
  unit, which every process running the `worker` role starts (it registers
  the declared schedules and consumes the queue). `createApplication(app)`
  without `roles` runs the `web` and `worker` roles, so a custom server entry
  that calls `createApplication(app)` and then `app.serve()` now processes
  jobs and upserts schedules in its own process too. Pass
  `createApplication(app, { roles: ['web'] })` for a web-only process (what
  `jsails serve` does) and run the workers with `jsails work`.
- The runtime config's `extensions` key is removed (`invalid_config`): plugins
  live in the app config, and the worker runs them. `jsails.runtime.js` serves
  `schedule`, `queue`, `schedules`, `queue:failed`, `queue:retry`,
  `queue:forget` and `console --runtime-config`.
- `LifecycleUnit.drain` receives the shutdown deadline's `AbortSignal`, and a
  unit should return once the signal aborts; its `abort` is called for a unit
  still draining at the deadline.
- A custom `JobsRuntime` implements `abort()`; a custom `JobsRuntimeAdapter`
  declares `reach` (`'process'` or `'shared'`) to be checked.
- `createApplication` no longer takes host `units`: register them from a
  plugin with `lifecycle.register`. The kernel stage error registry is
  `KernelStageErrors` (domain `kernel`).
- `valkeyPlugin` is a `definePlugin` factory: a malformed option fails with
  `config.invalid_options` at assembly, a missing URL (`url` or `VALKEY_URL`)
  with `valkey.invalid_url` at setup, and an unreachable server fails the
  process start instead of the first command.
- `defaultAppPrefix(startDir, env)` (and `defaultQueuePrefix`) takes the
  environment explicitly, and its environment part follows the process mode:
  `NODE_ENV` when it is `development` or `test`, else `production`. A process
  with no `NODE_ENV` now keys under `<app>:production`, not
  `<app>:development`. `useValkeyConnections(context, env?)` reads `mode`
  from the setup context, which the legacy `ExtensionContext` now carries.
- The `Command` class, signature strings (`'hello {name?}'`), `audience`,
  `commandFromClass`, `createCliCommandRegistry`, `collectConfigCommands`,
  `CommandErrors`, `SignatureErrors` and the `CliCommand*` types are removed:
  a command module default-exports `defineCommand({ summary, options,
  positionals, needs, run(context) })` from `jsails`, with options declared by
  flag name and read from `context.values`, arguments from
  `context.positionals`, and output through `context.stdout`.
- The `commands` app-config key, `JsailsExtension.commands`,
  `PluginDescription.commands` and `declarativePlugin`'s `commands` are
  removed (`config.removed_option` for the key): put an app command under
  `commands/` (built to `dist/commands/`; `commands/a/b.ts` is `jsails a:b`),
  and have a package list its commands in the `jsails.commands` field of its
  `package.json`.
- The bin is `dist/src/cli/bin.cjs` (`dist/src/cli/index.js` is the module
  it imports); a script that ran the old path runs the new one.
- `jsails make <type> <name>` is `jsails make:<type> <name>`.
- A flag a command does not declare is `unknown option --flag`, not
  `--flag is only valid for ...`; the `create` presets are one at a time.
- `jsails` with no command prints the help and exits 0.
- `defineCommandJob(command, { name, args? })` takes a `defineCommand` value
  that needs only the environment; its `configPath` option is gone. The same
  holds for `@jsails/jobs`: `name` is required, the `{ name, run(args,
  context) }` object and the `CommandJobRunContext` type are gone, and args
  that do not parse fail the attempt with `jobs.command_usage`.
- A dependency's or app command that takes a built-in's name no longer lets
  the built-in run in its place: running that built-in is
  `cli.reserved_command` until the command is renamed.
- `runCommand` (`jsails/testing`) rejects with `cli.invalid_exit_code` for a
  result that is no integer from 0 to 255, as `jsails` refuses it.
- `configPlugin(...)` returns a `definePlugin` instance: read the service
  with `services.get(configToken)` instead of `configPlugin(...).config`,
  provide a store under `configStoreToken` and pass
  `store: configStoreToken`, and list the plugin in `plugins.use` after `@jsails/cache`.
  `configAdmin({ config })` is `configAdmin()`. Import
  `createDatabaseConfigStore`, `configEntities`, `JsailsConfigEntry` and
  `CONFIG_TABLE` from `@jsails/config/database`.
- The CSRF token is gone: `Session.csrfToken`, the `X-CSRF-Token` header,
  `_csrf` form fields, `CSRF_HEADER`, `csrfInput` and `actionForm({ csrf })`
  (`@jsails/admin`), and the server components' CSRF attribute and header.
  Stop sending them; the protection is an exact `Origin` check on every
  unsafe request to a route that accepts the session cookie, anonymous
  requests included. A browser sends `Origin` by itself; a cookie-carrying
  client outside a browser must send `Origin` (or `Sec-Fetch-Site:
  same-origin`), or it is refused `403 access.cross_site`. A resolver that
  builds sessions drops the `csrfToken` member.
- The app-wide `authorize` in `jsails.app.js` is removed
  (`config.removed_option`), and so is `createApp({ authorize })`. Give every
  method-export API module its own access: an `authorize` export (a check)
  or an `access` export (`publicAccess(reason)` or a check), never both. A
  module stating none fails at startup with `surface.missing_access`.
- `legacyAccess` is no longer exported from `jsails/api`, `jsails/kernel` or
  `jsails/plugin-sdk`: pass the check function itself as `access`
  (`defineApi('/x', { access: ({ session }) => session !== null, ... })`,
  `definePage`, `routes.add`, `routes.mount`).
- The `csrf` member of `defineApi`, `routes.add` and `routes.mount` (and the
  `CsrfRule` type) is replaced by `credentials`: `csrf: 'none'` becomes
  `credentials: []` (the route reads no cookie and gets no cross-site
  check); omit it otherwise. The list is enforced: a route sees a session
  only from a kind it accepts. A registrar route, a mount and a page accept
  `['cookie']` by default, so one that serves API tokens (a session
  `resolveSession` marks `data.authMethod: 'bearer'` or `'api-token'`) now
  sees no session until it declares `credentials: ['cookie', 'token']`; a
  `['token']` route never sees the visitor's cookie session, and a `[]` route
  never calls `resolveSession`.
- `createApp({ accessGate })`, `AccessGate` and `defaultAccessGate` are
  removed: the access chain's order is fixed. Public files are passed as
  `createApp({ assets })` (see the asset index below), not mounted with
  `app.use`.
- `isSameOriginRequest`, `requestSite`, `RequestSite`, `csrfTokenValid`,
  `checkRequestOrigin` and `checkTrustedMutation` (`jsails/plugin-sdk`) are
  removed: register the route with `routes.add` and the access chain runs
  the cross-site check (it never falls back to `Referer` and refuses an
  unsafe request naming no site).
- A check that throws is answered `503 access.fault` (reported with phase
  `authorize`), not `403`; a check that denies an anonymous caller is `401
  request.unauthenticated`. The component update protocol no longer has a
  `csrf_mismatch` code.
- `jsails/security` no longer exports `CSRF_HEADER`, `assertCsrfToken`,
  `AuthError`, `SessionManager`, `InMemorySessionStore`,
  `serializeSessionCookie` or `parseSessionCookie`: sessions come from
  `resolveSession` (for example `@jsails/auth`'s session service or
  `@jsails/sessions`), and nothing in the framework read the in-memory
  manager.
- `crossSiteVerdict`, `requiresOriginCheck`, `isUnsafeMethod`,
  `CrossSiteVerdict`, `forbiddenResponse`, `badRequestResponse` and
  `notFoundResponse` are removed from `jsails/plugin-sdk`: register the
  route with `routes.add` (the access chain refuses a cross-site unsafe
  request to a cookie-accepting route) and throw `notFound()`,
  `forbidden()` or a `ValidationError` from the handler.
- The `publicOrigin` option of `authPlugin`, `AuthHandlerOptions` and
  `ApiTokenHandlerOptions` (`@jsails/auth`) is removed: the access chain
  compares `Origin` with the origin core resolved (`server.origin`,
  `server.hosts`). Configure `server.origin` instead. `handleLogin`,
  `handleRegister` and the other standalone handlers run no cross-site check
  of their own; register them with `routes.add`.
- `authPlugin({ sessionResolver })` (`@jsails/auth`) takes `(request, auth)`,
  where `auth` is a getter that builds the Better Auth instance only when
  called, instead of `(auth, request)` with the instance already built: a
  resolver that needs no database no longer requires the database settings.
- `@jsails/auth`'s device approval and `/api/tokens` routes answer core's
  `401` without a browser session, before their handlers run, and the Better Auth router answers only `GET` and `POST`; a POST to it
  from a client outside a browser sends `Origin`, except the device-flow
  `POST /api/auth/device/code` and `/device/token` and the OAuth
  `/api/auth/callback/:provider`, which read no cookie.
- `blogPlugin({ createRoute: { authorize, publicOrigin } })` is replaced by
  `createRoute: { access }`, a route access (`publicAccess(reason)` or a
  check of the request context, admitting on exactly `true`); a denial is
  core's `401`/`403`.
- `@jsails/admin`'s routes are registrar routes: a panel route that refuses
  the session answers core's `401` (no session for the app) or `403`
  (signed in), not the panel's HTML 403 page; give the app the same session
  resolver the panel uses (`resolveSession` in `jsails.app.js`) so a signed-in
  user is told `403`. A page `POST` reads a form of up to 1 MiB: a page that
  takes uploads sets `maxBodyBytes` (and the media page its `maxBodyBytes`
  option, raised with the library's `maxBytes`).
- The `--blog` starter no longer has `pages/blog/index.tsx`: the blog
  plugin's own route serves `GET /blog`, and a page on the same path is a
  duplicate route (`route.duplicate_route`). Delete it from an app generated
  earlier.
- A page that redirected with a meta refresh returns `reply.redirect(path)`
  from `load` instead (and `reply.redirectExternal(url)`, `reply.notFound()`
  or `reply.props(props, { status, headers, cookies })` for the other
  answers). A `PageRenderer.render` returns a `PageOutcome`, not a string:
  wrap HTML in `documentOutcome(html)` from `jsails/pages`.
- `render: { stream: true }` and `createApp({ render: { stream } })` are
  removed (the config key is refused): export `stream = true` from each page
  that should stream. `export const stream = false` is refused, and so is a
  page exporting `stream` beside `cache` or `cacheControl`.
- `renderRouteStream`, `renderStreamResponse`, `StreamingPageRenderer`,
  `PageStreamRenderOptions` and `RenderStreamOptions` are removed:
  `renderRoute(entry, context, { stream: true })` answers a document whose
  body is a stream, and `Respond.stream` sends any other stream.
- `Respond.redirect` and a server-component action's `redirect` accept only a
  same-origin path (`redirect.invalid_target` otherwise): use
  `Respond.redirectExternal(url)` for another origin, and
  `safeRedirectPath(input, fallback)` for a target that came with the
  request. `assertRedirectTarget` is removed from `jsails/plugin-sdk`.
- `GenerateStaticSiteResult` gains `redirects` and `notFound`, and a custom
  renderer's non-outcome answer fails with `invalid_render`. A page whose
  build-time render is an error page (an error boundary's document, or a
  `reply.props` 4xx) fails the export with `error_status` instead of being
  written: leave the path out of `getStaticPaths`, or answer
  `reply.notFound()`.
- `@jsails/inertia` no longer reads `NODE_ENV`: pass `defineInertia({ mode })`
  (`'development' | 'test' | 'production'`, default `'production'`), which
  sets the carrier's `oversize`, SSR's `onError` and the `encryptHistory`
  warning.
- `createPublicFilesMiddleware` is removed, and so is mounting public files
  with `app.use('*', ...)`: build `createAssetIndex({ roots: [{ dir:
  'public' }] })` and pass it as `createApp({ assets })`, which serves it
  before routing. `createApp({ assetUrl })` is removed with it.
- `generateStaticSite({ publicDir, assetUrl })` takes `assets` (the same
  index) instead; the export copies what the index holds, so a symlink in
  `public/` is left out instead of failing the build.
- `context.assetUrl(path)` returns a string, not a promise: drop the `await`
  and any `Promise.all` around it. The starters' `loadLayout(context)` is
  synchronous.
- A public file now wins over a parametric, catch-all or mount route that
  matches its path, and a public file whose path equals a literal route (or
  `/_jsails/...`, the health path, the readiness path) fails `createApp`
  with `asset.route_collision`: rename or remove one of the two.
- A `<file>.br` or `<file>.gz` beside a file in `public/` is no longer served
  as its compressed variant; it is an ordinary file at its own path.
- `POST`, `PUT`, `PATCH` and `DELETE` on a public file's path answer `405`
  (`Allow: GET, HEAD`), not `404`; `/.well-known/...` under `public/` is
  served.
- Outside development, a file added to `public/` after the server started is
  not served until the next start, and one that changed size answers `500`
  (`asset.stale_assets`): deploy `public/` with the release, not into it.
