/**
 * The phone menu's closing rules (App.tsx `Nav`, below 900 px), kept out of
 * React so they are tested as behaviour (nav-menu.test.ts drives them with
 * events on a small fake DOM). While the menu is open:
 *
 *   - Escape closes it and puts focus back on the Menu button;
 *   - a pointer down outside the nav (the scrim included) closes it;
 *   - focus leaving the nav (tabbing out) closes it;
 *   - activating one of its section links closes it and moves focus to that
 *     section's heading, so focus does not fall to <body> when the link it
 *     was on is hidden with the menu (the page still jumps to the section);
 *   - widening past the breakpoint (the links go back inline) closes it.
 */

/* The few DOM members the rules use. A real document, element and
   MediaQueryList satisfy them; the test passes fakes. */
// `any` on purpose: each DOM event type has its own listener signature.
type Handler = (e: any) => void;
export interface Listenable {
  addEventListener(type: string, fn: Handler): void;
  removeEventListener(type: string, fn: Handler): void;
}
export interface MenuDom {
  /** Receives keydown and pointerdown (the document). */
  doc: Listenable;
  /** The nav element: holds the button and the links; receives focusout and click. */
  nav: Listenable & { contains(node: unknown): boolean };
  /** The Menu button, focused again on Escape. */
  toggle: { focus(): void } | null;
  /** The menu breakpoint's media query; `matches` false means the links are inline. */
  mq: (Listenable & { matches: boolean }) | null;
}
export interface MenuActions {
  close(): void;
  /** Move focus to the section a menu link points at (by element id). */
  focusSection(id: string): void;
}

interface LinkLike {
  tagName?: string;
  getAttribute?(name: string): string | null;
  parentNode?: unknown;
}

/** The in-page section id of the link `target` is in (up to `nav`), or null. */
export function sectionLinkId(target: unknown, nav: unknown): string | null {
  for (let n = target as LinkLike | null | undefined; n && n !== nav; n = n.parentNode as LinkLike | null | undefined) {
    if (typeof n.tagName === "string" && n.tagName.toUpperCase() === "A") {
      const href = n.getAttribute?.("href") ?? "";
      return href.startsWith("#") && href.length > 1 ? href.slice(1) : null;
    }
  }
  return null;
}

/** Binds the rules above for as long as the menu is open. Returns the cleanup. */
export function bindOpenMenu(dom: MenuDom, act: MenuActions): () => void {
  const { doc, nav, toggle, mq } = dom;
  const onKey = (e: { key?: string }) => {
    if (e.key !== "Escape") return;
    act.close();
    toggle?.focus();
  };
  const onPointer = (e: { target?: unknown }) => {
    if (!nav.contains(e.target)) act.close();
  };
  const onFocusOut = (e: { relatedTarget?: unknown }) => {
    // relatedTarget is null when focus goes nowhere (a click on a non-focusable
    // spot): the pointer rule decides that case.
    if (e.relatedTarget && !nav.contains(e.relatedTarget)) act.close();
  };
  const onClick = (e: { target?: unknown }) => {
    const id = sectionLinkId(e.target, nav);
    if (id === null) return;
    act.close();
    act.focusSection(id);
  };
  const onMq = () => {
    if (mq && !mq.matches) act.close();
  };
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", onPointer);
  nav.addEventListener("focusout", onFocusOut);
  nav.addEventListener("click", onClick);
  mq?.addEventListener("change", onMq);
  return () => {
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("pointerdown", onPointer);
    nav.removeEventListener("focusout", onFocusOut);
    nav.removeEventListener("click", onClick);
    mq?.removeEventListener("change", onMq);
  };
}

/**
 * Focus a section's heading without scrolling (the link's own jump does
 * that): the first h2 in the section, made focusable by script only
 * (tabindex -1) if it is not already.
 */
export function focusSection(id: string, doc: Pick<Document, "getElementById"> = document): void {
  const section = doc.getElementById(id);
  if (!section) return;
  const heading = section.querySelector<HTMLElement>("h2") ?? section;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}
