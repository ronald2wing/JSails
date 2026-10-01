/**
 * Command-string tokenizer shared by the jamal CLI and the production planner.
 *
 * {@link splitCommandLine} turns a configured command string (an inlined
 * secrets command, `config.command`) into argv. It is a leaf module with no
 * CLI dependency, so the pure planner can use it without importing the CLI
 * layer.
 */

/**
 * Split a command string into argv, handling single and double quotes and
 * backslash escapes. Covers exactly the shell syntax an inlined
 * `jsails jamal secrets ...` command and a `config.command` start command
 * use; a nested `$(...)` stays one token for the runner this output feeds.
 */
export function splitCommandLine(command: string): readonly string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      break;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        started = true;
      } else if (char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === '\\' || next === '"' || next === '$') {
          current += next ?? '';
          index += 1;
        } else {
          current += char;
        }
        started = true;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) {
        current += char;
      } else {
        current += next;
        index += 1;
      }
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (started) {
    argv.push(current);
  }
  return argv;
}
