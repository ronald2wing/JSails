/**
 * Extension foundation entry point.
 *
 * Named re-exports only. `extension.js` references Hono through `import type`,
 * so importing this module never pulls in an ORM or HTTP runtime.
 *
 * Error convention: each module declares its failures in an error registry
 * (`ServiceErrors`, `ContractErrors`, `ExtensionErrors`, `InterceptorErrors`,
 * `DeclarativePluginErrors`, `LazyResourceErrors` on `jsails/plugin-sdk`);
 * recognize one with `ServiceErrors.is(error, 'not_found')`. Their messages are
 * rendered from validated context only, so a caller may surface them verbatim.
 */

// Service tokens and the registry; plugins on the `definePlugin` contract
// import the token API from `jsails/kernel`.
export {
  createServiceRegistry,
  createServiceToken,
  ServiceErrors,
  type ProvideOptions,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceRegistryController,
  type ServiceToken,
  type ServiceTokenFamily,
  type ServiceTokenOptions,
} from './services.js';

export {
  ContractErrors,
  createContractToken,
  isContractToken,
  type ContractToken,
  type ContractTokenProvider,
} from './contracts.js';

export {
  ExtensionErrors,
  runExtensions,
  type ExtensionCleanup,
  type ExtensionContext,
  type ExtensionReadinessProbe,
  type ExtensionRuntime,
  type JsailsExtension,
  type RunExtensionsOptions,
  type ServeAttachment,
  type ServeContext,
  type ServeHook,
  type ServeHookRegistration,
} from './extension.js';

// The request-scope and guard contracts an extension registers through
// `configureRequestScope` and `configureGuard`, as types only, so this entry
// loads none of the server; the `request_scope.*` codes are on the root.
export type {
  CachePartition,
  RequestScopeSpec,
  ScopeBinding,
  ScopeCacheClass,
  ScopeRequest,
} from '../server/request-scope.js';
export type { Guard, GuardInfo } from '../server/request-frame.js';

// Type-only author contract: `routes` is an `HttpRoutes`, whose routes take a
// `RouteMiddleware` (`(context, next) => Response`) list, so a plugin author
// types them through this ORM/HTTP/queue-free entry instead of the
// `node:*`-heavy `jsails/routing`.
export type { RouteMiddleware } from '../routing/middleware.js';
export type {
  FetchHandler,
  HttpRoutes,
  MountOptions,
  RouteMethod,
  RouteSpec,
} from '../server/http-routes.js';
export type { ResponseTransform } from '../server/route-boundary.js';
export type { RouteKind, RouteOrigin, TransformableKind } from '../server/route-meta.js';
export type { CredentialKind } from '../security/credentials.js';

export {
  definePlugin,
  type JsailsPlugin,
  type PluginContext,
  type PluginDescription,
  type PluginSchema,
} from './plugin-contract.js';

export {
  DeclarativePluginErrors,
  defineDeclarativePlugin,
  type DeclarativePluginSpec,
} from './declarative-plugin.js';

export {
  createInterceptorRegistry,
  defineEvent,
  defineOperation,
  InterceptorErrors,
  lookupEvent,
  lookupOperation,
  resolveEvent,
  resolveOperation,
  type AfterInterceptor,
  type BeforeInterceptor,
  type EventToken,
  type InterceptOptions,
  type InterceptorContext,
  type InterceptorPhase,
  type InterceptorRegistry,
  type ObserveOptions,
  type Observer,
  type OperationToken,
} from './interceptors.js';

export {
  validateExtensionEntries,
  type ExtensionEntryError,
  type ExtensionEntryErrorCode,
} from './validation.js';

// Type-only author interfaces for out-of-tree plugin packages. Every export
// below is erased at compile time, so this entry still imports only the
// extension-foundation modules above (services, extension, plugin, interceptors,
// validation — all type-only or identity helpers) and stays free of
// ORM/HTTP/queue/Socket.IO runtime libraries. The interfaces leak no native
// `Queue` or Socket.IO types: a plugin implements a job runtime adapter,
// or broadcast adapter against the neutral
// contracts alone. Runtime construction (JobsRuntimeImpl,
// BullMQAdapter, ...) lives in the root entry, never here.

export type {
  JobAdapterContext,
  JobDispatchOptions,
  JobsRuntimeAdapter,
  ProcessJob,
  RuntimeJob,
  RuntimeProducer,
  RuntimeWorker,
} from '../jobs/runtime.js';

export type { BroadcastAdapter, BroadcastHandle } from '../broadcast/contracts.js';

export { createCleanup } from './cleanup.js';
