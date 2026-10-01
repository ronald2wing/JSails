/**
 * `collectFormData` and widget hosts, plus the structure rule that keeps it the
 * only way `core/src/client` serialises a form: no `new FormData(form)`
 * elsewhere (so the `formdata` event fires on every first-party submit path)
 * and no hand iteration of `form.elements`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectFormData,
  isNativeControl,
  widgetEntries,
  type FormEntries,
  type WidgetHostElement,
} from '../../src/client/form-data.js';
import { MODEL_ATTRIBUTE } from '../../src/server-components/protocol.js';

const clientSource = fileURLToPath(new URL('../../../src/client', import.meta.url));

/** Every TypeScript source under `core/src/client`, as `[posixRelativePath, text]`. */
function clientSources(): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push([relative, readFileSync(join(dir, entry.name), 'utf8')]);
      }
    }
  };
  walk(clientSource, '');
  return out;
}

describe('form serialisation structure', () => {
  it('builds a FormData from a form only in form-data.ts', () => {
    const offenders = clientSources()
      .filter(
        ([path, text]) => path !== 'form-data.ts' && /new\s+FormData\s*\(\s*[^)\s]/.test(text),
      )
      .map(([path]) => path);
    assert.deepEqual(
      offenders,
      [],
      `serialise a form with collectFormData: ${offenders.join(', ')}`,
    );
  });

  it('never iterates form.elements', () => {
    const offenders = clientSources()
      .filter(([, text]) => /\.elements\b/.test(text))
      .map(([path]) => path);
    assert.deepEqual(
      offenders,
      [],
      `serialise a form with collectFormData: ${offenders.join(', ')}`,
    );
  });

  it('routes every first-party submit path through collectFormData', () => {
    const callers = clientSources()
      .filter(([path, text]) => path !== 'form-data.ts' && text.includes('collectFormData('))
      .map(([path]) => path)
      .sort();
    assert.deepEqual(callers, ['bindings/dom-events.ts', 'island-directives.ts']);
  });
});

interface FakeHost extends WidgetHostElement<FakeHost> {
  readonly label: string;
}

/** The parent every in-scope host sits in; `foreign` hosts sit in another one. */
const scope: FakeHost = {
  tagName: 'form',
  label: 'scope',
  parentElement: null,
  getAttribute: () => null,
};
const elsewhere: FakeHost = { ...scope, label: 'elsewhere' };

function host(tagName: string, model: string | null, label = tagName): FakeHost {
  return {
    tagName,
    label,
    parentElement: label === 'foreign' ? elsewhere : scope,
    getAttribute: (name) => (name === MODEL_ATTRIBUTE ? model : null),
  };
}

function entries(record: Record<string, readonly unknown[]>): FormEntries {
  return { getAll: (name) => record[name] ?? [] };
}

describe('widgetEntries', () => {
  it('reads the single string entry of each widget host, in document order', () => {
    const form = {
      querySelectorAll: () => [host('div', 'body'), host('section', 'summary')],
    };
    assert.deepEqual(
      widgetEntries(form, entries({ body: ['{"doc":1}'], summary: ['short'] }), () => true),
      [
        ['body', '{"doc":1}'],
        ['summary', 'short'],
      ],
    );
  });

  it('skips native controls, excluded hosts, unnamed hosts, and missing, repeated, or file entries', () => {
    const file = new Blob(['x']);
    const form = {
      querySelectorAll: () => [
        host('INPUT', 'title'),
        host('textarea', 'notes'),
        host('select', 'tags'),
        host('div', 'foreign', 'foreign'),
        host('div', null),
        host('div', ''),
        host('div', 'missing'),
        host('div', 'many'),
        host('div', 'upload'),
        host('div', 'kept'),
      ],
    };
    const data = entries({
      title: ['t'],
      notes: ['n'],
      tags: ['a'],
      foreign: ['f'],
      many: ['1', '2'],
      upload: [file],
      kept: ['yes'],
    });
    assert.deepEqual(
      widgetEntries(form, data, (parent) => parent === scope),
      [['kept', 'yes']],
    );
  });

  it('asks the ownership rule about the host parent, so an island host counts', () => {
    const asked: Array<FakeHost | null> = [];
    const island = { ...host('div', 'body'), label: 'island' };
    const form = { querySelectorAll: () => [island] };
    assert.deepEqual(
      widgetEntries(form, entries({ body: ['doc'] }), (parent) => {
        asked.push(parent);
        return parent === scope;
      }),
      [['body', 'doc']],
    );
    assert.deepEqual(asked, [scope]);
  });

  it('recognises native controls by tag, case-insensitively', () => {
    for (const tag of ['input', 'SELECT', 'TextArea'])
      assert.equal(isNativeControl({ tagName: tag }), true);
    for (const tag of ['div', 'button', 'output'])
      assert.equal(isNativeControl({ tagName: tag }), false);
  });
});

describe('collectFormData', () => {
  it('returns null outside a browser form', () => {
    assert.equal(collectFormData({}), null);
  });

  it('builds new FormData(form) from a real form element', (t) => {
    const g = globalThis as Record<string, unknown>;
    const saved = { FormData: g.FormData, HTMLFormElement: g.HTMLFormElement };
    t.after(() => {
      g.FormData = saved.FormData;
      if (saved.HTMLFormElement === undefined) delete g.HTMLFormElement;
      else g.HTMLFormElement = saved.HTMLFormElement;
    });
    const built: object[] = [];
    class FakeForm {}
    class FakeFormData {
      constructor(form: object) {
        built.push(form);
      }
      getAll(): unknown[] {
        return [];
      }
    }
    g.HTMLFormElement = FakeForm;
    g.FormData = FakeFormData;

    const form = new FakeForm();
    const data = collectFormData(form);
    assert.ok(data instanceof FakeFormData);
    assert.deepEqual(built, [form]);
    assert.equal(collectFormData({}), null, 'a non-form element builds nothing');
  });
});
