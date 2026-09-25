/**
 * Zero-CLS loading placeholder for the live dashboard.
 *
 * It mirrors the real <Dashboard> layout exactly — the 6-tile `.summary` grid
 * and the two-panel `.grid` — reusing the SAME structural class names (`.summary`,
 * `.tile`, `.grid`, `.panel`, `.panel-head`, `.panel-scroll`) so the placeholder
 * occupies the identical box the dashboard will fill. That turns both the initial
 * `loading` state AND the Suspense fallback (while the code-split Dashboard chunk
 * resolves) into a seamless cross-fade instead of a violent layout jump from a
 * ~90px `.notice` to the full summary+two-panel layout (large CLS / visible jank).
 *
 * Pure presentational markup — no data, no state, no motion beyond the CSS
 * shimmer (which is neutralized under prefers-reduced-motion).
 */

// Six summary tiles, matching the real dashboard's SummaryTile count.
const TILES = [0, 1, 2, 3, 4, 5];
// A tree panel reads as a few stacked node cards; the ledger as a few rows.
const TREE_LINES = [0, 1, 2, 3, 4];
const LOG_LINES = [0, 1, 2, 3];

export function DashboardSkeleton() {
  return (
    // aria-busy + a polite status role so assistive tech announces the loading
    // state rather than reading out a pile of empty placeholder boxes.
    <div aria-busy="true" role="status" aria-label="Loading snapshot">
      <section className="summary">
        {TILES.map((i) => (
          <div className="tile skeleton-tile" key={i} />
        ))}
      </section>

      <div className="grid">
        <div className="panel panel-tree">
          <div className="panel-head">
            <div className="skeleton-line skeleton-line-title" />
            <div className="skeleton-line skeleton-line-sub" />
          </div>
          <div className="panel-scroll">
            {TREE_LINES.map((i) => (
              <div className="skeleton-line skeleton-line-card" key={i} />
            ))}
          </div>
        </div>

        <div className="panel panel-events">
          <div className="panel-head">
            <div className="skeleton-line skeleton-line-title" />
            <div className="skeleton-line skeleton-line-sub" />
          </div>
          <div className="panel-scroll">
            {LOG_LINES.map((i) => (
              <div className="skeleton-line skeleton-line-row" key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
