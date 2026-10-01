#!/usr/bin/env node

/**
 * The `jamal` executable (`package.json` `bin`): runs one jamal verb over the
 * process arguments in the working directory and exits with its code. `jsails
 * jamal ...` forwards here when the package is installed in the project.
 */

import { runJamalCommand } from './command.js';
import { formatError } from './thrown-value.js';

runJamalCommand(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`jamal: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
