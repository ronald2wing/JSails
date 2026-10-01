/**
 * The plugin contract's error codes.
 *
 * `plugin.*` is a definition `definePlugin` refuses or a contract the runner
 * enforces around `setup`; `config.*` is a plugin's options or environment
 * that do not satisfy its schemas. Every message names the plugin, a token, a
 * variable or a unit by identifier; option and variable values never appear,
 * and the issues a payload carries hold a path and a code only.
 */

import type { ErrorIssue } from '../../errors/kernel.js';
import { defineErrors, type ErrorRegistry, type Payload } from '../../errors/registry.js';

const PLUGIN_ERRORS = {
  invalid_name: {
    kind: 'internal',
    message: 'a plugin name must be an identifier',
  },
  invalid_definition: {
    kind: 'internal',
    message: 'the definition of plugin {plugin} is rejected: {problem}',
    context: {
      plugin: 'identifier',
      problem: [
        'unknown_field',
        'invalid_options_schema',
        'invalid_key',
        'invalid_env',
        'invalid_env_name',
        'invalid_env_variable',
        'invalid_token_list',
        'invalid_substrate',
        'invalid_setup',
        'invalid_contribution',
      ],
    },
    suggestion:
      'a definition has a name, a setup function or lazy() module, and optional options, a key function, env, requires, optional, provides, substrate, and lazy() schema, jobs, schedules and release modules',
  },
  invalid_instance_key: {
    kind: 'internal',
    message: 'plugin {plugin} computed an instance key that is not an identifier',
    context: { plugin: 'identifier' },
    suggestion:
      'return an identifier such as media from key, or undefined for the unkeyed instance; the instance name <plugin>:<key> stays within 128 characters',
  },
  invalid_token: {
    kind: 'internal',
    message: 'plugin {plugin} declares a {list} entry that is not a service token',
    context: { plugin: 'identifier', list: ['requires', 'optional', 'provides', 'substrate'] },
  },
  conflicting_token: {
    kind: 'internal',
    message: 'plugin {plugin} declares service {token} both as provided and as a dependency',
    context: { plugin: 'identifier', token: 'identifier' },
  },
  undeclared_service: {
    kind: 'internal',
    message: 'plugin {plugin} cannot {access} service {token}: its definition does not declare it',
    context: { plugin: 'identifier', token: 'identifier', access: ['read', 'provide'] },
    suggestion: 'list the token in requires, optional or provides',
  },
  missing_service: {
    kind: 'internal',
    message: 'plugin {plugin} requires service {token}, which no plugin before it provided',
    context: { plugin: 'identifier', token: 'identifier' },
    suggestion: 'add the plugin that provides the service, or make the dependency optional',
  },
  missing_provision: {
    kind: 'internal',
    message: 'plugin {plugin} declares that it provides service {token}, but its setup did not',
    context: { plugin: 'identifier', token: 'identifier' },
  },
  invalid_setup_module: {
    kind: 'internal',
    message: 'the setup module of plugin {plugin} does not default-export a setup function',
    context: { plugin: 'identifier' },
  },
  invalid_contribution: {
    kind: 'internal',
    message: 'the {slot} contribution of plugin {plugin} does not have the shape of that slot',
    context: { plugin: 'identifier', slot: ['schema', 'jobs', 'schedules', 'release'] },
    suggestion:
      'default-export an array of objects, or for schema an object of models (classes), tables and dataMigrations arrays',
  },
  unsupported_contribution: {
    kind: 'internal',
    message:
      'plugin {plugin} contributes schema {part}, which the schema commands cannot apply yet',
    context: { plugin: 'identifier', part: ['tables', 'dataMigrations'] },
    suggestion:
      'declare the tables the plugin owns as models; table specs and data migrations arrive with the phased schema planner',
  },
  invalid_module_ref: {
    kind: 'internal',
    message: 'a module reference must be a path relative to the application root',
    suggestion: "name the module by its path without an extension, as in 'app/policies/post'",
  },
  invalid_substrate: {
    kind: 'internal',
    message: 'plugin {plugin} declares a substrate resource without a token, create and close',
    context: { plugin: 'identifier' },
  },
  invalid_lifecycle_unit: {
    kind: 'internal',
    message: 'plugin {plugin} registers a lifecycle unit that is rejected: {problem}',
    context: {
      plugin: 'identifier',
      problem: [
        'invalid_roles',
        'invalid_unit',
        'invalid_name',
        'invalid_after',
        'invalid_transport',
        'duplicate_name',
        'after_setup',
      ],
    },
    suggestion:
      'pass known roles, a named unit with start, drain and abort (and ready as a function, if any), unit names in after, and a transport as { name, reach: process | shared }',
  },
  routes_closed: {
    kind: 'internal',
    message:
      'plugin {plugin} registers an HTTP route, mount, guard or transform after its setup returned',
    context: { plugin: 'identifier' },
    suggestion: 'register every route during setup; the registrar closes when setup returns',
  },
  lifecycle_unavailable: {
    kind: 'internal',
    message:
      'plugin {plugin} registers lifecycle unit {unit} for a role this host runs, but this host starts no lifecycle units',
    context: { plugin: 'identifier', unit: 'identifier' },
    suggestion: 'run the plugin on the kernel start stage, which starts lifecycle units',
  },
} as const;

