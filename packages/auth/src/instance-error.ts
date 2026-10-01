/**
 * The value-free error raised while building or releasing a Better Auth
 * instance, shared by the instance wiring and the database selection so
 * neither has to import the other for it.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** Why building or releasing a Better Auth instance failed. */
export type AuthInstanceErrorCode =
  | 'missing_env'
  | 'invalid_env'
  | 'invalid_database'
  | 'missing_driver'
  | 'unsupported_database'
  | 'unsafe_instance'
  | 'missing_magic_link_sender'
  | 'dispose_failed';

/**
 * Raised while building or releasing a Better Auth instance. Value-free: the
 * message names at most an environment variable, a configuration field, or a
 * package, never a value, the DSN, or a credential, and there is no `cause`
 * chain that could carry one.
 */
export class AuthInstanceError extends JsailsError {
  constructor(
    readonly code: AuthInstanceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
