/**
 * Which plugins only work in a live process: live tokens, plugins stranded by
 * live-only providers, and `describe().needsLive` on extensions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceToken } from '../../../src/extensions/services.js';
import { definePlugin } from '../../../src/plugins/contract/define-plugin.js';
import { selectLiveOnly } from '../../../src/plugins/contract/liveness.js';

const queue = createServiceToken<object>('probe.queue', { live: true });
const mailer = createServiceToken<object>('probe.mailer');
const pages = createServiceToken<object>('probe.pages');

const worker = definePlugin({ name: 'worker', provides: [queue], setup() {} })();
const mail = definePlugin({ name: 'mail', requires: [queue], provides: [mailer], setup() {} })();
const newsletter = definePlugin({ name: 'newsletter', requires: [mailer], setup() {} })();
const site = definePlugin({ name: 'site', provides: [pages], setup() {} })();

describe('selectLiveOnly', () => {
  it('selects plugins touching a live token and those stranded by them, in order', () => {
    assert.deepEqual(selectLiveOnly([site, newsletter, mail, worker]), [newsletter, mail, worker]);
  });

  it('keeps a consumer that another provider can still serve', () => {
    const staticMail = definePlugin({ name: 'static-mail', provides: [mailer], setup() {} })();
    assert.deepEqual(selectLiveOnly([worker, mail, staticMail, newsletter]), [worker, mail]);
  });

  it('reads describe().needsLive on extensions, failing closed when describe throws', () => {
    const live = { name: 'live', describe: () => ({ needsLive: true }), setup() {} };
    const plain = { name: 'plain', describe: () => ({}), setup() {} };
    const broken = {
      name: 'broken',
      describe: () => {
        throw new Error('describe failed');
      },
      setup() {},
    };
    assert.deepEqual(selectLiveOnly([live, plain, broken, site]), [live, broken]);
  });
});
