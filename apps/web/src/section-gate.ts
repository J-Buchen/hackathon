import { useEffect, useState, type RefObject } from "react";

/**
 * Deferred mounting for the heavy, below-the-fold sections (the fund console,
 * the worked example, the AgentHire and payment dashboards).
 *
 * Their data is fetched at once, but mounting all of them the moment it
 * arrived stacked their render work into the first second after paint (on a
 * 4× throttled phone profile), all of it for content far below the hero. A
 * gated section shows its skeleton (which reserves the same height, so nothing
 * shifts) until the first of:
 *
 *   1. it comes within one viewport of the screen (IntersectionObserver),
 *   2. the page is idle after load: the idle queue opens the remaining gates
 *      ONE per idle callback, in page order, so find-in-page and assistive
 *      tech still get the whole page within a few seconds and no single long
 *      task stacks them all up,
 *   3. there is a fragment in the URL at load, or any in-page jump happens
 *      (hashchange): navigation needs real heights, so every gate opens at
 *      once (the page then behaves exactly as it did before gating).
 *
 * The rules are plain functions over a small queue, tested in
 * section-gate.test.ts; the hook only wires them to React and the DOM.
 */

type Opener = () => void;

export interface GateQueue {
  /** Register a closed gate; returns an unregister function. */
  add(open: Opener): () => void;
  /** Open the next gate in registration order; false when none is left. */
  openNext(): boolean;
  /** Open every gate now (an in-page jump). Later gates open on registration. */
  openAll(): void;
  readonly allOpen: boolean;
  readonly size: number;
}

export function createGateQueue(): GateQueue {
  const pending: Opener[] = [];
  let all = false;
  return {
    add(open) {
      if (all) {
        open();
        return () => {};
      }
      pending.push(open);
      return () => {
        const i = pending.indexOf(open);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    openNext() {
      const next = pending.shift();
      if (!next) return false;
      next();
      return true;
    },
    openAll() {
      all = true;
      for (const open of pending.splice(0)) open();
    },
    get allOpen() {
      return all;
    },
    get size() {
      return pending.length;
    },
  };
}

const queue = createGateQueue();

type Idle = (cb: () => void) => void;
const onIdle: Idle = (cb) => {
  const w = globalThis as typeof globalThis & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb, { timeout: 2500 });
  else setTimeout(cb, 200);
};

/**
 * Start the idle queue and the hash rule (App calls it once). Gates opened by
 * idle time go one per idle period.
 */
export function startSectionGates(): () => void {
  if (typeof window === "undefined") return () => {};
  if (window.location.hash.length > 1) queue.openAll();
  const onHash = () => queue.openAll();
  window.addEventListener("hashchange", onHash);
  let cancelled = false;
  const drain = () => {
    if (cancelled) return;
    if (queue.openNext()) onIdle(drain);
  };
  const kick = () => onIdle(drain);
  // Per call, not once per module: under StrictMode the effect runs, is
  // cleaned up and runs again, and only the live run may drain the queue.
  if (document.readyState === "complete") kick();
  else window.addEventListener("load", kick, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("load", kick);
  };
}

/** True once the section may mount its heavy content (see the rules above). */
export function useSectionGate(ref: RefObject<Element>): boolean {
  const [open, setOpen] = useState(
    () => queue.allOpen || typeof window === "undefined" || typeof IntersectionObserver === "undefined" || window.location.hash.length > 1,
  );
  useEffect(() => {
    if (open) return;
    const el = ref.current;
    let done = false;
    const openIt = () => {
      if (done) return;
      done = true;
      setOpen(true);
    };
    const remove = queue.add(openIt);
    const io = el
      ? new IntersectionObserver((es) => {
          if (es.some((e) => e.isIntersecting)) openIt();
        }, { rootMargin: "100% 0px 100% 0px" })
      : null;
    if (el) io?.observe(el);
    else openIt();
    return () => {
      remove();
      io?.disconnect();
    };
  }, [open, ref]);
  return open;
}
