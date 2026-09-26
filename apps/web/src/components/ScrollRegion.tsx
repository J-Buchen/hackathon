import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A keyboard-operable scroll region (tabIndex + role + accessible name, WCAG
 * 2.1.1) that shows when there is more to see: while its content runs past
 * the bottom edge, the panel fades out at the bottom and a "More below" tag
 * appears (styles.css `.scroll-wrap`). Both go away at the end, so the hint
 * never lies. Many browsers hide scrollbars until you scroll; this does not
 * depend on them.
 */
export function ScrollRegion({
  label,
  className = "",
  wrapClassName = "",
  describedBy,
  children,
}: {
  label: string;
  className?: string;
  /** Extra class on the outer wrapper (it carries the fade and the tag). */
  wrapClassName?: string;
  /** id of a (visually hidden) usage hint for the region. */
  describedBy?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    el.addEventListener("scroll", update, { passive: true });
    // The first check comes from the ResizeObserver's initial callback, which
    // runs after the browser's own layout: reading the sizes at mount instead
    // forced a synchronous layout of the whole page once per region (~200 ms
    // of a 4× throttled load, DESIGN.md §11 Performance).
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (!ro) update();
    const observe = () => {
      ro?.disconnect();
      ro?.observe(el);
      if (el.firstElementChild) ro?.observe(el.firstElementChild);
    };
    observe();
    // The content can be swapped (a filter that empties a list): re-observe
    // the new child (its initial callback re-checks), so the tag never claims
    // more that is not there.
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (ro) observe();
            else update();
          });
    mo?.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  return (
    <div className={`scroll-wrap${below ? " has-more" : ""}${wrapClassName ? ` ${wrapClassName}` : ""}`}>
      <div
        ref={ref}
        className={`panel-scroll ${className}`.trim()}
        tabIndex={0}
        role="region"
        aria-label={label}
        aria-describedby={describedBy}
      >
        {children}
      </div>
      <span className="scroll-more" aria-hidden="true">
        More below ↓
      </span>
    </div>
  );
}
