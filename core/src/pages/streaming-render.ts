/**
 * Streaming server rendering of one page document.
 *
 * {@link streamDocument} renders a resolved Preact tree in two parts. The
 * shell — everything outside a pending `Suspense` boundary, the `<head>`
 * included — is rendered synchronously and becomes the first chunk, with each
 * pending boundary's fallback between `<!--$s:id-->` markers. Every suspended
 * subtree is rendered when its data resolves and sent as a hidden
 * `<jsails-chunk>`, which one small inline script moves over the fallback.
 *
 * The shell is rendered by preact-render-to-string's `renderToString` with a
 * renderer state as its third argument: the same entry point the library's own
 * streaming renderers use. Those renderers are not used directly because they
 * swallow a component that throws inside a resumed subtree (it is emitted as
 * the text `undefined`) and a rejected suspension, and neither reaches an error
 * hook; owning the suspension step is what lets a late failure be reported.
 * The vnode fields read here (`__`, `__c`, `__v`) are Preact's mangled
 * internals, named exactly as preact-render-to-string reads them.
 *
 * A failure while rendering the shell throws, exactly like the buffered
 * renderer, so the HTTP layer keeps its status and error-page behavior. After
 * the shell the status line is sent: a failure then closes the document with
 * a value-free fallback and goes to `onError`.
 *
 * The body is pull-based, so delivery follows the client's pace, and a cancel
 * (a client disconnect) aborts the render: subtrees whose data resolves later
 * are never rendered. A deadline bounds the rest: a suspension that never
 * settles would otherwise hold the response and the request open for good.
 */

import type { VNode } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { detach, escalate } from '../support/detach.js';

const DOCTYPE = '<!DOCTYPE html>';

/** How long, by default, the suspended subtrees have to finish after the shell. */
export const STREAM_TIMEOUT_MS = 30_000;

/** Opens a document around a shell that has no `<html>` root. */
const DOCUMENT_OPEN = '<html><head><meta charset="utf-8"></head><body>';

const DOCUMENT_CLOSE = '</body></html>';

/** Opens the hidden container of deferred subtrees and defines their swap. */
const DEFERRED_OPEN =
  '<div hidden><script>customElements.get("jsails-chunk")||customElements.define("jsails-chunk",class extends HTMLElement{connectedCallback(){requestAnimationFrame(()=>{var t="$s:"+this.dataset.target,w=document.createTreeWalker(document,128),s,e;while(w.nextNode()){var n=w.currentNode;if(n.data===t)s=n;else if(s&&n.data==="/"+t){e=n;break}}if(s&&e){while(s.nextSibling&&s.nextSibling!==e)s.nextSibling.remove();while(this.firstChild)e.parentNode.insertBefore(this.firstChild,e)}this.remove()})}})</script>';

const DEFERRED_CLOSE = '</div>';

/**
 * Appended after a failure past the first flush. It closes the hidden
 * container (always open then: only a suspended subtree renders after the
 * shell), shows a generic notice, and ends the document. It never carries
 * anything from the error.
 */
export const STREAM_ERROR_FALLBACK: string =
  DEFERRED_CLOSE +
  '<div role="alert" data-jsails-stream-error="">This part of the page could not be loaded.</div>' +
  DOCUMENT_CLOSE;

/** Options for {@link streamDocument}. */
export interface StreamDocumentOptions {
  /** Splices the page's head tags into the first chunk, a complete document start. */
  readonly injectHead: (documentStart: string) => string;
  /** Receives a render failure that happened after the first chunk was produced. */
  readonly onError?: (error: unknown) => void;
  /**
   * Milliseconds the suspended subtrees have to finish once the shell is out;
   * {@link STREAM_TIMEOUT_MS} when omitted. When it passes, the document ends
   * with the fallback and `timeoutError()` goes to `onError`.
   */
  readonly timeoutMs?: number;
  /** The error reported when the deadline passes. */
  readonly timeoutError?: () => unknown;
}

/** Preact's mangled vnode and component fields, as preact-render-to-string reads them. */
const PARENT = '__';
const COMPONENT = '__c';
const CHILD_DID_SUSPEND = '__c';
const ORIGINAL = '__v';

type InternalNode = Record<string, unknown> & {
  readonly props: { readonly children?: unknown; readonly fallback?: unknown };
};

type RenderChild = (child: unknown, parent: InternalNode) => string | undefined;

/** The renderer state `renderToString` accepts as its third argument. */
interface RendererState {
  readonly onError: (error: unknown, vnode: InternalNode, renderChild: RenderChild) => unknown;
}

const renderShell = renderToString as unknown as (
  vnode: VNode,
  context: object,
  state: RendererState,
) => string;

/** A pending boundary: its id and a promise settled once it rendered or was abandoned. */
interface Suspension {
  readonly id: unknown;
  readonly settled: Promise<void>;
}

/**
 * Render `vnode` as a streamed HTML document. The shell is rendered before
 * this returns, so a failure there throws; the body produces the rest.
 */
