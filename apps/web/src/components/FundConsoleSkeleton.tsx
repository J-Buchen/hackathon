/**
 * Loading placeholder for the fund console, shaped like the console itself:
 * the world strip, six KPI tiles, the NAV chart, the tree + log pair, the
 * agents table and the evidence panel. Each block reserves the height the real
 * one renders at each breakpoint (styles.css `.fcs-*`, measured against the
 * committed snapshot), so the ready state swaps in without shifting the page
 * below it (DESIGN.md §11.1). Used for the fetch AND the lazy chunk's Suspense.
 */

const TILES = [0, 1, 2, 3, 4, 5];

export function FundConsoleSkeleton() {
  return (
    <div className="fc fcs" aria-busy="true" role="status" aria-label="Loading the fund console">
      <div className="fcs-intro">
        <div className="skeleton-line fcs-strip" />
        <div className="skeleton-line fcs-rule" />
      </div>
      <div className="fc-kpis">
        {TILES.map((i) => (
          <div className="skeleton-tile fcs-tile" key={i} />
        ))}
      </div>
      <div className="panel fcs-panel fcs-chart">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line fcs-fill" />
      </div>
      <div className="fc-grid">
        <div className="panel fcs-panel fcs-tree">
          <div className="skeleton-line skeleton-line-title" />
          <div className="skeleton-line skeleton-line-sub" />
          <div className="skeleton-line fcs-fill" />
        </div>
        <div className="panel fcs-panel fcs-log">
          <div className="skeleton-line skeleton-line-title" />
          <div className="skeleton-line skeleton-line-sub" />
          <div className="skeleton-line fcs-fill" />
        </div>
      </div>
      <div className="panel fcs-panel fcs-agents">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line fcs-fill" />
      </div>
      <div className="panel fcs-panel fcs-evidence">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line fcs-fill" />
      </div>
    </div>
  );
}
