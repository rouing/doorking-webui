/**
 * @module web/ui/back
 *
 * The phone's Back button and back gesture (and the browser's Back) close what is open, topmost first: a dialog, the
 * menu, a form, a page other than Residents, the open gate. Each open layer adds a history entry; Back removes it and
 * closes the layer. A layer closed on the page (✕, Cancel, Save) takes its entry back off, so Back never lands on a
 * stale one. With nothing open, Back leaves the app as usual.
 */
import { useEffect, useRef } from 'react';

interface Layer { close: () => unknown; leave?: () => Promise<boolean> }

export interface BackHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  go(delta: number): void;
  back(): void;
}

/**
 * Pure history-layer stack controller: tracks how many entries were actually pushed (`pushedDepth`), clamps
 * `history.go(-steps)` so removals never walk past our own entries, and never cascades `history.back()` when
 * the stack is empty.
 */
export function createBackController(hist: BackHistory) {
  const stack: Layer[] = [];
  let pushedDepth = 0; // entries pushed by this controller and not yet removed or popped
  let toRemove = 0; // entries of layers closed on the page, removed together at the end of the current task
  let skipping = 0; // our own history.go() calls still to arrive as popstate
  const waiting: (() => void)[] = []; // entries to add once they have (history.go() is asynchronous)

  function flushWaiting(): void {
    if (!skipping && !toRemove) waiting.splice(0).forEach((add) => add());
  }

  function addEntry(): void {
    if (skipping || toRemove) {
      waiting.push(addEntry);
      return;
    }
    hist.pushState({ dkLayer: stack.length }, '');
    pushedDepth++;
  }

  function removeEntry(): void {
    if (waiting.length > 0) {
      waiting.pop();
      return;
    }
    if (!toRemove++) {
      queueMicrotask(() => {
        const steps = Math.min(toRemove, pushedDepth);
        toRemove = 0;
        if (steps > 0) {
          pushedDepth -= steps;
          skipping++;
          hist.go(-steps);
        } else {
          flushWaiting();
        }
      });
    }
  }

  function onPopState(): void {
    if (skipping) {
      skipping--;
      flushWaiting();
      return;
    }
    if (pushedDepth > 0) pushedDepth--;
    const top = stack[stack.length - 1];
    if (!top) {
      // Do not call history.back() on stale dkLayer entries when nothing is open; clear state in place instead.
      if (hist.state && typeof (hist.state as { dkLayer?: unknown }).dkLayer === 'number') {
        hist.replaceState(null, '');
      }
      return;
    }
    if (!top.leave) {
      stack.pop();
      if (top.close() === true) {
        stack.push(top);
        addEntry();
      }
      return;
    }
    // A layer that asks first (a form with typing in it): keep it open until the user agrees.
    addEntry();
    top.leave().then((ok) => { if (ok) top.close(); });
  }

  function push(entry: Layer): () => void {
    stack.push(entry);
    addEntry();
    return () => {
      const i = stack.indexOf(entry);
      if (i < 0) return; // closed by Back: its entry is already gone
      stack.splice(i, 1);
      removeEntry();
    };
  }

  return {
    push,
    onPopState,
    get depth() { return pushedDepth; },
    get size() { return stack.length; },
  };
}

const controller = typeof window !== 'undefined' && typeof history !== 'undefined'
  ? (() => {
      // The entries are layers of one page, not places to scroll back to: without this, removing an entry (history.go)
      // would also jump the page to where it was scrolled when the entry was added.
      history.scrollRestoration = 'manual';
      const ctrl = createBackController(history);
      window.addEventListener('popstate', ctrl.onPopState);
      return ctrl;
    })()
  : null;

/**
 * While `open`, Back calls `close`. If `close` returns `true`, the layer stays armed for another Back step (used by
 * multi-step history stacks). `leave`: asked first; resolves true to close (for forms that could lose typing).
 *
 * @param open - Whether the layer/dialog is open.
 * @param close - Back handler; return `true` to keep this layer armed for subsequent Back presses.
 * @param [leave] - Asked first.
 */
export function useBackLayer(open: boolean, close: () => unknown, leave?: () => Promise<boolean>): void {
  const layer = useRef<Layer>({ close, leave });
  layer.current.close = close;
  layer.current.leave = leave;
  const asks = leave !== undefined;
  useEffect(() => {
    if (!open || !controller) return undefined;
    const entry: Layer = { close: () => layer.current.close(), leave: asks ? () => layer.current.leave!() : undefined };
    return controller.push(entry);
  }, [open, asks]);
}
