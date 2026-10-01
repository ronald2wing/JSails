/**
 * Plugin permissions — the closed registry every manifest's `permissions`
 * are checked against, with a plain-language title, description, and risk for
 * each one (`registry.ts`).
 */

export {
  PERMISSIONS,
  getPermission,
  parsePermission,
  describePermission,
  type PermissionDefinition,
  type PermissionRisk,
  type PermissionScopeKind,
  type ParsedPermission,
  type PermissionIssueCode,
  type PermissionParseResult,
  type PermissionDescription,
} from './registry.js';
