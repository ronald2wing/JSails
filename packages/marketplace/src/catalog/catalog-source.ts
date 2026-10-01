/**
 * `catalog()`: where a site fetches a trusted publisher's signed catalog, as
 * config data. The URL is credential-free https: a catalog is public, and a
 * URL that embeds a secret would end up in logs and the admin UI.
 */

import {
  hasExactKeys,
  isHttpsUrl,
  isRecord,
  matches,
  PUBLISHER_ID_PATTERN,
} from '../trust/field-checks.js';
import { MarketplaceConfigErrors } from '../trust/config-errors.js';

/**
 * A catalog source declaration.
 *
 * @public
 */
export interface CatalogSource {
  /** The id of the publisher whose catalog this is; it must also be a trusted publisher. */
  readonly publisher: string;
  /** A credential-free https URL serving the signed catalog. */
  readonly url: string;
}

/**
 * Declare a catalog source. Throws `marketplace_config.invalid_catalog_source`
 * naming the field that is wrong.
 *
 * @public
 */
export function catalog(input: CatalogSource): CatalogSource {
  if (!isRecord(input) || !hasExactKeys(input, ['publisher', 'url'])) {
    throw new MarketplaceConfigErrors.Error('invalid_catalog_source', { field: 'shape' });
  }
  if (!matches(input.publisher, PUBLISHER_ID_PATTERN)) {
    throw new MarketplaceConfigErrors.Error('invalid_catalog_source', { field: 'publisher' });
  }
  if (!isHttpsUrl(input.url)) {
    throw new MarketplaceConfigErrors.Error('invalid_catalog_source', { field: 'url' });
  }
  return Object.freeze({ publisher: input.publisher, url: input.url });
}
