import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A wrapper for a table that may scroll sideways. It is a keyboard stop (a
 * focusable, named region, WCAG 2.1.1) only while its content is wider than
 * it is: a table that fits adds no dead tab stop and no extra landmark. The
 * check comes from a ResizeObserver (its initial callback runs after the
 * browser's own layout, so it forces no synchronous layout at mount,
 * DESIGN.md §11 Performance).
 */
export function TableScroll({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    if (typeof ResizeObserver === "undefined") {
      update();
      return;
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <>
      <div
        ref={ref}
        className={`table-scroll ${className}`.trim()}
        {...(overflows ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
      >
        {children}
      </div>
      {/* A visible cue that there are more columns: the scrollbar alone is
          hidden on most phones. */}
      {overflows && (
        <p className="table-scroll-hint" aria-hidden="true">
          Scroll sideways for more columns →
        </p>
      )}
    </>
  );
}
