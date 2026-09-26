/**
 * The phone menu's closing rules (nav-menu.ts), driven as behaviour: events
 * dispatched on a small fake DOM (Node's EventTarget, bubbling from the target
 * up through its ancestors), then assertions on what closed and where focus
 * went. A last check is a lint, not a behaviour test: that App.tsx's Nav
 * binds these rules while the menu is open.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindOpenMenu, focusSection, sectionLinkId } from "./nav-menu";

let focused: FakeNode | null = null;

class FakeNode extends EventTarget {
  parentNode: FakeNode | null = null;
  constructor(
    readonly tagName: string,
    private readonly attrs: Record<string, string> = {},
  ) {
    super();
  }
  append(...kids: FakeNode[]): this {
    for (const k of kids) k.parentNode = this;
    return this;
  }
  contains(n: unknown): boolean {
    for (let x = n as FakeNode | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  focus(): void {
    focused = this;
  }
}

class FakeMediaQuery extends EventTarget {
  constructor(public matches: boolean) {
    super();
  }
}

/** Dispatch like the DOM: at the target, then up through each ancestor. */
function fire(target: FakeNode, type: string, init: Record<string, unknown> = {}): void {
  for (let n: FakeNode | null = target; n; n = n.parentNode) {
    const ev = new Event(type);
    Object.defineProperty(ev, "target", { value: target });
    for (const [k, v] of Object.entries(init)) Object.defineProperty(ev, k, { value: v });
    n.dispatchEvent(ev);
  }
}

function page() {
  const doc = new FakeNode("#document");
  const nav = new FakeNode("NAV");
  const toggle = new FakeNode("BUTTON");
  const label = new FakeNode("SPAN");
  const link = new FakeNode("A", { href: "#integrations" }).append(label);
  const bare = new FakeNode("A", { href: "#" });
  const list = new FakeNode("UL").append(new FakeNode("LI").append(link), new FakeNode("LI").append(bare));
  nav.append(toggle, list);
  const text = new FakeNode("P");
  const scrim = new FakeNode("DIV");
  doc.append(nav, scrim, new FakeNode("MAIN").append(text));
  const mq = new FakeMediaQuery(true);
  const log = { closed: 0, sections: [] as string[] };
  const unbind = bindOpenMenu(
    { doc, nav, toggle, mq },
    {
      close: () => log.closed++,
      focusSection: (id) => {
        log.sections.push(id);
      },
    },
  );
  focused = null;
  return { doc, nav, toggle, label, link, bare, text, scrim, mq, log, unbind };
}

test("Escape closes the open menu and puts focus back on the Menu button; other keys do not", () => {
  const p = page();
  fire(p.link, "keydown", { key: "Tab" });
  fire(p.link, "keydown", { key: "Enter" });
  assert.equal(p.log.closed, 0);
  fire(p.link, "keydown", { key: "Escape" });
  assert.equal(p.log.closed, 1);
  assert.equal(focused, p.toggle);
  p.unbind();
});

test("a pointer down outside the nav (the scrim or the page) closes it; inside does not", () => {
  const p = page();
  fire(p.label, "pointerdown");
  fire(p.toggle, "pointerdown");
  assert.equal(p.log.closed, 0);
  fire(p.scrim, "pointerdown");
  assert.equal(p.log.closed, 1);
  fire(p.text, "pointerdown");
  assert.equal(p.log.closed, 2);
  p.unbind();
});

test("tabbing out of the nav closes it; moving focus inside it does not", () => {
  const p = page();
  fire(p.toggle, "focusout", { relatedTarget: p.link });
  fire(p.link, "focusout", { relatedTarget: null });
  assert.equal(p.log.closed, 0);
  fire(p.link, "focusout", { relatedTarget: p.text });
  assert.equal(p.log.closed, 1);
  p.unbind();
});

test("a section link closes the menu and moves focus to that section, not to <body>", () => {
  const p = page();
  // A click on the link's inner text still counts as the link.
  fire(p.label, "click");
  assert.equal(p.log.closed, 1);
  assert.deepEqual(p.log.sections, ["integrations"]);
  // The Menu button and a bare "#" link are not section links.
  fire(p.toggle, "click");
  fire(p.bare, "click");
  assert.equal(p.log.closed, 1);
  assert.deepEqual(p.log.sections, ["integrations"]);
  assert.equal(sectionLinkId(p.label, p.nav), "integrations");
  assert.equal(sectionLinkId(p.toggle, p.nav), null);
  p.unbind();
});

test("widening past the breakpoint closes it; staying narrow does not", () => {
  const p = page();
  p.mq.dispatchEvent(new Event("change"));
  assert.equal(p.log.closed, 0);
  p.mq.matches = false;
  p.mq.dispatchEvent(new Event("change"));
  assert.equal(p.log.closed, 1);
  p.unbind();
});

test("once the menu is closed (unbound), none of the rules fire", () => {
  const p = page();
  p.unbind();
  fire(p.link, "keydown", { key: "Escape" });
  fire(p.text, "pointerdown");
  fire(p.link, "focusout", { relatedTarget: p.text });
  fire(p.label, "click");
  p.mq.matches = false;
  p.mq.dispatchEvent(new Event("change"));
  assert.equal(p.log.closed, 0);
  assert.deepEqual(p.log.sections, []);
  assert.equal(focused, null);
});

test("focusSection focuses the section's heading without scrolling, making it focusable by script only", () => {
  const calls: Array<{ el: string; opts: unknown }> = [];
  const heading = (attrs: Record<string, string>) => {
    const a = { ...attrs };
    return {
      hasAttribute: (k: string) => k in a,
      setAttribute: (k: string, v: string) => {
        a[k] = v;
      },
      focus: (opts: unknown) => calls.push({ el: "h2", opts }),
      attrs: a,
    };
  };
  const plain = heading({});
  const ready = heading({ tabindex: "0" });
  const sections: Record<string, unknown> = {
    plain: { querySelector: () => plain },
    ready: { querySelector: () => ready },
  };
  const doc = { getElementById: (id: string) => (sections[id] as HTMLElement | undefined) ?? null };
  focusSection("plain", doc);
  assert.equal(plain.attrs.tabindex, "-1");
  assert.deepEqual(calls.at(-1), { el: "h2", opts: { preventScroll: true } });
  focusSection("ready", doc);
  assert.equal(ready.attrs.tabindex, "0", "an existing tabindex is left alone");
  assert.equal(calls.length, 2);
  focusSection("missing", doc);
  assert.equal(calls.length, 2);
});

test("lint: App.tsx's Nav binds these rules while the menu is open, with a scrim and the disclosure attributes", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /bindOpenMenu\(/);
  assert.match(app, /focusSection/);
  assert.match(app, /aria-expanded=\{open\}/);
  assert.match(app, /aria-controls="nav-menu"/);
  assert.match(app, /id="nav-menu"/);
  assert.match(app, /className="nav-scrim"/);
  assert.match(app, /aria-current=\{active === s\.id \? "location" : undefined\}/);
});
