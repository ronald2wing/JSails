/**
 * The CLI's codes, `cli.*`: a command a dependency or the app contributes
 * that cannot run (its module fails to load or does not default-export a
 * `defineCommand` value), a name two sources claim, and a command that is
 * not installed. The context names commands, packages and module paths
 * under the app root, never an input value.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const CLI_ERRORS = {
  load_failed: {
    kind: 'internal',
    message: 'command {command} failed to load from {source}',
    context: { command: 'identifier', source: 'identifier' },
  },
  invalid_command: {
    kind: 'internal',
    message: 'command {command} from {source} is invalid: {problem}',
    context: {
      command: 'identifier',
      source: 'identifier',
      problem: [
        'not_defined',
        'invalid_summary',
        'invalid_options',
        'invalid_positionals',
        'invalid_needs',
        'invalid_details',
        'missing_run',
      ],
    },
    suggestion: 'default-export defineCommand({ summary, options, run }) from jsails',
  },
  reserved_command: {
    kind: 'conflict',
    message: '{source} declares command {command}, which is built in',
    context: { command: 'identifier', source: 'identifier' },
  },
  ambiguous_command: {
    kind: 'conflict',
    message: 'command {command} is declared by both {first} and {second}',
    context: { command: 'identifier', first: 'identifier', second: 'identifier' },
  },
  missing_dependency: {
    kind: 'not_found',
    message: 'command {command} comes from {package}, which this project does not install',
    context: { command: 'identifier', package: 'identifier' },
    suggestion: 'install that package with npm, then run the command again',
  },
  invalid_exit_code: {
    kind: 'internal',
    message: 'command {command} from {source} returned an invalid exit code',
    context: { command: 'identifier', source: 'identifier' },
    suggestion: 'return nothing, or an integer from 0 to 255',
  },
  interactive_unavailable: {
    kind: 'invalid',
    message: 'the command asked a question, but it runs without interaction',
    suggestion: 'pass every value as an argument or option',
  },
  no_choices: {
    kind: 'internal',
    message: 'a selection prompt needs at least one choice',
  },
  invalid_selection: {
    kind: 'invalid',
    message: 'the answer is none of the offered choices',
  },
  invalid_command_definition: {
    kind: 'internal',
    message: 'defineCommand was given an invalid {field}',
    context: {
      field: ['definition', 'summary', 'options', 'positionals', 'needs', 'details', 'run'],
    },
  },
} as const;

/**
 * The CLI's codes, `cli.*`.
 *
 * @public
 */
export const CliErrors: ErrorRegistry<'cli', typeof CLI_ERRORS> = defineErrors('cli', CLI_ERRORS);
