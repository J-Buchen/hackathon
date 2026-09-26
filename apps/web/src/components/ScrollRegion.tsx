import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A keyboard-operable scroll region (tabIndex + role + accessible name, WCAG
 * 2.1.1) that shows when there is more to see: while its content runs past
 * the bottom edge, the panel fades out at the bottom and a "More below" tag
 * appears (styles.css `.scroll-wrap`). Both go away at the end, so the hint
 * never lies. Many browsers hide scrollbars until you scroll; this does not
 * depend on them.
 */
export function ScrollRegion({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  return (
    <div className={`scroll-wrap${below ? " has-more" : ""}`}>
      <div ref={ref} className={`panel-scroll ${className}`.trim()} tabIndex={0} role="region" aria-label={label}>
        {children}
      </div>
      <span className="scroll-more" aria-hidden="true">
        More below ↓
      </span>
    </div>
  );
}
