/**
 * Native dialog wrapper.
 *
 * A controlled `<dialog>`: `showModal()`/`close()` are called from an effect to
 * match `open`. The browser owns focus management, Esc handling, and the top
 * layer; no focus trap is reimplemented. During SSR the dialog renders without
 * `open` (effects do not run), so hydration matches the server markup.
 *
 * An accessible name is required: pass `label` or `aria-labelledby`.
 */

import type { ComponentChildren, DialogHTMLAttributes } from 'preact';

import { cx } from './class-names.js';

/** Props accepted by {@link UiDialog}. */
export interface UiDialogProps extends Omit<
  DialogHTMLAttributes<HTMLDialogElement>,
  'open' | 'onClose' | 'onCancel'
> {
  /** Controlled open state. The component syncs the native dialog to it. */
  open: boolean;
  /** Accessible name; rendered as `aria-label` unless `aria-labelledby` is set. */
  label?: string;
  /** Called when the dialog closes (Esc, backdrop, or `close()`). */
  onClose?: () => void;
  /** Called when the user requests cancel (Esc). Return value is ignored. */
  onCancel?: () => void;
  children?: ComponentChildren;
}

/** A native `<dialog>` driven by a controlled `open` prop. */
export function UiDialog({
  open,
  label,
  onClose,
  onCancel,
  class: className,
  children,
  ...rest
}: UiDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      {...rest}
      ref={ref}
      aria-label={label}
      class={cx('modal', className)}
      onClose={onClose}
      onCancel={onCancel}
    >
      {children}
    </dialog>
  );
}