/**
 * `plugin.*`: a plugin definition `definePlugin` refuses, a token list that is
 * not made of service tokens, a malformed module reference or contribution,
 * and a contract the runner enforces around `setup` (an undeclared service, a
 * declared service never provided, a lazy setup module without a default
 * export, a substrate or lifecycle declaration of the wrong shape).
 *
 * @public
 */
export const PluginErrors: ErrorRegistry<'plugin', typeof PLUGIN_ERRORS> = defineErrors(
  'plugin',
  PLUGIN_ERRORS,
);

const CONFIG_ERRORS = {
  invalid_options: {
    kind: 'invalid',
    message: 'the options of plugin {plugin} are invalid ({problem}); {count} problems in all',
    context: { plugin: 'identifier', problem: 'identifier', count: 'count' },
    payload: {} as Payload<{ readonly issues: readonly ErrorIssue[] }>,
    suggestion: "compare the options with the plugin's documented options",
  },
  invalid_env: {
    kind: 'invalid',
    message:
      'the environment of plugin {plugin} is invalid ({problem} at {variable}); {count} problems in all',
    context: {
      plugin: 'identifier',
      problem: 'identifier',
      variable: 'identifier',
      count: 'count',
    },
    payload: {} as Payload<{ readonly issues: readonly ErrorIssue[] }>,
    suggestion: 'set the variable in the real environment, the secrets file or the credentials',
  },
  invalid_app_env: {
    kind: 'invalid',
    message:
      'the environment of the app config is invalid ({problem} at {variable}); {count} problems in all',
    context: { problem: 'identifier', variable: 'identifier', count: 'count' },
    payload: {} as Payload<{ readonly issues: readonly ErrorIssue[] }>,
    suggestion: 'set the variable in the real environment, the secrets file or the credentials',
  },
  misconfigured: {
    kind: 'internal',
    message: 'the plugin graph is misconfigured: {problem} at plugin {plugin}',
    context: {
      plugin: 'identifier',
      problem: ['dependency_cycle', 'unsatisfied_service', 'duplicate_name', 'duplicate_provider'],
    },
    suggestion:
      'give every required service exactly one provider in plugins.use, and break any requires cycle',
  },
  removed_option: {
    kind: 'invalid',
    message: 'the app config option {option} was removed; use {replacement}',
    context: {
      option: [
        'plugins.managed',
        'plugins.force',
        'plugins.use descriptor',
        'commands',
        'authorize',
        'middleware',
        'globalMiddleware',
        'plugins.enabled',
        'plugins.downloads',
        'plugins.stateSource',
        'plugins.pluginsDir',
        'plugins.allowLoadFailures',
      ],
      replacement: [
        'plugins.activation',
        'the requires and provides of definePlugin instances',
        'a definePlugin instance in plugins.use',
        'a defineCommand module under commands/',
        'the access each API module states',
        'the middleware functions themselves in a route module middleware export',
        'http.guards and routes.transform',
        'the marketplace plugin source',
      ],
    },
  },
  invalid_app_definition: {
    kind: 'internal',
    message: 'the app config {path} does not default-export defineApp(...)',
    context: { path: 'relative-path' },
    suggestion: "export default defineApp({ config: (env) => ({ ... }) }) from 'jsails/kernel'",
  },
  config_failed: {
    kind: 'internal',
    message: 'the config function of {path} threw',
    context: { path: 'relative-path' },
  },
  async_config: {
    kind: 'internal',
    message: 'the config function of {path} returned a promise',
    context: { path: 'relative-path' },
    suggestion:
      'return the config object itself from config(env); do asynchronous work in a plugin setup',
  },
  outside_graph: {
    kind: 'internal',
    message:
      'the app config module {path} imports outside the config graph ({problem}) at {line}:{column}',
    context: {
      path: 'relative-path',
      line: 'count',
      column: 'count',
      problem: [
        'relative_import',
        'absolute_import',
        'url_import',
        'builtin_import',
        'dynamic_import',
        'require_call',
        'missing_module',
        'subpath_import',
        'self_import',
      ],
    },
    suggestion:
      'a config imports npm packages and erasable modules under config/ only; name app code with moduleRef',
  },
  non_erasable_syntax: {
    kind: 'internal',
    message:
      'the app config module {path} uses {construct} at {line}:{column}, which type stripping cannot erase',
    context: {
      path: 'relative-path',
      line: 'count',
      column: 'count',
      construct: [
        'enum',
        'namespace',
        'parameter_property',
        'import_equals',
        'export_assignment',
        'decorator',
      ],
    },
    suggestion: 'use a union of string literals for an enum and a module for a namespace',
  },
  invalid_syntax: {
    kind: 'internal',
    message: 'the app config module {path} does not parse at {line}:{column}',
    context: { path: 'relative-path', line: 'count', column: 'count' },
  },
  activation_not_literal: {
    kind: 'invalid',
    message: 'plugins.activation.mode in {path} at {line}:{column} is not a string literal',
    context: { path: 'relative-path', line: 'count', column: 'count' },
    suggestion:
      "write mode: 'locked' or mode: 'managed' in the config itself; no variable, environment value or setting may choose it",
  },
  activation_repeated: {
    kind: 'invalid',
    message:
      'plugins.activation in {path} at {line}:{column} repeats one stated earlier in the config graph',
    context: { path: 'relative-path', line: 'count', column: 'count' },
    suggestion: 'state plugins.activation once, in the root or one config/ module',
  },
  activation_mismatch: {
    kind: 'invalid',
    message:
      'the config of {path} returns a plugins.activation.mode other than the literal at {line}:{column}',
    context: { path: 'relative-path', line: 'count', column: 'count' },
    suggestion:
      'return the plugins.activation block as written; no variable, environment value or setting may change it',
  },
  activation_unstated: {
    kind: 'invalid',
    message:
      'the config of {path} returns a plugins.activation.mode that no plugins.activation literal in its config graph states',
    context: { path: 'relative-path' },
    suggestion:
      "write plugins.activation as the object literal activation: { mode: 'managed' } inside plugins, in the config or a config/ module",
  },
} as const;

/**
 * `config.*`: the application's configuration as the kernel loads it.
 *
 * - Plugin options or environment variables that do not satisfy the
 *   plugin's schemas.
 * - The app config's own environment schema.
 * - A plugin graph that cannot be ordered or satisfied.
 * - A removed option, which is named with its replacement.
 * - An app config module that strays outside its import graph or its
 *   erasable syntax, located by path, line and column.
 * - A config function that throws.
 *
 * A payload's issues hold where (an option path, a variable name) and which
 * rule failed, never a value.
 *
 * @public
 */
export const ConfigErrors: ErrorRegistry<'config', typeof CONFIG_ERRORS> = defineErrors(
  'config',
  CONFIG_ERRORS,
);
