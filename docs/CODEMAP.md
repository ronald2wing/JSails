# JSails Codemap

> Workspace layout: the root is a private npm workspace. `core/` is the `jsails`
> package; `plugins/<name>/` are `@jsails/<name>` packages. In the tree below,
> `src/` and `templates/` are relative to `core/`. First-party capability
> packages live under `plugins/<name>/src/` and are listed separately below the
> core tree; the core tree contains the kernel plus the core-owned contracts and
> the `jsails/rich-text`, `jsails/security`, `jsails/semver`, `jsails/plugin-sdk`,
> `jsails/seo`, `jsails/live`, and `jsails/facades` subpaths.

An annotated map of the JSails source tree. Read [architecture](https://jsails.org/docs/architecture)
for the behavior and seams behind these directories. Entries are tagged **[kernel]**
(the inert runtime + seams), **[plugin]** (first-party capability), or **[tooling]**
(CLI/deploy/test orchestration).

Barrel convention: a directory that is a package subpath carries an `index.ts`
barrel; private clusters (`contracts/`, `dev/`, `entry/`, `internal/`, `jsx/`,
`migrations/`, `server/`) do **not** — they are deep-path-imported and marked
"(no public subpath)" below. Nested clusters inside a subpath (for example
`cli/plugins/`, `jamal/production/`, `client/decoding/`) are deep-imported too
and carry no barrel; their siblings with an `index.ts` (`app/config/`,
`server-components/runtime/`, ...) group an internal seam that several modules
import together, so a barrel there is an ownership choice, not a rule.

```text
jsails/
├── src/
│   ├── index.ts                          # [kernel] root entry: re-exports the whole public surface
│   ├── app/                              # [kernel] application runtime
│   │   ├── application.ts                #   createApplication: route discovery + extensions + inert app
│   │   ├── config/                       #   loadAppConfig / validateAppConfig / defineAppConfig (dirs, guards)
│   │   ├── asset-urls.ts                 #   content-hashed asset URL resolver (graceful degradation)
│   │   ├── static-files.ts               #   public/ copy + static serving
│   │   ├── scaffold.ts                   #   writeProjectFiles: validated, rollback-safe file writer
│   │   ├── starter/                      #   createStarterFiles: pure template scaffold generator
│   │   └── plugin.ts                     #   appPlugin / httpAppToken (Hono app service)
│   ├── extensions/                       # [kernel] extension foundation (jsails/extensions)
│   │   ├── extension.ts                  #   runExtensions: ordered setup, requires, HTTP/serve hooks
│   │   ├── plugin-contract.ts            #   definePlugin: extension + deployments/renderer passthrough
│   │   ├── declarative-plugin.ts / contracts.ts
│   │   ├── services.ts                   #   createServiceToken / createServiceRegistry
│   │   ├── interceptors.ts               #   operations/events, before/after interceptors, observers
│   │   └── validation.ts                 #   structural extension-entry validation
│   ├── facades/                          # [kernel] server-only facade proxy + AsyncLocalStorage app scope (jsails/facades)
│   │   ├── app-scope.ts                  #   currentAppScope / withAppScope
│   │   ├── facade.ts                     #   facade / installFacades / FacadeError
│   │   └── index.ts                      #   barrel
│   ├── routing/                          # [kernel] lexical route discovery (no import, no connection)
│   │   ├── routes.ts                     #   discoverRoutes: group stripping, layout chain, route/param classification
│   │   ├── middleware.ts                 #   per-route middleware: types, registry, resolver, chain runner, validator
│   │   └── signed-urls.ts               #   HmacUrlSigner: HMAC-SHA256 signed URLs with expiry, value-free errors
│   ├── rich-text/                        # [kernel] persisted rich-text data contract (jsails/rich-text)
│   │   ├── document.ts                   #   block document model (paragraph/heading/list/quote/code/divider)
│   │   ├── editor.ts                     #   editor-facing helpers over the document model
│   │   └── index.ts                      #   barrel
│   ├── security/                         # [kernel] session/CSRF primitives shared by runtime/admin/auth (jsails/security)
│   │   ├── csrf.ts                       #   session + cookie/CSRF verification primitives
│   │   └── index.ts                      #   barrel
│   ├── semver/                           # [kernel] browser-safe semver subset (jsails/semver)
│   │   └── index.ts                      #   re-exports the plugin-manifest semver helpers
│   ├── seo/                              # [kernel] per-page metadata, head tags, JSON-LD, sitemap/robots (jsails/seo)
│   │   ├── metadata.ts                   #   defineMetadata + PageMetadata/OpenGraph/Twitter types (dependency-free)
│   │   ├── head.ts                       #   buildHeadTags / injectHead / assertOrigin
│   │   ├── json-ld.ts                    #   jsonLd / serializeJsonLd
│   │   ├── sitemap.ts                    #   buildSitemapXml
│   │   ├── robots.ts                     #   buildRobotsTxt
│   │   ├── asset-attrs.ts                #   fontFace / imageAttrs
│   │   ├── service.ts                    #   SeoService + seoToken + resolveSeoService
│   │   ├── errors.ts                     #   SeoError (value-free)
│   │   └── index.ts                      #   barrel
│   ├── server/                           # [kernel] Hono HTTP pipeline (no public subpath; surfaced via entry/http-surface.ts)
│   │   ├── app.ts                        #   createApp: middleware, auth, API/pages dispatch
│   │   ├── server-http.ts                #   createHttpServer (never listens)
│   │   └── api-routes.ts / page-routes.ts / request-pipeline.ts / cache-control.ts / security-headers.ts
│   ├── pages/                            # [kernel] compiled page loading + rendering, cache resolution
│   │   ├── page.ts                       #   loadPageModule, loadLayoutModule, renderRoute (layout fold), renderStreamResponse (progressive streaming), pageCacheKey + opt-in revalidate caching
│   │   ├── cache-resolver.ts                #   tryResolveCacheStore: graceful cache-provider resolution
│   │   └── static-site/                  #   generateStaticSite (static export)
│   ├── contracts/                         # [kernel] shared type contracts (no public subpath): http/render/component
│   ├── dotenv.ts                          # [kernel] assembleEnvironment: cumulative .env/.env.local/.env.<NODE_ENV> merge
│   ├── environment.ts                     # [kernel] readEnvironment / readDatabaseEnvironment / readValkeyEnvironment
│   ├── entry/                             # [kernel] root-only public surfaces (no subpath): *-surface.ts (http/app/environment/cli/migrations)
│   ├── internal/                          # [kernel] internal shared helpers (no public subpath): base64/bytes/concurrency/config-module/deep-equal/defaults/duration/primitive-guards/http-responses/json-safe/redirect/serialize-error/set-cookie/trusted-mutation/zod
│   ├── symbols/                           # [kernel] framework-symbols preload (jsails/symbols, jsails/symbols/client)
│   │   ├── framework-symbols.ts           #   FrameworkSymbol mechanism + declaration model (project onto globalThis)
│   │   ├── framework-symbol-catalog-scan.ts       #   scanFrameworkCatalog / deriveFrameworkSymbols (derives the table at build:meta)
│   │   ├── projection.ts                  #   projectFrameworkSymbols + collision/namespace helpers
│   │   ├── install-server.ts              #   installFrameworkSymbols / installProjectSymbols (server preload)
│   │   ├── install-browser.ts             #   installBrowserSymbols (browser-safe projection)
│   │   ├── index.ts                       #   barrel: jsails/symbols (server)
│   │   └── client.ts                      #   barrel: jsails/symbols/client (browser)
│   ├── database/                         # [kernel] data layer
│   │   ├── naming-strategy.ts            #   JsailsNamingStrategy: join columns follow <relation>_<referenced column>
│   │   ├── data-source.ts                #   JsailsDataSource (postgres/mysql/mariadb + sqljs/sqlite)
│   │   ├── model-schema.ts               #   TypeORM metadata -> portable SchemaState (M2M/composite/deferrable aware)
│   │   ├── schema-hints.ts               #   rename/table/temporary-default/replacement hints from the model registry
│   │   ├── polymorphic.ts                #   @PolymorphicRelation + loadPolymorphic[Inverse] / resolvePolymorphic*
│   │   ├── relation-metadata.ts           #   resolveRelation / resolveRelationPath (pure, connectionless)
│   │   ├── metadata-lookups.ts            #   shared TypeORM metadata lookups (findJoinColumn)
│   │   ├── relation-loader/              #   loadRelation / loadRelations (batch IN-clause: M2O/O2M/O2O/M2M/polymorphic, nested)
│   │   │   ├── loaders.ts                 #   per-relation-kind loaders
│   │   │   └── batch.ts                   #   shared collect/group/index/assign phases
│   │   ├── relation-query.ts              #   whereHas/has/exists (portable EXISTS) + relationCount/relationAggregate
│   │   ├── query-expressions.ts           #   F / Q predicate tree / Case-When + applyQ / addCaseSelect
│   │   ├── model-query.ts                 #   query() -> chainable ModelQuery (where/whereHas/has/includes/executors + annotate/in_batches/find_each)
│   │   ├── file-data-source.ts           #   read-only in-memory sqljs source
│   │   ├── entity-subscribers.ts         #   defineEntityHooks / createEntitySubscriber
│   │   ├── attribute-encryption.ts        #   encrypts: transparent field encryption/decryption (AES-256-GCM)
│   │   ├── counter-cache.ts               #   counterCache / touch / autosave / nestedAttributes (hook bridges)
│   │   ├── through-relations.ts            #   resolveThroughRelation + ThroughRelation (has_many :through)
│   │   ├── active-storage.ts              #   hasOneAttached / JsailsAttachment / activeStorageEntities (Disk-backed)
│   │   ├── fixtures.ts                    #   defineFixture / loadFixtures / withRollback / FixtureError
│   │   ├── system-checks.ts               #   createSystemCheckRegistry / defineSystemCheck / SystemCheckError
│   │   ├── factories.ts                  #   defineFactory (entity fixtures)
│   │   ├── schema-editor.ts              #   DDL translation, deferrable-gated driver mapping, preflight
│   │   └── plugin.ts                     #   databasePlugin / databaseToken
│   ├── data/                             # [kernel] named data contracts (jsails/data)
│   │   ├── define-data.ts                #   defineData / defineDataList / DataContract / DataValue / JSON Schema
│   │   ├── model-data.ts                 #   @jsails.data field registry shared with defineModel
│   │   └── index.ts                      #   barrel
│   ├── services/                         # [kernel] domain services (root export)
│   │   └── define-service.ts              #   defineService / Service / ServiceInputError (input schema + run)
│   ├── migrations/                       # [kernel] declarative, desired-state schema reconciliation (no public subpath; surfaced via entry/migrations-surface.ts)
│   │   ├── schema-types.ts               #   Column/Table/Index/Unique/ForeignKey definitions (+ composite PKs/FKs, deferrable)
│   │   ├── schema-validation.ts          #   identifier + scalar-literal validation (isValidIdentifier / assertLiteralMatchesType)
│   │   ├── schema-normalize.ts           #   normalizeX canonicalization (columns/tables/constraints/schema)
│   │   ├── schema-compare.ts             #   canonical *Equal comparators (columnsEqual / schemasEqual / ...)
│   │   ├── autodetector.ts               #   declared-vs-live diff (M2M/join-table aware); requireDestructive gates unsafe ops
│   │   ├── operations.ts                 #   operation types + applyOperations
│   │   ├── reconciler.ts                 #   reconcileDataSource + isOperationDestructive (safe/destructive classification)
│   │   ├── schema-executor.ts            #   executeSchemaPlan (connect/release discipline, applies a plan)
│   │   ├── sql-preview.ts                #   non-connecting driver SQL preview for db:diff --sql
│   │   └── data.ts                       #   defineDataMigration / createDataMigrationRegistry (dependency order + transactions)
│   ├── api/                              # [kernel] browser-safe API building blocks (jsails/api)
│   │   ├── resource.ts                   #   createResourceHandlers over a ResourceStore
│   │   ├── serialization.ts              #   defineSerializer
│   │   ├── validation.ts                 #   schema builders + ValidationError
│   │   ├── pagination.ts                 #   normalized pagination
│   │   ├── filters.ts                    #   parseFilters (search/sort/filter coercion)
│   │   ├── permissions.ts                #   require/and/or/resourcePolicy + createPermissionRegistry
│   │   ├── throttling.ts                 #   throttle (fixed-window 429)
│   │   ├── responses.ts                  #   Respond.json / html / text / xml / redirect / noContent / download
│   │   ├── forms.ts                      #   readForm (bounded form decoding)
│   │   ├── openapi.ts                    #   generateOpenApi (deterministic 3.0 doc)
│   │   ├── router.ts                     #   createResourceRouter (deterministic route manifest)
│   │   └── versioning.ts                 #   resolveApiVersion (URL-then-Accept precedence)
│   ├── diagnostics/                      # [kernel] diagnostics recorder contract (jsails/diagnostics)
│   │   ├── contract.ts                    #   entry/stat types, DiagnosticsRecorder/Diagnostics interfaces, token
│   │   └── index.ts                       #   barrel (impl + watchers + plugin live in @jsails/diagnostics)
│   ├── encryption/                       # [plugin] symmetric AES-256-GCM encryption (jsails/encryption)
│   │   ├── index.ts                       #   barrel: types + error + encrypter + plugin
│   │   ├── encrypter-types.ts            #   Encrypter / EncrypterOptions / EncryptOptions / DecryptOptions
│   │   ├── errors.ts                      #   EncryptionError (value-free)
│   │   ├── encrypter.ts                   #   AesEncrypter (AES-256-GCM, HKDF key, rotation)
│   │   └── plugin.ts                      #   encryptionPlugin / encryptionToken
│   ├── client/                           # [plugin] browser runtime (jsails/client)
│   │   ├── index.ts                      #   startClient (idempotent)
│   │   ├── islands.ts                    #   registerIsland + hydration (WeakMap identity)
│   │   ├── navigation.ts                 #   Turbo soft navigation + morphComponent
│   │   ├── streams.ts                    #   turboStreamMessage + *Stream string builders (no DOM, server-safe)
│   │   ├── native.ts                     #   Hotwire Native path config + nativeApp detection
│   │   ├── native-protocol.ts            #   bridge message envelope + component registry + visit-proposal contract
│   │   ├── path-config-loader.ts         #   path-configuration loader: data/file/server sources + merge
│   │   ├── bindings/                     #   server-component DOM binding layer (controller/rules/uploads/control-values)
│   │   ├── decoding/                     #   browser-safe state/props decoding (limits/props/proto-guard)
│   │   ├── model/                        #   createModel/bindModel: browser-safe projection of server state into @preact/signals (jsails/client/model)
│   │   └── state-decoding.ts             #   state controller: model, update queue, CSRF POST
│   ├── server-components/                # [plugin] signed, stateless HotView components
│   │   ├── component.ts                  #   defineServerComponent / defineAction
│   │   ├── authoring/                    #   friendly surface: defineComponent, localAction/serverAction, defineStyle (lowers onto defineServerComponent)
  │   │   ├── extension.ts                  #   serverComponentsPlugin() extension + render helpers
  │   │   ├── runtime/index.ts               #   update endpoint: signature/CSRF/origin/state machine
  │   │   ├── snapshot.ts                   #   HMAC snapshot signing + parsing
  │   │   ├── protocol.ts                   #   wire markers/constants (shared with client)
  │   │   ├── directives.ts                 #   confirmAttrs/loadingTargetAttrs/showAttrs/textAttrs/sortAttrs/intersectAttrs/refAttrs/ignoreAttrs builders + protocol constants
  │   │   ├── pagination.ts                 #   pagerAttrs: array-page call-attribute maps (reuses Page<T>)
  │   │   ├── url-binding.ts                #   seedFromUrl: query-string seeding for urlBinding fields
  │   │   ├── downloads.ts                  #   download(id) action return + createDownloadReferenceSigner
  │   │   ├── validation-meta.ts            #   extractFieldRules / serializeFieldRules
  │   │   ├── form.ts                       #   defineForm: HotView form objects for components
  │   │   ├── nested.ts                     #   defineNestedComponent / renderNested: child components
  │   │   └── uploads.ts                    #   signed upload references
│   ├── validation/                       # [kernel] composable validation rules (jsails/validation)
│   │   ├── index.ts                      #   barrel: rules + validateFields
│   │   └── rules.ts                      #   required/email/url/min/max/regex/inList/confirmed/when
│   ├── http/                             # [kernel] fetch-based HTTP client (jsails/http)
│   │   ├── index.ts                      #   barrel
│   │   ├── client.ts                     #   FetchHttpClient (injectable fetch, retries, value-free errors)
│   │   └── fake.ts                       #   FakeHttpClientImpl (test stub: respond(handler), no-history delegation)
│   ├── plugins/                          # [plugin] plugin system (jsails/plugins)
│   │   ├── manifest/index.ts / discovery/index.ts / check.ts / activation.ts / installer.ts
│   │   ├── schema.ts                       #   collectPluginSchemaEntities (static plugin-owned schema)
│   │   ├── enablement.ts / state-store.ts / database-state-store.ts / database-state-entity.ts
│   │   ├── archive.ts / provenance.ts / download-capability.ts
│   │   ├── live-only.ts                   #   isLiveOnlyPlugin / collectLiveOnlyPluginIds (needsLive detection)
│   ├── plugin-sdk/                       # [kernel] supported plugin-author seam (jsails/plugin-sdk)
│   │   └── index.ts                      #   re-exports shared internals (errors/JSON/cleanup/HTTP/trusted-mutation/zod)
│   ├── jobs/                             # [plugin] BullMQ jobs

│   │   ├── application-job.ts            #   ApplicationJob base class (schema/handle + job context tools)
│   │   ├── discovery.ts                  #   loadJobRegistryFromDirectory: recursive *.job.js autoload
│   │   ├── command-job.ts                #   defineCommandJob: wrap a CLI command as a schedulable job
│   │   ├── registry.ts                   #   defineJob / createJobRegistry
│   │   ├── runtime.ts                    #   JobsRuntimeImpl (provider-neutral controller)
│   │   ├── bullmq-adapter.ts             #   BullMQAdapter (default transport)
│   │   ├── runtime-config.ts             #   validateRuntimeConfig + URL resolution + jsails.schedules.json autoload
│   │   ├── middleware.ts                 #   composeMiddleware / per-job middleware (worker-side)
│   │   ├── chain.ts                      #   createJobChain / chainMiddleware (sequential, on-success)
│   │   ├── batch.ts                      #   createJobBatch / createBatchMiddleware / InMemoryBatchCoordinator (fan-out + in-process coordinator)
│   │   ├── shared-batch-coordinator.ts    #   SharedBatchCoordinator (multi-process batch progress via CacheStore)
│   │   ├── metrics.ts                    #   InMemoryJobMetrics (completed/failed by name, in-memory)
│   │   ├── metrics-history.ts            #   JobMetricsHistoryImpl (time-stamped snapshot ring)
│   │   ├── tags.ts                       #   normalizeTags / tagFilter (job classification labels)
│   │   ├── events.ts                     #   job lifecycle events: jobPushed/completed/failed/retried
│   │   ├── failed.ts                     #   InMemoryFailedJobStore (ring buffer with retry + age-based retention + tag filter)
│   │   ├── overlap.ts                    #   createOverlapMiddleware (mutex-backed concurrency gate, OVERLAP_OPTION_KEY)
│   │   ├── paused-schedules.ts           #   MemoryPausedScheduleStore / CachePausedScheduleStore (durable schedule pause)
│   │   └── queue.ts / scheduler.ts / connection.ts / plugin.ts
│   ├── broadcast/                        # [plugin] Socket.IO broadcast
│   │   ├── server.ts / socketio-adapter.ts / redis.ts / client.ts / contracts.ts / plugin.ts
│   ├── cache/                            # [plugin] cache contract only (jsails/cache)
│   │   ├── store.ts                        #   CacheStore contract + CacheError
│   │   ├── mutex.ts                        #   MutexStore contract + MutexError + isMutexStore guard
│   │   ├── tokens.ts                       #   cacheToken / mutexToken (core-owned service tokens)
│   │   └── index.ts                        #   barrel (contract only); impls live in plugins/cache/src/ (@jsails/cache)
│   ├── mcp/                               # [plugin] MCP introspection server (jsails/mcp)
│   │   ├── index.ts / tool.ts             #   defineMcpTool / createMcpToolRegistry / buildJsailsMcpServer
│   │   ├── server.ts                      #   createMcpServer over the official @modelcontextprotocol/server SDK (stdio)
│   │   ├── client.ts                      #   createInProcessMcpClient (in-process, zero-I/O over a local registry)
│   │   └── tools.ts                       #   jsailsMcpTools: describe / inspect_routes / explain_route / schema
│   ├── models/                            # [kernel] one-import Active Record authoring surface (jsails/models)
│   │   ├── index.ts                       #   convenience re-export barrel (ApplicationRecord, decorators, DSL)
│   │   ├── define-model.ts                #   defineModel: the only TypeORM lowering seam
│   │   └── bootstrap.ts                   #   bootstrapModels: import the compiler-generated model registry
│   ├── filesystem/                       # [kernel] keyed Disk + FileSystem service contract (jsails/filesystem)
│   │   ├── disk.ts                        #   Disk contract + DiskError (keyed blob store over relative paths)
│   │   ├── service.ts                     #   FileSystem interface + filesystemToken
│   │   └── index.ts                       #   barrel (impls + plugin live in @jsails/filesystem)
│   ├── i18n/                              # [kernel] dependency-free translator + server-only loader/plugin (jsails/i18n, jsails/i18n/loader, jsails/i18n/server)
│   │   ├── index.ts                       #   barrel (browser-safe public surface)
│   │   ├── translator.ts                  #   MessageTranslator: dot-path lookup, scope/default, interpolation, Intl.PluralRules, exists, onMissing
│   │   ├── localize.ts                    #   createLocalizer: date/time/datetime/number/currency/percent via Intl
│   │   ├── flatten.ts                     #   flattenMessageKeys: dotted keys (plural entries collapse to their parent)
│   │   ├── extract.ts                     #   extractTranslationKeys: acorn-based key scanner for i18n:missing
│   │   ├── loader.ts / catalog-loader.ts  #   (server-only) Loader / FileLoader / ArrayLoader / mergeCatalogMaps
│   │   ├── plugin.ts                      #   (server-only) i18nPlugin + i18nToken + I18nService
│   │   ├── facade.ts                      #   (server-only) global I18n + bare t/l/choice re-exports
│   │   └── request-locale.ts              #   (server-only) AsyncLocalStorage ambient locale
│   ├── introspect/                       # [kernel] static + live introspection (shared by CLI + MCP)
│   │   ├── index.ts                       #   barrel: sections/providers/route registration
│   │   ├── sections.ts                    #   INTROSPECT_SECTIONS + IntrospectProvider contract
│   │   ├── builtin-providers.ts           #   routes/plugins/components/pipeline/config/health + live providers
│   │   ├── describe.ts                    #   buildDescribeResult: static definition snapshot (app/routes/plugins/components/schema)
│   │   ├── explain.ts                     #   buildExplainResult + matchRoute: resolve one path against the route manifest
│   │   └── route.ts                       #   GET /_jsails/introspect + collision guard
│   ├── live/                             # [kernel] live reactivity layer (jsails/live; server-only)
│   │   ├── change-record.ts / change-capture.ts / change-log.ts
│   │   ├── projection.ts / publication.ts / publication-registry.ts
│   │   ├── write-fence.ts / multiplexer.ts / canonical-params.ts
│   │   ├── live-service.ts               #   createLiveService / assertPublicationShape + wire messages
│   │   └── index.ts                      #   barrel
│   ├── signals/                           # [kernel] service-layer signal-bus contract (jsails/signals)
│   │   └── signal-bus.ts / request-signals.ts / token.ts / index.ts
│   ├── deploy/                           # [tooling] pure deploy-config generators
│   │   ├── registry.ts / builtin-generators.ts / portable-path.ts
│   │   ├── valkey-config.ts / database-config.ts
│   │   ├── hosting-config.ts / hardening-config.ts / once-config.ts
│   ├── jamal/                            # [tooling] deployment/planning CLI
│   │   ├── command.ts / config.ts / compose.ts / docker.ts
│   │   ├── config.ts                       #   JamalConfig + SSH/health/logging/volume/env breadth (JamalSshConfig, JamalHealthConfig, JamalLoggingConfig, JamalVolumeSpec, JamalEnvEntry, parseVolumeSpec)
│   │   ├── registry.ts                   #   planRegistrySetup / planRegistryRemove / planRegistryLogout (docker login planners)
│   │   ├── prune.ts                      #   planPrune + planPruneExecution (image retention over PruneScope)
│   │   ├── audit.ts                      #   planAudit (security checklist)
│   │   ├── snapshot.ts                   #   planSnapshot / planRestore + planImportDb / planExportDb (db dump/restore + host-file import/export over DbFileFormat)
│   │   ├── describe.ts                   #   describeJamal / planLaunchArgv / planSshArgv (config projection + platform opener + ssh argv)
│   │   ├── app.ts                        #   jamal app (app-container lifecycle over ssh)
│   │   ├── accessory.ts                  #   jamal accessory (backing-service lifecycle over ssh)
│   │   ├── cache-proxy.ts                #   cache-proxy CLI: plan (resolved VCL) + status; read-only
│   │   └── production/                   #   plan/execute/release/process-runner/build/hooks/lock/proxy/cache-proxy/proxy-validation/history/transport/accessories
│   │       ├── proxy.ts                    #   ProxyBootOptions / ProxyDeployOptions + proxyBootArgv / proxyDeployArgv (path-prefix routing, TLS staging, metrics port, header/host controls)
│   │       ├── cache-proxy.ts              #   opt-in Varnish cache proxy: config → VCL (default-deny), release steps (write-vcl/boot/health), switch target
│   │       └── hooks.ts                    #   planDevHook over DevHookPhase (pre/post-start, pre/post-import-db)
│   ├── cli/                              # [tooling] CLI command kit + helpers
│   │   ├── index.ts                        #   lazy bootstrap (512 lines): early routing + `runCli`; no heavy deps at import
│   │   ├── dispatch.ts                     #   heavy command imports (TypeORM/BullMQ/Hono/Preact/Vite/Jamal), dynamic-imported only on execute
│   │   ├── command-catalog.ts / command-registry.ts / discovery.ts
│   │   ├── plugins-commands.ts / owned-process-tree.ts
│   │   ├── inspect-commands.ts             #   inspect routes (read-only route manifest)
│   │   ├── describe-commands.ts           #   describe (CLI wrapper: args + rendering over introspect/describe.ts)
│   │   ├── explain-commands.ts            #   explain (CLI wrapper: args + rendering over introspect/explain.ts)
│   │   ├── app-shape-commands.ts          #   app:shape (live-only plugins for a target deployment shape)
│   │   ├── agents-setup-commands.ts       #   agents:setup (.mcp.json + AGENTS.md + skill)
│   │   ├── plugins/resolve.ts              #   plugins resolve (merged enablement, conflict flagging)
│   │   ├── schedule-commands.ts            #   schedules (read-only schedule list CLI)
│   │   ├── seeder-commands.ts / queue-commands.ts / make-commands.ts / convert-component-commands.ts / schema-commands.ts / command-signature.ts
│   │   ├── auto-import-commands.ts        #   inject:auto-imports: scoped hook import pass over compiled server output

│   ├── dev/                              # [tooling] `dev` watch/restart runtime (no public subpath)
│   │   ├── dev-runtime.ts / serve-child.ts #   process management: classified fs.watch, serve child lifecycle, scoped auto-import watch
│   │   ├── change-classify.ts              #   classifyChange / mergeChangeClasses: server-restart vs client-reload vs ignore
│   │   ├── dev-generation.ts               #   build generation file + polling channel shared by the dev parent and serve child
│   │   ├── plugin.ts                       #   devPlugin: mounts the SSE route and the HTML injection middleware
│   │   ├── live-reload.ts                  #   devReloadScript / liveReloadResponse: generation-tracked EventSource reload
│   │   ├── html-injection.ts               #   injectReloadScript / devReloadMiddleware: append the reload client to HTML responses
│   │   └── readiness.ts                    #   quiescence-window + 2xx probe readiness check (no fixed-sleep polling)
│   ├── testing/                          # [tooling] in-process test harness (jsails/testing)
│   │   ├── app.ts / server-components.ts  #   createTestApp / createComponentTestHarness
│   ├── support/                          # [kernel] human-first helper namespaces (jsails/support + jsails/support/server)
│   │   ├── index.ts                       #   browser-safe core barrel: 8 namespaces + domain errors (no node:*, no export *)
│   │   ├── errors.ts                      #   SupportError abstract base (value-free, stable code)
│   │   ├── strings.ts / numbers.ts / time.ts / collections.ts / async.ts / encoding.ts / urls.ts / cryptography.ts
│   │   │                                  #   browser core: Str / Num / Time / Arr / Async / Encoding / Url / Cryptography (+ per-domain errors)
│   │   ├── server-barrel.ts               #   server barrel: re-exports the browser core + the .server.ts addendum
│   │   ├── files.server.ts                #   Files (native fs/promises / tinyglobby) + FilesError
│   │   ├── media-detect.server.ts         #   Media (mime-types / file-type / image-size) + MediaError
│   │   ├── cookie.server.ts               #   Cookie (cookie + owned Set-Cookie parser) + CookieError
│   │   ├── cryptography.server.ts         #   re-exports the SAME Cryptography + server-only hashSync/hmacSync/timingSafeEqual/ServerCryptography
│   │   └── frontmatter.server.ts          #   parseFrontmatter (yaml) / serializeError (owned) + FrontmatterError
│   ├── jsx/                              # [kernel] render subpaths (no barrel; each file is its own subpath)
│   │   ├── jsx-runtime.ts / render-to-string.ts   # jsails/jsx-runtime, jsails/render-to-string
│   ├── build/                            # [tooling] jsails/build: the Vite-plugin surface (guards + 'use server' transform)
│   │   ├── clean-bundle-check.ts         #   assertServerOnlyModules + cleanBundlePlugin (generateBundle hook)
│   │   ├── server-directive.ts           #   stripServerDirectives: pure 'use server' function-body rewrite (oxc via rolldown/parseAst)
│   │   ├── server-directive-plugin.ts    #   serverDirectivePlugin (enforce:'pre' transform hook)
│   │   └── index.ts                      #   barrel: bundler guards + re-exported autoloadPlugin/compilerPlugin
│   ├── compiler/                         # [tooling] N1 auto-import compiler + component compiler (surfaced via jsails/build)
│   │   ├── scope-walker.ts               #   collectUnmatchedIdentifiers: two-phase scope resolution (estree via rolldown/utils)
│   │   ├── lexical-walk.ts               #   walkLexicalFiles: lexical file walker (no symlinks)
│   │   ├── project-symbols-scan.ts        #   scanAutoload: N1 auto-import symbol index (app/ + server/ + shared/)
│   │   ├── component-shape.ts             #   component shape analysis: detectComponentShape / planSplit / planCombine
│   │   ├── project-symbols-imports.ts     #   injectAutoloadImports: import-injection transform (RolldownMagicString)
│   │   ├── project-symbols-dts.ts         #   generateProjectSymbolsDts: ambient .jsails/project-symbols.{app,server}.d.ts
│   │   ├── project-symbols-plugin.ts      #   autoloadPlugin (enforce:'pre' buildStart/transform/buildEnd)
│   │   ├── scoped-auto-imports.ts         #   injectScopedAutoImports: ui/client hook import injection (Vite + post-tsc)

│   │   ├── errors.ts                     #   CompilerError/CompilerBuildError: value-free component-compiler errors
│   │   ├── diagnostics.ts                #   DiagnosticBag: collect-then-decide diagnostics + rendered frames
│   │   ├── estree.ts                      #   minimal ESTree guards shared by the model/component scanners
│   │   ├── source-lines.ts               #   lineStartOffsets/offsetToPoint/trimBlankLines: offset ↔ {line,column} (1-based)
│   │   ├── source-map.ts                 #   SourceMapBuilder: hand-rolled VLQ source maps (line-granular)
│   │   ├── regions.ts                    #   extractRegions: #region model/server/style/view + preamble
│   │   ├── directives.ts                 #   lowerDirective: js-* attribute → render-tool call table
│   │   ├── emit.ts                       #   emitComponent: shape-aware reassembly + directive lowering
│   │   ├── template-ast.ts               #   parseTemplate: Vue-like <template> grammar → TemplateNode[]
│   │   ├── template-lower.ts             #   lowerTemplate: TemplateNode[] → JSX (js-if/js-for/js-* dialects)
│   │   ├── template.ts                   #   lowerTemplateRegion: the U3 seam (leading <template> → JSX)
│   │   ├── resolve-components.ts         #   resolveComponentTags: capitalized tag → app/components import
│   │   ├── sfc.ts                        #   parseSfc: .jsails block scanner (<script>/<template>/<style>/<server>)
│   │   ├── sfc-emit.ts                   #   emitSfc: .jsails blocks → defineComponent module (+ css side-channel)
│   │   ├── compiler-plugin.ts            #   compilerPlugin (.jsails virtual-id dispatch + #region transform; off by default)
│   │   ├── plugin-declaration-scan.ts    #   scanPluginDeclarations / loadFrameworkAutoloadDeclaration (inert JSON)
│   │   ├── plugin-declarations-emit.ts   #   emitPluginDeclarationsModule (.jsails/plugin-declarations.js)
│   │   └── index.ts                      #   barrel: re-exports the compiler surface
│
├── templates/
│   ├── starter/                          # default static-site starter (29 files)
│   │   ├── pages/                        #   home, about, blog/*, tags/*, categories/*
│   │   ├── content/                      #   Markdown posts and about page
│   │   ├── ui/  client/main.tsx          #   shared UI + browser entry
│   │   ├── server/content.ts  shared/site.ts
│   │   ├── jsails.app.js.template        #   plugins.use: [] + static export config
│   │   ├── package.json / tsconfig*.json / vite.config.js
│   │   └── .gitignore
│   ├── starter-web/                      # server-rendered web starter (admin/blog share these)
│   │   ├── pages/                        #   index, about, tasks, login, dashboard, device, blog/*
│   │   ├── components/                   #   task-list.tsx (demo server component)
│   │   ├── ui/                           #   layout, components, counter, styles
│   │   ├── client/main.tsx               #   browser entry (registerIsland + startClient)
│   │   ├── api/  app/  commands/  scripts/  test/  auth/
│   │   ├── jsails.app*.js.template       #   per-variant app config (admin/blog)
│   │   ├── jsails.config*.js.template    #   per-variant migration/data-source config
│   │   ├── package.json / tsconfig*.json / vite.config.js / playwright.config.ts / jamal.config.js
│   │   └── .gitignore / .env.auth.example
│   └── starter-cli/                      # CLI-only starter (same framework, no web surface)
│       ├── app/application-command.ts / commands/hello.ts
│       ├── jsails.app.js.template        #   real app config: plugins.use: [] + extension seam
│       └── package.json / tsconfig.json / .gitignore
│
├── scripts/                              # verify-starter, verify-integrations, run-tests harnesses
├── test/                                 # framework unit tests (node --test over dist/)
├── package.json                          # deps + scripts + exports subpaths (see below)
├── tsconfig.json / eslint.config.mjs / .prettierrc.json
└── AGENTS.md / README.md / docs/
```

## Plugin packages

First-party capability packages under `plugins/<name>/` (each is `@jsails/<name>`, source in `src/`):

```text
plugins/
├── admin/                    # @jsails/admin — admin panel: resources, pages, widgets, charts, actions, jobs dashboard
├── admin-plugin-manager/     # @jsails/admin-plugin-manager — admin plugin install/enable/settings surface
├── ai/                       # @jsails/ai — provider-neutral AI runtime + data-backed AI tools
├── auth/                     # @jsails/auth — Better Auth over MariaDB: sessions, roles, device flow, API tokens
├── blog/                     # @jsails/blog — tenant-free blog CMS: content model, repository, admin resource, persistence
├── cache/                    # @jsails/cache — cache/mutex store implementations, rate limiter, plugins
├── content/                  # @jsails/content — Markdown/SSG collections, taxonomies, sections, feeds, sitemap
├── diagnostics/              # @jsails/diagnostics — in-memory recorder, watchers, exporters, tags, plugin
├── editor/                   # @jsails/editor — Editor.js rich-text: conversion, DOM mount, Preact island, server render
├── filesystem/               # @jsails/filesystem — Disk implementations, variants, rich text, plugin
├── flags/                    # @jsails/flags — feature flags: memory/DB stores, scopes, admin page
├── inertia/                  # @jsails/inertia — Inertia page adapter
├── live/                     # @jsails/live — Socket.IO live reactivity transport plugin
├── logging/                  # @jsails/logging — record-first structured logging: channels, formatters, plugin
├── mail/                     # @jsails/mail — transport-agnostic mail seam: SMTP, callback, in-memory transports
├── media/                    # @jsails/media — disk-backed media library: uploads, metadata, selection, references
├── notifications/            # @jsails/notifications — multi-channel delivery seam: in-memory + mail channels
├── plugin-tools/             # @jsails/plugin-tools — canonical shared tool modules for plugin authors
├── sessions/                 # @jsails/sessions — database-backed session entity + store
├── signals/                  # @jsails/signals — registry-backed signal bus plugin
├── tenancy/                  # @jsails/tenancy — opt-in tenant/membership schema + tenant resolution
└── theme/                    # @jsails/theme — browser-safe CSS custom-property theme tokens, named themes, activation
```

## Package `exports` subpaths

| Subpath | Module | Notes |
| --- | --- | --- |
| `.` | `src/index.ts` | Root entry; pulls in `reflect-metadata` + TypeORM |
| `./package.json` | `package.json` | Package metadata subpath |
| `./api` | `src/api/` | Browser-safe schemas/serializers/pagination/resources, `Respond` response helpers, router + versioning |
| `./app` | `src/app/` | Application runtime assembly (createApplication / createApp) |
| `./broadcast` | `src/broadcast/` | Socket.IO broadcast server + attachBroadcast |
| `./broadcast/client` | `src/broadcast/client.ts` | Socket.IO browser client |
| `./build` | `src/build/` + `src/compiler/` | Client-bundle server-only guards, the `'use server'` transform, the N1 auto-import compiler, the `#region` component compiler, and the `.jsails` single-file-component compiler |
| `./cache` | `src/cache/` | Cache/MutexStore contracts + service tokens (`@jsails/cache` owns the implementations) |
| `./client` | `src/client/` | Browser island/Turbo/component runtime + Hotwire Native path config |
| `./client/model` | `src/client/model/` | Browser-safe createModel/bindModel projection of server state into signals |
| `./data` | `src/data/` | Named data contracts (`defineData`/`defineDataList`, `DataValue`, lazy JSON Schema) |
| `./database` | `src/database/` | Active Record data layer + migrations + query seams |
| `./deploy` | `src/deploy/` | Pure deploy-config generators + registry |
| `./dev` | `src/dev/` | Dev plugin, change classification, build generation, and the live-reload response (server-only) |
| `./diagnostics` | `src/diagnostics/` | Diagnostics recorder contract (types, interfaces, token); impl + watchers + plugin in `@jsails/diagnostics` |
| `./encryption` | `src/encryption/` | Symmetric AES-256-GCM encryption with key rotation |
| `./extensions` | `src/extensions/` | ORM/HTTP-free extension foundation + type-only author contracts |
| `./facades` | `src/facades/` | Server-only facade proxy + AsyncLocalStorage app scope |
| `./filesystem` | `src/filesystem/` | Disk/FileSystem contracts; impls + plugin in `@jsails/filesystem` |
| `./http` | `src/http/` | Fetch-based HTTP client with injectable fetch, value-free errors |
| `./i18n` | `src/i18n/` | Dependency-free translator (scope/default/plurals) + `localize()` |
| `./i18n/loader` | `src/i18n/loader.ts` | Server-only catalog loading: `Loader`, `FileLoader`, `ArrayLoader` |
| `./i18n/server` | `src/i18n/facade.ts` | Server-only global `I18n` + bare `t`/`l`/`choice` re-exports |
| `./introspect` | `src/introspect/` | Opt-in runtime introspection endpoint |
| `./jamal` | `src/jamal/` | Deployment/planning CLI (Kamal + Sail in TypeScript) |
| `./jobs` | `src/jobs/` | Provider-neutral job runtime + middleware + chaining + batching + scheduling/overlap + metrics + tags + events + failed-job store |
| `./jsx-runtime` | `src/jsx/jsx-runtime.ts` | Thin Preact JSX runtime re-export |
| `./live` | `src/live/` | Server-only live reactivity: change capture/log, publications, write fence, multiplexer, live service |
| `./mcp` | `src/mcp/` | MCP tool registry, official server, and in-process client |
| `./models` | `src/models/` | One-import Active Record authoring surface (`defineModel` + `bootstrapModels`) |
| `./pages` | `src/pages/` | Compiled page loading + renderRoute + static export |
| `./plugin-sdk` | `src/plugin-sdk/` | Supported plugin-author seam: re-exports shared internals (errors/JSON/cleanup/HTTP/trusted-mutation/zod) |
| `./plugins` | `src/plugins/` | Plugin manifest/discovery/enablement/installer/activation |
| `./render-to-string` | `src/jsx/render-to-string.ts` | Preact render-to-string re-export |
| `./rich-text` | `src/rich-text/` | Persisted rich-text block document model + editor helpers |
| `./routing` | `src/routing/` | Lexical route discovery + middleware + signed URLs |
| `./security` | `src/security/` | Session/CSRF primitives shared by runtime/admin/auth |
| `./semver` | `src/semver/` | Browser-safe semver subset (plugin-manifest helpers) |
| `./seo` | `src/seo/` | Per-page metadata, head-tag rendering, JSON-LD, sitemap/robots generation |
| `./server-components` | `src/server-components/` | Server-only stateful components with backend actions (defineComponent authoring surface) |
| `./services` | `src/services/` | Domain services: `defineService` and the multi-method `Service` base |
| `./signals` | `src/signals/` | Service-layer signal-bus contract; impl + plugin in `@jsails/signals` |
| `./support` | `src/support/index.ts` | Browser-safe helper namespaces (`Str`/`Num`/`Time`/`Arr`/`Async`/`Encoding`/`Url`/`Cryptography`) |
| `./support/server` | `src/support/server-barrel.ts` | Server-only addendum (`Files`/`Media`/`Cookie`/server-`Cryptography`/`parseFrontmatter`/`serializeError`) |
| `./symbols` | `src/symbols/index.ts` | Server framework-symbols preload (installFrameworkSymbols side-effect install) |
| `./symbols/client` | `src/symbols/client.ts` | Browser framework-symbols preload (installBrowserSymbols, browser-safe catalog only) |
| `./testing` | `src/testing/` | Server-only in-process `createTestApp` |
| `./validation` | `src/validation/` | Composable Zod-backed validation rules + validateFields |
| `./zod` | `src/zod.ts` | Server-only Zod authoring surface (z) |

## Quick Reference

- **Language/runtime:** TypeScript, ESM only, Node `>=26.0.0`
- **Data:** TypeORM Active Record over MariaDB (default) / Postgres / MySQL / SQLite (via `sqljs`); declarative desired-state schema via `jsails db:push`/`db:diff`
- **HTTP/render:** Hono + Preact SSR; filesystem-routed pages/API; static export
- **Interactivity:** Turbo soft navigation + hydrated Preact islands + signed server components
- **Deploy:** Jamal (`dev`/`deploy` planning + Docker Compose/Kamal execution) + pure deploy generators
- **Build:** `npm run build` · **Typecheck:** `npm run typecheck` · **Lint/format:** `npm run lint` / `npm run format`
- **Verify:** full verification discipline: see `core/AGENTS.md` ("First commands" / "Verification discipline"). Run `npm run check`.
