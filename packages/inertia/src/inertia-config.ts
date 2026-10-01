/**
 * Application-level Inertia configuration, validated once.
 *
 * {@link defineInertia} checks every option when the app is configured and
 * returns a frozen {@link InertiaConfig}, so a bad root id, version, asset
 * list, carrier, or SSR gateway fails at startup with a value-free
 * `invalid_options`, never in the middle of a request. What only a function
 * can produce (a per-request version or asset list) is checked each time it
 * is produced, with the same code.
 *
 * A version travels in the `X-Inertia-Version` header both ways, so it must
 * be a header-safe token: visible ASCII, inner spaces allowed. A leading or
 * trailing space would be stripped from the header the client echoes, and
 * every visit would then fail the version check and reload.
 *
 * `report` receives failures the engine absorbs instead of throwing: a
 * rescued deferred prop (`rescued_prop`, with its path), an SSR render that
 * fell back to client-side rendering (`ssr`), and flash dropped by the carrier
 * size policy (`carrier`). It defaults to `console.error`.
 */

import { resolveCarrierOptions } from './carrier.js';
import type { InertiaCarrierOptions, ResolvedCarrier } from './carrier.js';
import { assertAssets, assertRootId, DEFAULT_ROOT_ID } from './document.js';
import type { DocumentAssets } from './document.js';
import { InertiaError } from './inertia-error.js';
import { isPlainObject } from './plain-data.js';
import type { InertiaPropContext } from './props.js';
import type { PropsTree } from './resolve-props.js';
import { resolveSsrOptions } from './ssr.js';
import type { InertiaSsrOptions, ResolvedSsr } from './ssr.js';
import { sameOriginPath } from './control.js';
import type { InertiaRequestFacts } from './visit.js';

/**
 * The mode the app runs in, which sets three defaults: the carrier's
 * `oversize` policy (`drop-flash` in production, else `throw`), SSR's
 * `onError` (`throw` under test, else `fallback`), and the insecure-context
 * warning for `encryptHistory` (outside production only).
 *
 * @public
 */
export type InertiaMode = 'development' | 'test' | 'production';

const MODES: ReadonlySet<unknown> = new Set(['development', 'test', 'production']);

/** Where an absorbed failure happened. */
export type InertiaReportPhase = 'ssr' | 'rescued_prop' | 'carrier';

/** Receives absorbed failures; `path` is the prop path for `rescued_prop`. */
export type InertiaReporter = (error: unknown, phase: InertiaReportPhase, path?: string) => void;

/** Props shared by every page, computed per request. */
export type InertiaShare = (context: InertiaPropContext) => PropsTree | Promise<PropsTree>;

/** Options for {@link defineInertia}. */
export interface InertiaOptions {
  /** The asset version, a function returning it per request, or `null` for none (`''`). */
  readonly version: string | (() => string) | null;
  /**
   * The app's mode (see {@link InertiaMode}); pass the one the app was
   * started in. Defaults to `production`, the mode whose defaults degrade
   * rather than fail.
   */
  readonly mode?: InertiaMode;
  /** The root element id the client mounts on. Defaults to `app`. */
  readonly rootId?: string;
  /** The document language, a BCP 47 tag. */
  readonly lang?: string;
  /** Client asset URLs for the document, fixed or per request. */
  readonly assets?: DocumentAssets | ((facts: InertiaRequestFacts) => DocumentAssets);
  /** The CSP nonce for the document's asset tags. */
  readonly nonce?: (facts: InertiaRequestFacts) => string | undefined;
  /** Shared props; page props of the same top-level key win. */
  readonly share?: InertiaShare;
  /** Encrypt history entries for every page unless a render says otherwise. */
  readonly encryptHistory?: boolean;
  readonly errors?: {
    /** Send every message per field as an array. */
    readonly allMessages?: boolean;
    /** Where `back` goes without a same-origin `Referer`. Defaults to `/`. */
    readonly backFallback?: string;
  };
  /** The sealed flash and errors carrier; required to carry anything across a redirect. */
  readonly carrier?: InertiaCarrierOptions;
  readonly ssr?: InertiaSsrOptions;
  readonly report?: InertiaReporter;
  /** The clock, in epoch milliseconds. */
  readonly now?: () => number;
}

