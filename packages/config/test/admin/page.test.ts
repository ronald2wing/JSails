/**
 * Config admin page tests, through a real in-process app with the admin panel
 * mounted: forms render from the set declarations, a save writes through the
 * config service, overridden fields are disabled and never written, and an
 * invalid value refuses the whole form.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import { createTestApp, createTestSession, postForm, type TestApplication } from 'jsails/testing';

import { configAdmin } from '../../src/admin/index.js';
import { configPlugin, type Config } from '../../src/index.js';
import { mailConfig, siteConfig } from '../fixtures.js';

const SESSION = createTestSession({ id: 'config-admin' });

async function makeApp(overrides = {}): Promise<{ app: TestApplication; config: Config }> {
  const { config } = configPlugin({ sets: [siteConfig, mailConfig], overrides });
  const app = await createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            adminPlugins: [configAdmin({ config })],
          }),
        ),
      ],
    },
  });
  return { app, config };
}

const VALID = {
  _csrf: SESSION.csrfToken,
  action: 'save',
  set: 'site',
  'field.title': 'Saved title',
  'field.perPage': '25',
  'field.theme': 'dark',
  'field.links': '{"home": "/start"}',
};

describe('config admin page', { concurrency: 1 }, () => {
  it('renders a form per set from its fields', async () => {
    const { app } = await makeApp();
    const html = await (await app.request('/admin/config')).text();
    assert.match(html, /<h2>Site<\/h2>/);
    assert.match(html, /<h2>mail\.sender<\/h2>/);
    assert.match(html, /name="field\.perPage"[^>]*type="number"/);
    assert.match(html, /<select name="field\.theme"/);
    assert.match(html, /name="field\.comments"[^>]*type="checkbox"[^>]*checked/);
    await app.close();
  });

  it('saves a set through the config service', async () => {
    const { app, config } = await makeApp();
    const response = await postForm(app, '/admin/config', VALID);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=config_saved/);
    const values = await config.get(siteConfig);
    assert.equal(values.title, 'Saved title');
    assert.equal(values.perPage, 25);
    assert.equal(values.comments, false);
    assert.deepEqual(values.links, { home: '/start' });
    await app.close();
  });

  it('refuses the whole form on one invalid value', async () => {
    const { app, config } = await makeApp();
    const response = await postForm(app, '/admin/config', { ...VALID, 'field.perPage': '0' });
    assert.equal(response.status, 400);
    assert.equal((await config.get(siteConfig)).title, 'My site');
    await app.close();
  });

  it('shows an overridden field disabled with its forced value and never writes it', async () => {
    const { app, config } = await makeApp({ site: { title: 'From code' } });
    const html = await (await app.request('/admin/config')).text();
    assert.match(
      html,
      /name="field\.title"[^>]*disabled[^>]*value="From code"|name="field\.title"[^>]*value="From code"[^>]*disabled/,
    );
    assert.match(html, /Set in code/);
    const response = await postForm(app, '/admin/config', { ...VALID, 'field.title': 'Sneaky' });
    assert.equal(response.status, 303);
    assert.equal((await config.active(siteConfig)).title, 'My site');
    assert.equal((await config.get(siteConfig)).title, 'From code');
    await app.close();
  });

  it('refuses an unknown set or action', async () => {
    const { app } = await makeApp();
    assert.equal((await postForm(app, '/admin/config', { ...VALID, set: 'nope' })).status, 400);
    assert.equal((await postForm(app, '/admin/config', { ...VALID, action: 'drop' })).status, 400);
    await app.close();
  });
});
