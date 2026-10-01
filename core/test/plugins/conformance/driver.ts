/**
 * The marketplace conformance driver: the small surface every implementation
 * of plugin activation is driven through, so one scenario suite states the
 * trust and lifecycle claims of owner decision 1 for whichever implementation
 * is plugged in.
 *
 * The six verbs are the ones the claims need: `boot` a node in a mode, write
 * the activation table as a database-only attacker (`sqlWrite`), act through
 * the admin surface (`adminAction`), place bytes in the deployment's bundle
 * store (`putBundle`), add `nodes`, and read the `status` an attacker or an
 * operator can see. Two non-verbs complete it: `forgeRow`, which describes
 * the row an attacker who knows the schema (and optionally the seal key)
 * would write, and `close`, which releases the deployment's resources.
 *
 * Mode is code: a boot names its mode, and nothing a driver exposes besides
 * `boot` takes one. Implementations: `legacy-driver.ts` (today's
 * `core/src/plugins` installer, state store and activation) and, from MKT-07,
 * the `@jsails/marketplace` driver.
 */

import type { BuiltBundle, CatalogFixture } from './bundles.js';

/** The two activation modes of owner decision 1; `locked` is the default. */
export type ActivationMode = 'locked' | 'managed';

/** A bundle the deployment's store holds, as later actions and rows name it. */
export interface BundleRef {
  readonly id: string;
  readonly version: string;
  /** SHA-256 of the archive bytes, lowercase hex. */
  readonly digest: string;
}

/** The code-reviewed configuration a node boots with. Everything is optional. */
export interface BootConfig {
  /** Trusted fixture publishers (`bundles.ts`). Defaults to `['acme']`. */
  readonly publishers?: readonly string[];
  /** Site permission ceiling. Absent means no ceiling beyond the publisher's. */
  readonly ceiling?: readonly string[];
  /** Revoked fixture key ids. */
  readonly revoked?: readonly string[];
  /** Plugin ids whose failure to verify or load must fail the boot. */
  readonly required?: readonly string[];
  /** Entries of the committed lock file (`jsails.plugins.lock`). */
  readonly lock?: readonly BundleRef[];
  /** Plugin ids the app's own code declares (`plugins.use`). */
  readonly code?: readonly string[];
  /** Boot with an activation store whose every method throws. */
  readonly throwingStore?: boolean;
  /** Boot with the safe-mode kernel input set. */
  readonly safeMode?: boolean;
  /** The deployment shape; `static` is the export. Defaults to `full`. */
  readonly shape?: 'full' | 'static';
  /** Environment variables set for the duration of the boot. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What one boot of one node did. */
export interface BootReport {
  /** Whether the application started. */
  readonly booted: boolean;
  /** The boot error's value-free message, when it did not start. */
  readonly failure?: string;
  /** `id@version` (or `id@code`) of every plugin whose setup completed. */
  readonly loaded: readonly string[];
  /**
   * `id@version[#variant]` of every bundle module evaluated during this boot.
   * A boot is a fresh process: a module evaluated by an earlier boot is
   * evaluated again, from the bytes stored now, never reused from a cache.
   */
  readonly imported: readonly string[];
  /** Value-free issue codes the boot reported (skips and warnings). */
  readonly issues: readonly string[];
  /** How many times the boot called the activation store. */
  readonly storeCalls: number;
  /** What each loaded plugin read from `ctx.settings.current()`. */
  readonly settings: Readonly<Record<string, unknown>>;
}

/** A node of the deployment: its own process and its own local filesystem. */
export interface MarketplaceNode {
  boot(mode: ActivationMode, config?: BootConfig): Promise<BootReport>;
}

/** Who performs an admin action. */
export interface Actor {
  readonly id: string;
  /** Policy actions granted (`plugins.install`, `plugins.settings`, ...). */
  readonly grants: readonly string[];
  /** Minutes since the actor last authenticated. */
  readonly authenticatedMinutesAgo: number;
}

/** Everything the admin surface can be asked to do. */
export type AdminAction =
  | { readonly kind: 'install'; readonly bundle: BundleRef }
  | { readonly kind: 'enable'; readonly id: string }
  | { readonly kind: 'disable'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'rollback'; readonly id: string; readonly version: string }
  | {
      readonly kind: 'settings';
      readonly id: string;
      readonly values: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'refreshCatalog'; readonly catalog: CatalogFixture }
  | { readonly kind: 'setMode'; readonly mode: ActivationMode };

/**
 * The code a locked deployment refuses every code-changing admin action with
 * (install, enable, disable, rollback, remove, catalog refresh, mode change).
 * A distinct code, so a refusal for an unknown plugin or a failed verification
 * cannot stand in for the locked-mode guarantee.
 */
export const LOCKED_MODE_CODE = 'locked_mode';

/** The result of an admin action: done, or refused with a value-free code. */
export type AdminOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

/** What an observer of the deployment sees. */
export interface DeploymentStatus {
  /** The activation table's rows, raw, as a database-only attacker reads them. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** The plugin set the running primary node serves right now. */
  readonly running: readonly string[];
}

/** The row an attacker writes, and the table it goes to. */
export interface ForgedRow {
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

/** The logical content of a forged activation row. */
export interface ForgedActivation {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
}

/** One deployment: a database, a bundle store, a primary node, and more nodes. */
export interface MarketplaceDriver extends MarketplaceNode {
  /** Write one row through SQL, bypassing every framework API. */
  sqlWrite(table: string, row: Readonly<Record<string, unknown>>): Promise<void>;
  /** Perform an admin action on the primary node as `actor`. */
  adminAction(actor: Actor, action: AdminAction): Promise<AdminOutcome>;
  /**
   * Place a bundle's bytes in the deployment's bundle store. With `replacing`,
   * overwrite the bytes stored for that bundle instead (an attacker with
   * write access to the store).
   */
  putBundle(bundle: BuiltBundle, options?: { readonly replacing?: BundleRef }): Promise<BundleRef>;
  /** Add `count` nodes sharing the database and bundle store, each with empty local storage. */
  nodes(count: number): Promise<readonly MarketplaceNode[]>;
  /** The deployment as an observer sees it. */
  status(): Promise<DeploymentStatus>;
  /** The activation row an attacker who knows the schema would write. */
  forgeRow(activation: ForgedActivation, options?: { readonly withSealKey?: boolean }): ForgedRow;
  /** Release every resource the deployment holds. */
  close(): Promise<void>;
}

/** Builds a fresh, empty deployment. */
export type MarketplaceDriverFactory = () => Promise<MarketplaceDriver>;
