/**
 * Command prompts over `node:readline/promises`, and the prompter a
 * non-interactive invocation gets, which refuses every question with
 * `cli.interactive_unavailable` instead of waiting for input that never
 * comes.
 */

import { createInterface } from 'node:readline/promises';

import type { Prompter } from './descriptor.js';
import { CliErrors } from './errors.js';

/**
 * A prompter over `input` and `output` (default: the process stdio). The
 * handle's `close()` releases the readline interface; whoever created it
 * closes it.
 *
 * @public
 */
export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter & { close(): void } {
  const rl = createInterface({ input, output });
  const ask = (query: string): Promise<string> => rl.question(query);
  return {
    async text(message, options = {}) {
      const suffix = options.default === undefined ? '' : ` [${options.default}]`;
      const answer = (await ask(`${message}${suffix}: `)).trim();
      return answer === '' ? (options.default ?? '') : answer;
    },
    async confirm(message, options = {}) {
      const suffix = options.default === true ? ' [Y/n]' : ' [y/N]';
      const answer = (await ask(`${message}${suffix}: `)).trim().toLowerCase();
      if (answer === '') return options.default ?? false;
      return answer === 'y' || answer === 'yes';
    },
    async select<T extends string>(message: string, choices: readonly T[]): Promise<T> {
      if (choices.length === 0) throw new CliErrors.Error('no_choices');
      const menu = choices.map((choice, index) => `  [${index + 1}] ${choice}`).join('\n');
      const answer = (await ask(`${message}\n${menu}\n> `)).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1] as T;
      }
      const exact = choices.find((choice) => choice === answer);
      if (exact !== undefined) return exact;
      throw new CliErrors.Error('invalid_selection');
    },
    close() {
      rl.close();
    },
  };
}

const refuse = (): Promise<never> => Promise.reject(new CliErrors.Error('interactive_unavailable'));

/**
 * The prompter of a non-interactive invocation: every question rejects with
 * `cli.interactive_unavailable`.
 */
export const NON_INTERACTIVE_PROMPTER: Prompter = Object.freeze({
  text: refuse,
  confirm: refuse,
  select: refuse,
});
