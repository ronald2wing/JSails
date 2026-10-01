/**
 * Two-way binding of a form control to a value holder, what an island's
 * `js-model` compiles to: `bindControl(count, 'text', { number: true })`
 * returns the attributes to spread onto the control, its value (or checked
 * state) read from the target and the handler that writes the control's
 * value back. The target is anything with a writable `value`, in practice a
 * Preact signal, whose read during render subscribes the island.
 *
 * The value rules are the live client's (`client/bindings/control-values.ts`),
 * so `js-model` means one thing in a live component and in an island: `trim`
 * trims; `number` (and an `<input type="number">` or `"range"`) yields a
 * finite number when the text is one, and otherwise the text (`''` when the
 * numeric input is empty). While the user types, the control keeps the raw
 * text as long as it still converts to the target's value, so a trailing
 * space or a `1.` is not rewritten under the cursor; `change` (leaving the
 * control) writes the normalised value back. A `lazy` binding writes the
 * target on `change` only, and keeps the pending text across re-renders
 * until then.
 *
 * The control's own `input` and `change` handlers, an island's `@input` or
 * `@change` beside `js-model`, are passed as `handlers` and run after the
 * binding's, so both run, the target already holds the new value when the
 * author's handler reads it, and neither replaces the other (as in Vue, where
 * the model's listener is registered before the element's own).
 *
 * Browser-safe and dependency-free: the controls are typed by the members
 * the handlers read, so this compiles without the DOM library.
 */

/**
 * Anything `js-model` can bind: an object with a writable `value`, such as
 * a Preact signal.
 *
 * @public
 */
export interface ControlTarget<T> {
  value: T;
}

/**
 * The event a model handler receives: the control is its `currentTarget`.
 *
 * @public
 */
export interface ControlEvent {
  readonly currentTarget: { value: string; readonly checked?: boolean };
}

/**
 * The attributes of a text-like control, a numeric input or a select.
 *
 * @public
 */
export interface ValueControlAttributes {
  readonly value: string;
  readonly onInput?: (event: ControlEvent) => void;
  readonly onChange?: (event: ControlEvent) => void;
}

/**
 * The attributes of a checkbox.
 *
 * @public
 */
export interface CheckboxControlAttributes {
  readonly checked: boolean;
  readonly onChange: (event: ControlEvent) => void;
}

/**
 * The attributes of a radio button: its value, and whether it is the one
 * the target holds.
 *
 * @public
 */
export interface RadioControlAttributes {
  readonly value: string;
  readonly checked: boolean;
  readonly onChange: (event: ControlEvent) => void;
}

/**
 * The control a binding drives: a text-like input or textarea, a numeric
 * input (`type="number"` or `"range"`), a checkbox, a radio button, or a
 * single select.
 *
 * @public
 */
export type ControlKind = 'text' | 'number' | 'checkbox' | 'radio' | 'select';

/**
 * The control's own event handlers, run after the binding's handler of the
 * same event. They are methods so that a handler typed for the real element
 * (Preact's `TargetedInputEvent<HTMLInputElement>`) is accepted.
 *
 * @public
 */
export interface ControlHandlers {
  onInput?(event: ControlEvent): void;
  onChange?(event: ControlEvent): void;
}

/**
 * The modifiers of a binding, a radio button's own value, and the control's
 * own handlers.
 *
 * @public
 */
export interface ControlOptions {
  readonly lazy?: boolean;
  readonly trim?: boolean;
  readonly number?: boolean;
  readonly value?: string;
  readonly handlers?: ControlHandlers;
}

/** The raw text a control holds for a target, per target. */
const typed = new WeakMap<object, string>();

/** Text not yet written to a `lazy` binding's target, per target. */
const pending = new WeakMap<object, string>();

/**
 * Bind a text-like input or a textarea to a string target; with `trim`, the
 * target holds the trimmed text.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string>,
  control: 'text',
  options?: {
    readonly lazy?: boolean;
    readonly trim?: boolean;
    readonly number?: false;
    readonly handlers?: ControlHandlers;
  },
): ValueControlAttributes;
/**
 * Bind a text-like input or a textarea with `number`: the target holds a
 * finite number when the text is one, and the text otherwise.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string | number>,
  control: 'text',
  options: {
    readonly lazy?: boolean;
    readonly trim?: boolean;
    readonly number: true;
    readonly handlers?: ControlHandlers;
  },
): ValueControlAttributes;
/**
 * Bind a numeric input: the target holds a finite number, or `''` while the
 * input is empty.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string | number>,
  control: 'number',
  options?: { readonly lazy?: boolean; readonly handlers?: ControlHandlers },
): ValueControlAttributes;
/**
 * Bind a single select to the value of its selected option.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string>,
  control: 'select',
  options?: { readonly number?: false; readonly handlers?: ControlHandlers },
): ValueControlAttributes;
/**
 * Bind a single select with `number`: the target holds a finite number when
 * the selected option's value is one.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string | number>,
  control: 'select',
  options: { readonly number: true; readonly handlers?: ControlHandlers },
): ValueControlAttributes;
/**
 * Bind a checkbox to a boolean target.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<boolean>,
  control: 'checkbox',
  options?: { readonly handlers?: ControlHandlers },
): CheckboxControlAttributes;
/**
 * Bind a radio button: it is checked while the target holds its `value`, and
 * checking it writes that value.
 *
 * @public
 */
