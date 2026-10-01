#!/usr/bin/env node
/**
 * The `create-jsails` executable (`package.json` `bin`): the same Node
 * version check as `bin.cjs`, in ES5 CommonJS with no `require`, then
 * `create-jsails.js`. NODE_FLOOR equals the `engines.node` floor of
 * `package.json` (a test holds them equal).
 */

var NODE_FLOOR = 26;
var running = String(process.versions.node);
var major = Number(running.split('.')[0]);

if (!(major >= NODE_FLOOR)) {
  process.stderr.write(
    'create-jsails: Node.js ' +
      NODE_FLOOR +
      ' or later is required; this is Node.js ' +
      running +
      '\n',
  );
  process.exitCode = 1;
} else {
  import('./create-jsails.js').then(
    function (create) {
      return create.main(process.argv.slice(2));
    },
    function () {
      // A broken install: the module's error may name local paths, so only
      // the fact is printed.
      process.stderr.write('create-jsails: the CLI could not be loaded\n');
      process.exitCode = 1;
    },
  );
}
