/**
 * Component events of islands: what a compiled `defineEmits<E>()` becomes.
 * An event `change` with arguments `[value: number]` is the optional prop
 * `onChange?: (value: number) => void`, which a parent sets with
 * `@change="…"`, and `emit('change', 3)` calls it when it is set.
 *
 * Browser-safe and dependency-free.
 */

/**
 * An island's events: each event name (a camelCase identifier) to the tuple
 * of arguments it passes (`{ change: [value: number]; close: [] }`).
 *
 * @public
 */
export type EmitMap<E> = { readonly [K in keyof E]: readonly unknown[] };

/**
 * The handler props a parent sets for the events `E`: `onChange` for
 * `change`, each optional.
 *
 * @public
 */
export type EmitProps<E extends EmitMap<E>> = {
  readonly [K in keyof E & string as `on${Capitalize<K>}`]?: (...args: E[K]) => void;
};

/**
 * The `emit` function of an island: calls the handler prop of `event` with
 * `args`, when the parent set one.
 *
 * @public
 */
export type Emit<E extends EmitMap<E>> = <K extends keyof E & string>(
  event: K,
  ...args: E[K]
) => void;

/**
 * The `emit` function over an island's props: `emit('change', 3)` calls
 * `props.onChange(3)` when it is a function, and does nothing otherwise.
 *
 * @public
 */
export function emitter<E extends EmitMap<E>>(props: EmitProps<E>): Emit<E> {
  return (event, ...args) => {
    const name = `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
    const handler = (props as Readonly<Record<string, unknown>>)[name];
    if (typeof handler === 'function') (handler as (...values: unknown[]) => void)(...args);
  };
}
