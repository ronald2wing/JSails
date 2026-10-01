/**
 * Validation rules (`jsails/validation`).
 *
 * Composable, value-free Zod-backed validation rules and a bulk validation
 * helper. Messages never echo input values. `z` is not re-exported here: the
 * browser-safe validation barrel stays rule-only, and server code gets `z` from
 * `jsails/zod` (autoloaded).
 */

export {
  confirmed,
  email,
  inList,
  max,
  maxLength,
  min,
  minLength,
  regex,
  required,
  url,
  validateFields,
  when,
  type FieldError,
  type ValidationRule,
} from './rules.js';
