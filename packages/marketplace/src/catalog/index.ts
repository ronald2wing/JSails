/**
 * Publisher catalogs: `catalog()` source declarations, the signed catalog
 * document (plugins and releases, delegations, revocations, a sequence and an
 * expiry), and `verifyCatalog` with rollback protection and stale marking.
 */

export { catalog, type CatalogSource } from './catalog-source.js';
export type { Catalog, CatalogPlugin, CatalogRelease, SignedCatalog } from './catalog-document.js';
export {
  verifyCatalog,
  type AcceptedCatalog,
  type CatalogRollback,
  type CatalogVerdict,
  type VerifiedCatalog,
  type VerifyCatalogOptions,
} from './verify-catalog.js';
