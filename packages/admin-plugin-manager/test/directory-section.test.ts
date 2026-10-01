/**
 * Tests for the curated directory section of the plugins page: search and
 * category filtering (an unknown category degrades to an empty state without
 * echoing it), the read-only rendering without a framework version, and the
 * install/update/rollback actions planned from the directory, including every
 * value-free refusal (unknown id, incompatible framework, no installer, no
 * framework version, downloads disabled, code-enabled id).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postForm } from 'jsails/testing';

import { PLUGIN_NOTICE_INSTALLED, PLUGIN_NOTICE_ROLLED_BACK } from '../src/index.js';
import {
  createDirectory,
  createInstaller,
  createPluginManagerApp,
  createStateSource,
  CSRF,
  DIRECTORY_FRAMEWORK,
} from './fixtures.js';

describe('plugin manager directory', () => {
  it('renders the directory with search, category filter, and a featured marker', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Plugin directory/);
    // Search input and category select.
    assert.match(body, /name="q"/);
    assert.match(body, /name="category"/);
    assert.match(body, />observability</);
    // A featured entry carries the marker.
    assert.match(body, /Featured/);
    assert.match(body, /Acme Tasks/);
    assert.match(body, /Acme Notes/);
    assert.match(body, /Acme Metrics/);
    // Not-installed entries render an Install action.
    assert.match(body, /Install/);
    // The raw id/version/url/checksum install form is entirely absent.
    assert.doesNotMatch(body, /name="url"/);
    assert.doesNotMatch(body, /name="sha256"/);

    await app.close();
  });

  it('searches directory entries by the q parameter', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?q=metrics');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Acme Metrics/);
    assert.doesNotMatch(body, /Acme Tasks/);
    assert.doesNotMatch(body, /Acme Notes/);

    await app.close();
  });

  it('filters directory entries by category', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?category=writing');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Acme Notes/);
    assert.doesNotMatch(body, /Acme Tasks/);
    assert.doesNotMatch(body, /Acme Metrics/);

    await app.close();
  });

  it('degrades an unknown category to an empty state without echoing it', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await app.request('/admin/plugins?category=SECRET-CATEGORY');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /No plugins match/);
    assert.doesNotMatch(body, /SECRET-CATEGORY/);

    await app.close();
  });

  it('renders the directory read-only when no framework version is configured', async () => {
    const app = await createPluginManagerApp({ plugins: { directory: createDirectory() } });

    const response = await app.request('/admin/plugins');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /framework version is not configured/);
    // No actionable install button without a framework version.
    assert.match(body, /Available/);
    assert.doesNotMatch(body, /name="url"/);

    await app.close();
  });

  it('installs a directory entry at the planned version and specifier', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`,
    );
    assert.equal(inst.installs.length, 1);
    assert.equal(inst.installs[0]!.id, 'acme-tasks');
    assert.equal(inst.installs[0]!.version, '1.2.3');
    assert.equal(inst.installs[0]!.url, 'acme-tasks@1.2.3');

    await app.close();
  });

  it('updates an installed directory entry to the latest version', async () => {
    const inst = createInstaller();
    const stateSource = createStateSource({ 'acme-tasks': { active: '1.0.0', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: stateSource.source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-update',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_INSTALLED}`,
    );
    assert.equal(inst.installs.length, 1);
    assert.equal(inst.installs[0]!.version, '1.2.3');
    assert.equal(inst.installs[0]!.url, 'acme-tasks@1.2.3');

    await app.close();
  });

  it('rolls a directory entry back to the curated latest version', async () => {
    const inst = createInstaller();
    const stateSource = createStateSource({ 'acme-tasks': { active: '2.0.0', enabled: true } });
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: inst.installer,
        stateSource: stateSource.source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-rollback',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      `/admin/plugins?notice=${PLUGIN_NOTICE_ROLLED_BACK}`,
    );
    assert.deepEqual(inst.rollbacks, [['acme-tasks', '1.2.3']]);

    await app.close();
  });

  it('returns 404 for an unknown directory id without echoing it', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'ghost-plugin',
    });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /ghost-plugin/);

    await app.close();
  });

  it('refuses a directory action when the framework version is incompatible', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: '2.0.0',
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /not compatible/);
    assert.doesNotMatch(body, /acme-tasks/);
    assert.doesNotMatch(body, /2\.0\.0/);

    await app.close();
  });

  it('refuses a directory action without an installer', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /not configured/);

    await app.close();
  });

  it('refuses a directory action without a framework version', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /framework version is not configured/);

    await app.close();
  });

  it('refuses a directory action when downloads are disabled', async () => {
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        downloads: false,
        installer: createInstaller().installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /disabled by configuration/);

    await app.close();
  });

  it('refuses to install a code-enabled directory id with 409', async () => {
    const inst = createInstaller();
    const app = await createPluginManagerApp({
      plugins: {
        directory: createDirectory(),
        frameworkVersion: DIRECTORY_FRAMEWORK,
        enabled: ['acme-tasks'],
        installer: inst.installer,
        stateSource: createStateSource().source,
      },
    });

    const response = await postForm(app, '/admin/plugins', {
      _csrf: CSRF,
      action: 'directory-install',
      id: 'acme-tasks',
    });
    assert.equal(response.status, 409);
    assert.equal(inst.installs.length, 0);

    await app.close();
  });
});