/** A validated Inertia configuration. */
export interface InertiaConfig {
  readonly mode: InertiaMode;
  readonly version: () => string;
  readonly rootId: string;
  readonly lang: string | null;
  readonly assets: (facts: InertiaRequestFacts) => DocumentAssets;
  readonly nonce: (facts: InertiaRequestFacts) => string | undefined;
  readonly share: InertiaShare | null;
  readonly encryptHistory: boolean;
  readonly allMessages: boolean;
  readonly backFallback: string;
  readonly carrier: ResolvedCarrier | null;
  readonly ssr: ResolvedSsr | null;
  readonly report: InertiaReporter;
  readonly now: () => number;
}

const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** Validate Inertia options and freeze them into a config. */
export function defineInertia(options: InertiaOptions): InertiaConfig {
  if (!isPlainObject(options)) throw new InertiaError('invalid_options');
  const mode = options.mode ?? 'production';
  if (!MODES.has(mode)) throw new InertiaError('invalid_options');
  const rootId = options.rootId ?? DEFAULT_ROOT_ID;
  assertRootId(rootId);
  if (
    options.lang !== undefined &&
    (typeof options.lang !== 'string' || !LANG.test(options.lang))
  ) {
    throw new InertiaError('invalid_options');
  }
  const errors = options.errors ?? {};
  if (!isPlainObject(errors)) throw new InertiaError('invalid_options');
  const backFallback = sameOriginPath(errors.backFallback ?? '/');
  assertOptional(errors.allMessages, 'boolean');
  assertOptional(options.encryptHistory, 'boolean');
  assertOptional(options.nonce, 'function');
  assertOptional(options.share, 'function');
  assertOptional(options.report, 'function');
  assertOptional(options.now, 'function');
  return Object.freeze({
    mode,
    version: versionSource(options.version),
    rootId,
    lang: options.lang ?? null,
    assets: assetSource(options.assets),
    nonce: options.nonce ?? noNonce,
    share: options.share ?? null,
    encryptHistory: options.encryptHistory ?? false,
    allMessages: errors.allMessages ?? false,
    backFallback,
    carrier: options.carrier === undefined ? null : resolveCarrierOptions(options.carrier, mode),
    ssr: options.ssr === undefined ? null : resolveSsrOptions(options.ssr, mode),
    report: options.report ?? reportToConsole,
    now: options.now ?? Date.now,
  });
}

/** The current asset version, checked on every call. */
export function currentVersion(config: InertiaConfig): string {
  const version: unknown = config.version();
  assertVersion(version);
  return version;
}

const VERSION = /^(?:[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)?$/u;

function assertVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new InertiaError('invalid_options');
  }
}

function versionSource(version: InertiaOptions['version']): () => string {
  if (version === null) return () => '';
  if (typeof version === 'function') return version;
  assertVersion(version);
  return () => version;
}

function assetSource(
  assets: InertiaOptions['assets'],
): (facts: InertiaRequestFacts) => DocumentAssets {
  if (assets === undefined) return () => ({});
  if (typeof assets === 'function') return assets;
  assertAssets(assets);
  // Copied and frozen, lists included, so what was validated is what is used.
  const fixed: DocumentAssets = Object.freeze({
    ...(assets.scripts === undefined ? {} : { scripts: Object.freeze([...assets.scripts]) }),
    ...(assets.styles === undefined ? {} : { styles: Object.freeze([...assets.styles]) }),
    ...(assets.preloads === undefined ? {} : { preloads: Object.freeze([...assets.preloads]) }),
  });
  return () => fixed;
}

function assertOptional(value: unknown, type: 'boolean' | 'function'): void {
  if (value !== undefined && typeof value !== type) throw new InertiaError('invalid_options');
}

function noNonce(): undefined {
  return undefined;
}

function reportToConsole(error: unknown, phase: InertiaReportPhase, path?: string): void {
  console.error(`[jsails/inertia] ${phase}${path === undefined ? '' : ` "${path}"`} failed`, error);
}
