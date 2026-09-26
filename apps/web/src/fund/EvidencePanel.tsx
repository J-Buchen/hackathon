import type { FundSnapshot } from "./types";
import { Evidence } from "./Evidence";
import { evidenceBlocksLine } from "./model";

/**
 * The sealed-evidence section's panel (App.tsx, `#evidence`): every loop in
 * the ledger, read from the fund snapshot's `evidence`. Its own lazy chunk; the
 * console and this panel share one fetch of fund-snapshot.json. Keeps the
 * `#fc-evidence` id, so older deep links still land on it.
 */
export default function EvidencePanel({ snapshot }: { snapshot: FundSnapshot }) {
  const { loops, source } = snapshot.evidence;
  return (
    <div className="panel" id="fc-evidence">
      <div className="panel-head">
        <h3>
          Improvement loops, oldest first <span className="fc-vw">virtual worlds</span>
        </h3>
        <p className="panel-sub">
          {evidenceBlocksLine(loops)} Read from <code>{source}</code>.
        </p>
      </div>
      <div className="fc-evidence-body">
        <Evidence loops={loops} />
      </div>
    </div>
  );
}
