#!/usr/bin/env node
/**
 * The `jsails` executable (`package.json` `bin`): ES5 CommonJS with no
 * `require`, so any Node release can parse it and say which release this
 * jsails needs, before the ES module CLI (`index.js`), whose syntax an old
 * Node cannot parse, is imported. NODE_FLOOR equals the `engines.node` floor
 * of `package.json` (a test holds them equal).
 */

var NODE_FLOOR = 26;
var running = String(process.versions.node);
var major = Number(running.split('.')[0]);

if (!(major >= NODE_FLOOR)) {
  process.stderr.write(
    'jsails: Node.js ' + NODE_FLOOR + ' or later is required; this is Node.js ' + running + '\n',
  );
  process.exitCode = 1;
} else {
  import('./index.js').then(
    function (cli) {
      return cli.main(process.argv.slice(2));
    },
    function () {
      // A broken install: the module's error may name local paths, so only
      // the fact is printed.
      process.stderr.write('jsails: the CLI could not be loaded\n');
      process.exitCode = 1;
    },
  );
}
