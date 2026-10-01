// The workspace build order, shared by the build and test orchestrators.
//
// The order is explicit and load-bearing: a plugin's `tsc` resolves `jsails/*`
// through the built `core/dist`, so core must emit first, and the plugin order
// below is the dependency order the root scripts already encoded. npm's
// `--workspaces` flag cannot be used instead because it runs alphabetically,
// which puts `@jsails/admin` before `@jsails/cache`.
//
// Kept as directory names rather than package names so a missing directory
// fails loudly in the caller instead of silently building nothing.
export const WORKSPACES = [
  'core',
  'plugins/cache',
  'plugins/signals',
  'plugins/diagnostics',
  'plugins/filesystem',
  'plugins/theme',
  'plugins/sessions',
  'plugins/plugin-tools',
  'plugins/inertia',
  'plugins/ai',
  'plugins/logging',
  'plugins/content',
  'plugins/editor',
  'plugins/mail',
  'plugins/auth',
  'plugins/notifications',
  'plugins/admin',
  'plugins/media',
  'plugins/blog',
  'plugins/live',
  'plugins/flags',
  'plugins/admin-plugin-manager',
  'plugins/tenancy',
];
