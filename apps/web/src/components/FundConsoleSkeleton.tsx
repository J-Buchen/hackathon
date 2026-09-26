/**
 * Loading placeholder for the fund console, shaped like the console itself:
 * the world strip, six KPI tiles and the sealed-average context card, the NAV
 * chart, the tree + log pair, the audit-trail line, the operator record and
 * the agents table. Each block reserves about
 * the height the real one renders (styles.css `.fcs`: per width band, a line
 * in the console's own width fitted to the committed snapshot), so the ready
 * state swaps in with little shift of the page below it (DESIGN.md §11.1 gives
 * the measured error). Used for the fetch AND the lazy chunk's Suspense.
 */

const TILES = [0, 1, 2, 3, 4, 5];

export function FundConsoleSkeleton() {
  return (
    <div className="fc fcs" aria-busy="true" role="status" aria-label="Loading the fund console">
      <div className="fcs-intro">
        <div className="skeleton-line fcs-strip" />
        <div className="skeleton-line fcs-rule" />
      </div>
      <div className="fc-top">
        <div className="fc-kpis">
          {TILES.map((i) => (
            <div className="skeleton-tile fcs-tile" key={i} />
          ))}
        </div>
        <div className="skeleton-tile fcs-tile fcs-context" />
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
      <div className="skeleton-tile fcs-audit" />
      <div className="panel fcs-panel fcs-ops">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line skeleton-line-sub" />
        <div className="skeleton-line fcs-fill" />
      </div>
      <div className="panel fcs-panel fcs-agents">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line fcs-fill" />
      </div>
    </div>
  );
}

/**
 * Loading placeholder for the sealed-evidence panel (its own section, fed by
 * the same fund-snapshot.json): one panel reserving the evidence's height
 * (`--fcs-evidence`, fitted the same way, rejections collapsed).
 */
export function EvidenceSkeleton() {
  return (
    <div className="fc fcs" aria-busy="true" role="status" aria-label="Loading the sealed evidence">
      <div className="panel fcs-panel fcs-evidence">
        <div className="skeleton-line skeleton-line-title" />
        <div className="skeleton-line fcs-fill" />
      </div>
    </div>
  );
}
