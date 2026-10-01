/**
 * Test-only runtime shim for starter templates.
 *
 * A generated app receives these names through the N1 project shims plus the
 * scoped Vite/post-tsc hook injection. The repo's SSR tests import the templates
 * directly, so they install the same values before the page modules evaluate.
 */

import * as signals from '@preact/signals';
import * as hooks from 'preact/hooks';

import * as dialog from '../../templates/starter-web/ui/dialog.js';
import * as field from '../../templates/starter-web/ui/field.js';
import * as layout from '../../templates/starter-web/ui/layout.js';

Object.assign(globalThis, hooks, signals, dialog, field, layout);

const counter = await import('../../templates/starter-web/ui/counter.js');
const registerForm = await import('../../templates/starter-web/ui/register-form.js');
const resetForm = await import('../../templates/starter-web/ui/reset-password.js');

Object.assign(globalThis, counter, registerForm, resetForm);