export function streamDocument(
  vnode: VNode,
  options: StreamDocumentOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pending: string[] = [];
  const suspensions: Suspension[] = [];
  const abort = new AbortController();
  const abandoned = new Promise<void>((resolve) => {
    abort.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  let shellDone = false;
  let ended = false;
  let wake: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const push = (text: string): void => {
    if (ended) return;
    pending.push(text);
    wake?.();
  };
  const end = (tail: string): void => {
    if (ended) return;
    if (tail !== '') pending.push(tail);
    ended = true;
    clearTimeout(deadline);
    wake?.();
  };
  const fail = (error: unknown): void => {
    if (abort.signal.aborted) return;
    abort.abort();
    end(STREAM_ERROR_FALLBACK);
    if (options.onError === undefined) return;
    try {
      options.onError(error);
    } catch {
      // The document is already closed; a broken observer cannot change it.
    }
  };

  const onError: RendererState['onError'] = (error, node, renderChild) => {
    if (!isThenable(error)) {
      // Before the shell is out, the throw propagates and `streamDocument`
      // throws with it.
      if (shellDone) fail(error);
      return undefined;
    }
    const boundary = suspenseBoundary(node);
    if (boundary === undefined) return undefined;
    // The library hands the error to the nearest component whose children
    // threw, which can sit deep inside the boundary. Markers placed there would
    // leave the siblings rendered before it in the shell while the resumed
    // chunk renders the boundary's whole children again, duplicating them.
    // Rethrowing moves the suspension up, component by component, until it
    // reaches the boundary's own rendered child (the wrapper `Suspense`
    // renders, or a direct child during a resumed render).
    if (node[PARENT] !== boundary) throw error;
    const id = boundary[ORIGINAL];
    const known = suspensions.some((suspension) => suspension.id === id);
    const resumed = error.then(
      () => {
        if (abort.signal.aborted) return;
        const before = suspensions.length;
        const child = renderChild(boundary.props.children, boundary);
        if (abort.signal.aborted) return;
        // Suspended again on new data: that suspension sends the subtree.
        if (suspensions.slice(before).some((suspension) => suspension.id === id)) return;
        push(`<jsails-chunk hidden data-target="${String(id)}">${child ?? ''}</jsails-chunk>`);
      },
      (rejection: unknown) => fail(rejection),
    );
    suspensions.push({ id, settled: Promise.race([resumed, abandoned]) });
    if (known) return '';
    const fallback = renderChild(boundary.props.fallback, boundary) ?? '';
    return `<!--$s:${String(id)}-->${fallback}<!--/$s:${String(id)}-->`;
  };

  const shell = renderShell(vnode, {}, { onError });
  shellDone = true;

  const htmlRoot = /^<html[\s>]/i.test(shell.trimStart());
  const close = htmlRoot ? '' : DOCUMENT_CLOSE;
  const open = (content: string): string =>
    DOCTYPE + options.injectHead(htmlRoot ? content : DOCUMENT_OPEN + content);

  if (suspensions.length === 0) {
    end(open(shell) + close);
  } else {
    // Deferred subtrees go inside `<body>`, so a document's closing tags are
    // held back until every boundary has resolved.
    const bodyClose = htmlRoot ? shell.lastIndexOf('</body>') : -1;
    const start = bodyClose === -1 ? shell : shell.slice(0, bodyClose);
    const suffix = bodyClose === -1 ? '' : shell.slice(bodyClose);
    push(open(start) + DEFERRED_OPEN);
    detach(
      settle(suspensions).then(() => end(DEFERRED_CLOSE + suffix + close)),
      escalate,
    );
    deadline = setTimeout(() => {
      fail(options.timeoutError?.() ?? new Error('a streamed page did not finish in time'));
    }, options.timeoutMs ?? STREAM_TIMEOUT_MS);
    // An open response already keeps the server alive; the deadline alone
    // must not keep a process from exiting.
    deadline.unref();
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (pending.length === 0 && !ended) {
          await new Promise<void>((wakeUp) => {
            wake = wakeUp;
          });
          wake = undefined;
        }
        const chunk = pending.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        ended = true;
        clearTimeout(deadline);
        pending.length = 0;
        abort.abort();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Wait until every suspension, including ones added while waiting, has settled. */
async function settle(suspensions: readonly Suspension[]): Promise<void> {
  let seen = 0;
  while (seen < suspensions.length) {
    const batch = suspensions.slice(seen);
    seen = suspensions.length;
    await Promise.all(batch.map((suspension) => suspension.settled));
  }
}

/** The nearest ancestor vnode whose component is a `Suspense` boundary. */
function suspenseBoundary(node: InternalNode): InternalNode | undefined {
  for (
    let current = node[PARENT] as InternalNode | null | undefined;
    current !== null && current !== undefined;
    current = current[PARENT] as InternalNode | null | undefined
  ) {
    const component = current[COMPONENT] as Record<string, unknown> | null | undefined;
    if (
      component !== null &&
      component !== undefined &&
      typeof component[CHILD_DID_SUSPEND] === 'function'
    ) {
      return current;
    }
  }
  return undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
