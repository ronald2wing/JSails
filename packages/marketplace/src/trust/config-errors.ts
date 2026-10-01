/**
 * Marketplace configuration errors, `marketplace_config.*`: a publisher, a
 * catalog source or a trust set declared wrongly in code, or a value that
 * cannot be put in canonical form. These are a developer's mistakes, raised
 * while the config loads, so they throw.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const CONFIG_ERRORS = {
  invalid_publisher: {
    kind: 'internal',
    message: 'the publisher declaration has an invalid {field}',
    context: { field: ['shape', 'id', 'ids', 'keys', 'key_id', 'public_key', 'use', 'ceiling'] },
    suggestion:
      "A publisher has a lowercase id, 'ids' of exact plugin ids or '<prefix>-*' patterns, keys with unique ids, distinct base64 Ed25519 public keys and a non-empty 'use' of root, release or catalog, and a ceiling of registered permissions",
  },
  invalid_catalog_source: {
    kind: 'internal',
    message: 'the catalog source has an invalid {field}',
    context: { field: ['shape', 'publisher', 'url'] },
    suggestion: 'A catalog source names a publisher id and a credential-free https URL',
  },
  invalid_trust: {
    kind: 'internal',
    message: 'the trust declaration has an invalid {field}',
    context: { field: ['shape', 'publishers', 'ceiling', 'revoked', 'catalogs', 'delegations'] },
    suggestion:
      'Pass publishers made with publisher(), a site ceiling of registered permissions, revocations as { keys: [{ publisher, keyId }], releases: [digest] }, and catalogs and delegations returned by the verifiers',
  },
  invalid_catalog_options: {
    kind: 'internal',
    message: 'the catalog verification options have an invalid {field}',
    context: { field: ['shape', 'accepted', 'now'] },
    suggestion:
      "Pass 'accepted' as the sequence and keyId of the newest catalog verifyCatalog returned, and 'now' as a valid Date",
  },
  duplicate_publisher: {
    kind: 'internal',
    message: 'two trusted publishers share one id',
    suggestion: 'Declare each publisher once',
  },
  not_canonical: {
    kind: 'internal',
    message: 'the value has no canonical JSON form: {problem}',
    context: { problem: ['number', 'string', 'undefined', 'type', 'depth'] },
    suggestion:
      'Canonical JSON holds null, booleans, safe integers, well-formed strings, arrays and plain objects, nested at most 32 deep',
  },
} as const;

/**
 * The marketplace configuration codes, `marketplace_config.*`.
 *
 * @public
 */
export const MarketplaceConfigErrors: ErrorRegistry<'marketplace_config', typeof CONFIG_ERRORS> =
  defineErrors('marketplace_config', CONFIG_ERRORS);
