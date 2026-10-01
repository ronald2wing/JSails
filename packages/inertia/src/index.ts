/**
 * Inertia v3 adapter (`@jsails/inertia`): the server half of the Inertia
 * protocol as pure functions over web-standard request facts.
 *
 * Prop descriptors (`always`, `optional`, `defer`, `merge`, `once`,
 * `scroll`), the resolution engine with partial-reload, deferred, once, merge,
 * and scroll semantics, the v3 page object, the error-bag rule, the strict
 * serializer, the full-page document with its `<script data-page>` block, the
 * asset version hash, and the outcome layer: `resolveInertia` and the
 * redirect helpers return plain-data outcomes (page, document, `409` control,
 * redirect, Precognition, the Origin check's `403`) that
 * `outcomeToResponse` maps to a `Response`, `adaptInertiaResponse` applies the redirect rules to foreign responses, the
 * sealed one-shot carrier moves flash, errors, `clearHistory`, and
 * `preserveFragment` across a redirect, and the SSR gateways render in
 * process or over HTTP. The barrel is the stable surface: the engine's
 * internal steps (prop planning, partial selection, the redirect decision,
 * carrier reads) are reached only through these entry points. Works with
 * the official Inertia v3 clients; the caller owns client-side component
 * resolution.
 */

export {
  always,
  defer,
  isInertiaProp,
  merge,
  once,
  optional,
  scroll,
  type DeferOptions,
  type InertiaProp,
  type InertiaPropContext,
  type MergeSpec,
  type OnceSpec,
  type PropKind,
  type PropResolver,
  type ScrollOptions,
  type ScrollPage,
} from './props.js';
export {
  readInertiaVisit,
  requestFacts,
  INERTIA_HEADERS,
  type InertiaPartialRequest,
  type InertiaRequestFacts,
  type InertiaVisit,
} from './visit.js';
export type { PropsTree, RescueReporter } from './resolve-props.js';
export { buildInertiaPage, type BuildPageInput } from './build-page.js';
export type {
  InertiaOnceMeta,
  InertiaPageObject,
  InertiaPropsMetadata,
  InertiaScrollMeta,
  JsonValue,
} from './page.js';
export {
  shapeErrorBags,
  DEFAULT_ERROR_BAG,
  type InertiaErrorBags,
  type InertiaErrors,
} from './error-bags.js';
export { serializePage, BIGINT_MARKER } from './serialize-page.js';
export {
  buildDocument,
  escapeScriptJson,
  pageDataBlock,
  DEFAULT_ROOT_ID,
  type DocumentAssets,
  type DocumentInput,
} from './document.js';
export { inertiaVersion } from './version.js';
export {
  InertiaError,
  INERTIA_ERROR_MESSAGES,
  type InertiaErrorCode,
  type InertiaErrorOptions,
} from './inertia-error.js';
export {
  defineInertia,
  type InertiaConfig,
  type InertiaMode,
  type InertiaOptions,
  type InertiaReporter,
  type InertiaReportPhase,
  type InertiaShare,
} from './inertia-config.js';
export { resolveInertia, versionGuard, type InertiaRenderSpec } from './resolve-inertia.js';
export {
  inertiaBack,
  inertiaLocation,
  inertiaRedirect,
  validationFailure,
  type InertiaBackOptions,
  type InertiaRedirectOptions,
} from './redirect.js';
export {
  outcomeToResponse,
  type InertiaControlOutcome,
  type InertiaDocumentOutcome,
  type InertiaForbiddenOutcome,
  type InertiaOutcome,
  type InertiaPageOutcome,
  type InertiaPrecognitionOutcome,
  type InertiaRedirectOutcome,
} from './outcome.js';
export { CONTROL_HEADERS } from './control.js';
export { adaptInertiaResponse } from './adapt.js';
export { originGuard, type OriginGuardOptions } from './origin-guard.js';
export { INERTIA_VARY, type InertiaHeaderList } from './response-headers.js';
export {
  CARRIER_AAD,
  CARRIER_COOKIE,
  CARRIER_MAX_BYTES,
  type CarrierContents,
  type InertiaCarrierOptions,
  type InertiaFlash,
  type ResolvedCarrier,
} from './carrier.js';
export {
  sealerFromEncrypter,
  webCryptoSealer,
  type AadEncrypter,
  type InertiaSealer,
} from './sealer.js';
export {
  toInertiaErrors,
  validationIssuesOf,
  FORM_ERROR_KEY,
  type ToInertiaErrorsOptions,
} from './validation-errors.js';
export {
  isPrecognitive,
  precognition,
  precognitionValidateOnly,
  PRECOGNITION_HEADERS,
} from './precognition.js';
export {
  httpSsr,
  inProcessSsr,
  type HttpSsrOptions,
  type InertiaSsr,
  type InertiaSsrApp,
  type InertiaSsrOptions,
  type InertiaSsrPage,
  type InertiaSsrResult,
  type ResolvedSsr,
} from './ssr.js';