export function bindControl(
  target: ControlTarget<string>,
  control: 'radio',
  options: { readonly value: string; readonly handlers?: ControlHandlers },
): RadioControlAttributes;
export function bindControl(
  target: ControlTarget<unknown>,
  control: ControlKind,
  options: ControlOptions = {},
): ValueControlAttributes | CheckboxControlAttributes | RadioControlAttributes {
  return withHandlers(binding(target, control, options), options.handlers);
}

/** The binding's own attributes, before the control's handlers join them. */
function binding(
  target: ControlTarget<unknown>,
  control: ControlKind,
  options: ControlOptions,
): ValueControlAttributes | CheckboxControlAttributes | RadioControlAttributes {
  if (control === 'checkbox') {
    return {
      checked: target.value === true,
      onChange: (event) => {
        target.value = event.currentTarget.checked === true;
      },
    };
  }
  if (control === 'radio') {
    const value = options.value ?? '';
    return {
      value,
      checked: target.value === value,
      onChange: (event) => {
        if (event.currentTarget.checked === true) target.value = value;
      },
    };
  }
  if (control === 'select') {
    return {
      value: asText(target.value),
      onChange: (event) => {
        target.value = convert(event.currentTarget.value, 'text', { number: options.number });
      },
    };
  }
  return textBinding(target, control, options);
}

/**
 * `attributes` with each of the control's own handlers run after the
 * binding's handler of the same event, or in its place where the binding
 * has none.
 */
function withHandlers<
  A extends ValueControlAttributes | CheckboxControlAttributes | RadioControlAttributes,
>(attributes: A, handlers: ControlHandlers | undefined): A {
  if (handlers === undefined) return attributes;
  const joined = (
    own: ((event: ControlEvent) => void) | undefined,
    event: keyof ControlHandlers,
  ): ((event: ControlEvent) => void) | undefined =>
    handlers[event] === undefined
      ? own
      : (value) => {
          own?.(value);
          handlers[event]?.(value);
        };
  const onInput = joined('onInput' in attributes ? attributes.onInput : undefined, 'onInput');
  const onChange = joined(attributes.onChange, 'onChange');
  return {
    ...attributes,
    ...(onInput === undefined ? {} : { onInput }),
    ...(onChange === undefined ? {} : { onChange }),
  };
}

/** A text-like or numeric control's attributes. */
function textBinding(
  target: ControlTarget<unknown>,
  control: 'text' | 'number',
  options: ControlOptions,
): ValueControlAttributes {
  // Whether `change` rewrites what the control shows (a trimmed or parsed value).
  const normalises = control === 'number' || options.trim === true || options.number === true;
  const settle = (event: ControlEvent): void => {
    typed.delete(target);
    if (normalises) event.currentTarget.value = asText(target.value);
  };
  if (options.lazy === true) {
    return {
      value: pending.get(target) ?? asText(target.value),
      onInput: (event) => {
        pending.set(target, event.currentTarget.value);
      },
      onChange: (event) => {
        pending.delete(target);
        target.value = convert(event.currentTarget.value, control, options);
        settle(event);
      },
    };
  }
  const raw = typed.get(target);
  return {
    value:
      raw !== undefined && convert(raw, control, options) === target.value
        ? raw
        : asText(target.value),
    onInput: (event) => {
      const text = event.currentTarget.value;
      typed.set(target, text);
      target.value = convert(text, control, options);
    },
    ...(normalises ? { onChange: settle } : {}),
  };
}

/** The value a control's text stands for, under the binding's rules. */
function convert(
  text: string,
  control: 'text' | 'number',
  options: { readonly trim?: boolean | undefined; readonly number?: boolean | undefined },
): string | number {
  if (control === 'number') {
    if (text.trim() === '') return '';
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  const value = options.trim === true ? text.trim() : text;
  if (options.number === true && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/** A target's value as control text. */
function asText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
