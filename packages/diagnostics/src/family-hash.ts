/**
 * The one family-hash derivation shared by the recorder and the exception
 * watcher, so an entry's `familyHash` and the watcher's `counts()` keys agree.
 */

import { hashSync } from 'jsails/support/server';

/** A truncated SHA-1 of the entry type and family discriminator (12 hex chars). */
export function deriveFamilyHash(type: string, family: string): string {
  return hashSync('SHA-1', type + family).slice(0, 12);
}
