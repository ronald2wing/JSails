/**
 * The plugin settings page: its render side and its POST handler.
 *
 * One form is rendered per installed plugin whose manifest declares a
 * `settingsSchema`, projected through `projectSettingsSchema`: editable fields
 * (string/number/boolean) render as inputs, `unknown` fields render as
 * read-only JSON textareas that are never submitted. The POST rebuilds the
 * entry's settings from the editable submitted fields, preserving unknown keys,
 * and persists through the managed state source. Only available in managed
 * mode; every failure is a value-free error response.
 */

import {
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  csrfInput,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { PLUGIN_ID_PATTERN, type PluginState } from 'jsails/plugins';
import { h, type ComponentChild } from 'preact';

import { projectSettingsSchema, type SettingsFieldDescriptor } from './directory/settings.js';
import { loadInstalledPlugins } from './installed-plugins.js';
import type { PluginManagerAdminOptions } from './plugin-manager.js';
import {
  PLUGIN_NOTICE_SETTINGS_SAVED,
  readPluginNotice,
  renderPluginNotice,
} from './plugin-notices.js';

/** Upper bound on a submitted setting value length. */
const MAX_SETTING_VALUE_LENGTH = 4096;

/** The stored settings of one plugin, when any. */
type StoredSettings = Record<string, unknown> | undefined;

/**
 * Render the plugin settings page: one form per installed plugin whose manifest
 * declares a `settingsSchema`. Only available in managed mode.
 */
export async function renderPluginSettingsPage(
  context: AdminPageRenderContext,
  options: PluginManagerAdminOptions,
): Promise<string> {
  const notice = readPluginNotice(context.url.searchParams.get('notice'));
  const path = context.path;
  const body: ComponentChild[] = [h('h1', null, 'Plugin Settings')];
  if (notice !== undefined) {
    body.push(renderPluginNotice(notice));
  }

  const managed = options.managed === true && options.stateSource !== undefined;
  if (!managed) {
    body.push(h('p', null, 'Plugin settings require a managed plugin state source.'));
  } else {
    body.push(...(await renderPluginSettingsForms(options, path, context.session.csrfToken)));
  }

  body.push(h('a', { href: path }, 'Back to dashboard'));
  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Plugin Settings'), ...body);
}

/** Render a settings section per installed plugin that declares a schema. */
async function renderPluginSettingsForms(
  options: PluginManagerAdminOptions,
  path: string,
  csrf: string,
): Promise<ComponentChild[]> {
  const { discovered, state } = await loadInstalledPlugins(options);
  const installed = (discovered?.plugins ?? []).filter((plugin) =>
    Object.hasOwn(state.plugins, plugin.id),
  );
  if (installed.length === 0) {
    return [h('p', null, 'No installed plugins to configure.')];
  }
  return installed.map((plugin) =>
    renderSettingsSection({
      id: plugin.id,
      fields: projectSettingsSchema(plugin.manifest.settingsSchema),
      current: state.plugins[plugin.id]?.settings,
      path,
      csrf,
    }),
  );
}

/** The inputs of one plugin's settings section. */
interface SettingsSection {
  readonly id: string;
  readonly fields: readonly SettingsFieldDescriptor[];
  readonly current: StoredSettings;
  readonly path: string;
  readonly csrf: string;
}

/** One plugin's settings section: heading plus a form when fields exist. */
function renderSettingsSection(section: SettingsSection): ComponentChild {
  const { id, fields, current, path, csrf } = section;
  if (fields.length === 0) {
    return h('section', null, h('h2', null, id), h('p', null, 'No configurable settings.'));
  }
  const controls: ComponentChild[] = fields.map((field) =>
    field.type === 'unknown'
      ? renderUnknownField(field, current)
      : renderTypedField(field, current),
  );
  return h(
    'section',
    null,
    h('h2', null, id),
    h(
      'form',
      { method: 'post', action: `${path}/plugin-settings` },
      csrfInput(csrf),
      hiddenInput('action', 'save-settings'),
      hiddenInput('id', id),
      ...controls,
      h('button', { type: 'submit' }, 'Save settings'),
    ),
  );
}

/** Render an editable input for a typed field, pre-filled from current settings. */
function renderTypedField(field: SettingsFieldDescriptor, current: StoredSettings): ComponentChild {
  const id = `setting-${field.key}`;
  if (field.type === 'boolean') {
    return h(
      'label',
      { htmlFor: id },
      h('input', {
        type: 'checkbox',
        name: field.key,
        id,
        value: 'on',
        ...(fieldBooleanValue(field, current) ? { checked: true } : {}),
      }),
      ` ${field.label}`,
    );
  }
  return h(
    'div',
    null,
    h('label', { htmlFor: id }, field.label),
    h('input', {
      type: field.type === 'number' ? 'number' : 'text',
      name: field.key,
      id,
      value: fieldStringValue(field, current),
    }),
  );
}

/** Render a read-only textarea for an unknown-shaped field (never submitted). */
function renderUnknownField(
  field: SettingsFieldDescriptor,
  current: StoredSettings,
): ComponentChild {
  const value = current?.[field.key];
  return h(
    'div',
    null,
    h('label', null, field.key),
    h('textarea', { readonly: true }, value === undefined ? '' : jsonStringify(value)),
  );
}

/** Resolve a string/number field's input value (current, then default, else ''). */
function fieldStringValue(field: SettingsFieldDescriptor, current: StoredSettings): string {
  const currentValue = current?.[field.key];
  if (currentValue !== undefined && currentValue !== null) {
    return String(currentValue);
  }
  if (field.defaultValue !== undefined) {
    return String(field.defaultValue);
  }
  return '';
}

/** Resolve a boolean field's checked state (current, then default, else false). */
function fieldBooleanValue(field: SettingsFieldDescriptor, current: StoredSettings): boolean {
  const currentValue = current?.[field.key];
  if (typeof currentValue === 'boolean') {
    return currentValue;
  }
  return field.defaultValue === true;
}

/**
 * Handle the settings page POST: validate the target id against the managed
 * state, rebuild the entry's settings from the editable submitted fields, and
 * persist. Value-free errors for every failure.
 */
export async function handlePluginSettingsPost(
  context: AdminPagePostContext,
  options: PluginManagerAdminOptions,
): Promise<Response> {
  if (context.body['action'] !== 'save-settings') {
    return adminBadRequestResponse();
  }
  const stateSource = options.stateSource;
  if (options.managed !== true || stateSource === undefined) {
    return adminForbiddenResponse('plugin state is not managed');
  }
  const id = context.body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }

  const { discovered, state } = await loadInstalledPlugins(options);
  const manifest = discovered?.plugins.find((plugin) => plugin.id === id)?.manifest;
  if (manifest === undefined) {
    return adminNotFoundResponse();
  }
  if (!Object.hasOwn(state.plugins, id)) {
    return adminNotFoundResponse();
  }

  const entry = state.plugins[id]!;
  const settings = buildSettings(
    projectSettingsSchema(manifest.settingsSchema),
    context.body,
    entry.settings,
  );
  if (settings === undefined) {
    return adminBadRequestResponse();
  }

  const next: PluginState = {
    version: state.version,
    plugins: { ...state.plugins, [id]: { ...entry, settings } },
  };
  try {
    await stateSource.save(next);
  } catch {
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${context.path}/plugin-settings?notice=${PLUGIN_NOTICE_SETTINGS_SAVED}`,
  );
}

/**
 * Build the next settings object: preserve unknown keys, apply the editable
 * submitted fields. `undefined` when a submitted value is too long or a number
 * field is not numeric.
 */
function buildSettings(
  fields: readonly SettingsFieldDescriptor[],
  body: Record<string, string>,
  existing: StoredSettings,
): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = { ...existing };
  for (const field of fields) {
    if (field.type === 'unknown') {
      continue;
    }
    if (field.type === 'boolean') {
      settings[field.key] = body[field.key] === 'on';
      continue;
    }
    const raw = body[field.key];
    if (raw === undefined) {
      if (field.defaultValue !== undefined) {
        settings[field.key] = field.defaultValue;
      } else {
        delete settings[field.key];
      }
      continue;
    }
    if (raw.length > MAX_SETTING_VALUE_LENGTH) {
      return undefined;
    }
    if (field.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return undefined;
      }
      settings[field.key] = value;
      continue;
    }
    settings[field.key] = raw;
  }
  return settings;
}

/** JSON-stringify a settings value for the read-only textarea; never throws. */
function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
