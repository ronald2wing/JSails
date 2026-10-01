/**
 * The access chain's own denial codes, `access.*`.
 *
 * Apart from the chain (`access-chain.ts`) so `jsails/security` can export
 * the registry without loading the chain and its failure rendering.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const ACCESS_ERRORS = {
  cross_site: {
    kind: 'forbidden',
    audience: 'client',
    message: 'Cross-origin request rejected.',
  },
  fault: {
    kind: 'unavailable',
    audience: 'client',
    message: 'Access could not be decided; try again later.',
  },
} as const;

/**
 * The access chain's own denial codes, `access.*`: an unsafe request to a
 * cookie-accepting surface from another origin (403), and an access check
 * that failed instead of deciding (503).
 *
 * @public
 */
export const AccessErrors: ErrorRegistry<'access', typeof ACCESS_ERRORS> = defineErrors(
  'access',
  ACCESS_ERRORS,
);
