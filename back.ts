/**
 * @module web/ui/back
 *
 * The phone's Back button and back gesture (and the browser's Back) close what is open, topmost first: a dialog, the
 * menu, a form, a page other than Residents, the open gate. Each open layer adds a history entry; Back removes it and
 * closes the layer. A layer closed on the page (✕, Cancel, Save) takes its entry back off, so Back never lands on a
 * stale one. With nothing open, Back leaves the app as usual.
 */
import { useEffect, useRef } from 'react';

interface Layer { close: () => void; leave?: () => Promise<boolean> }

const stack: Layer[] = [];
// The entries are layers of one page, not places to scroll back to: without this, removing an entry (history.go)
// would also jump the page to where it was scrolled when the entry was added.
history.scrollRestoration = 'manual';
let toRemove = 0; // entries of layers closed on the page, removed together at the end of the current task
let skipping = 0; // our own history.go() calls still to arrive as popstate
const waiting: (() => void)[] = []; // entries to add once they have (history.go() is asynchronous)

function addEntry(): void {
  if (skipping || toRemove) waiting.push(addEntry);
  else history.pushState({ dkLayer: stack.length }, '');
}

function removeEntry(): void {
  if (!toRemove++) {
    queueMicrotask(() => {
      skipping++;
      history.go(-toRemove);
      toRemove = 0;
    });
  }
}

window.addEventListener('popstate', () => {
  if (skipping) {
    skipping--;
    if (!skipping) waiting.splice(0).forEach((add) => add());
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) {
    // An entry left from before the page was reloaded: nothing to close, so keep going back.
    if (history.state && typeof history.state.dkLayer === 'number') history.back();
    return;
  }
  if (!top.leave) {
    stack.pop();
    top.close();
    return;
  }
  // A layer that asks first (a form with typing in it): keep it open until the user agrees.
  addEntry();
  top.leave().then((ok) => { if (ok) top.close(); });
});

/**
 * While `open`, Back calls `close`. leave: asked first; resolves true to close (for forms that could lose typing).
 *
 * @param open - Whether the layer/dialog is open.
 * @param close - `() => void` value.
 * @param [leave] - Asked first.
 */
export function useBackLayer(open: boolean, close: () => void, leave?: () => Promise<boolean>): void {
  const layer = useRef<Layer>({ close, leave });
  layer.current.close = close;
  layer.current.leave = leave;
  const asks = leave !== undefined;
  useEffect(() => {
    if (!open) return undefined;
    const entry: Layer = { close: () => layer.current.close(), leave: asks ? () => layer.current.leave!() : undefined };
    stack.push(entry);
    addEntry();
    return () => {
      const i = stack.indexOf(entry);
      if (i < 0) return; // closed by Back: its entry is already gone
      stack.splice(i, 1);
      removeEntry();
    };
  }, [open, asks]);
}
