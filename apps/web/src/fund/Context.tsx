import type { ShowcaseContext } from "./model";
import { pct, pp } from "./model";
import { GLOSSARY_ID } from "../site";

/**
 * The showcase world in context: its head-to-head next to the latest sealed
 * confirmation (the mean over that loop's block-B virtual worlds), so the
 * console's best-foot-forward numbers are never read alone. Says plainly where
 * the center book still loses (mean max drawdown). When no loop has recorded
 * its block-B books yet, the card stays and says there is no sealed average to
 * read this world against (DESIGN.md §11.1).
 */

const CENTER = "#b8841f";
const BASELINE = "#4f88d6";

/**
 * One cell: the center book's value over the guardrails'. Each swatch stays on
 * the line of its own number. `perRisk` adds, after both raw numbers, the
 * center book's drawdown at the guardrails' volatility (never in place of its
 * raw one), naming its owner on screen, with the evidence chart's gold hollow
 * diamond.
 */
function Pair({ center, guardrails, flag, perRisk }: { center: string; guardrails: string; flag?: string; perRisk?: string }) {
  return (
    <>
      <span className="fx-v">
        <span className="fx-num">
          <span className="chart-key" style={{ background: CENTER }} aria-hidden="true" />
          <span className="sr-only">center book </span>
          {center}
        </span>
        {flag && (
          <span className="fx-flag">
            <span aria-hidden="true">▲ </span>
            {flag}
          </span>
        )}
      </span>
      <span className="fx-v fx-v-dim">
        <span className="fx-num">
          <span className="chart-key" style={{ background: BASELINE }} aria-hidden="true" />
          <span className="sr-only">per-agent guardrails </span>
          {guardrails}
        </span>
      </span>
      {perRisk && (
        // Owner in plain sight: after both raw numbers, so it must say whose it is.
        <span className="fx-perrisk">
          <span className="fx-perrisk-key" style={{ borderColor: CENTER }} aria-hidden="true" />
          <span>
            center book at the guardrails' volatility: <span className="fx-perrisk-v">{perRisk}</span>
          </span>
        </span>
      )}
    </>
  );
}

export function SealedContext({ ctx, seed }: { ctx: ShowcaseContext; seed: number }) {
  const s = ctx.sealed;
  const dd = ctx.rows.find((r) => r.metric === "Max drawdown");
  const ce = ctx.rows.find((r) => r.metric === "Certainty equivalent");
  return (
    <section className="fx" id="fc-context" aria-labelledby="fc-context-h">
      <div className="fx-main">
        <div className="fx-head">
          <span className="fx-over">In context · virtual worlds</span>
          <h3 id="fc-context-h" className="fx-title">
            {s ? `Across ${s.worlds} sealed worlds` : "No sealed average yet"}
          </h3>
          {/* Defined once, under the sealed evidence (site.ts GLOSSARY): not again here. */}
          <p className="fx-gloss">
            Certainty equivalent, sealed worlds and block B are defined{" "}
            <a href={`#${GLOSSARY_ID}`}>under Sealed evidence ↓</a>
          </p>
          <div className="fx-legend">
            <span>
              <span className="chart-key" style={{ background: CENTER }} aria-hidden="true" /> center book
            </span>
            <span>
              <span className="chart-key" style={{ background: BASELINE }} aria-hidden="true" /> per-agent guardrails
            </span>
          </div>
        </div>
        <table className="fx-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Metric</span>
              </th>
              <th scope="col">This world #{seed}</th>
              <th scope="col">
                {s ? `${s.worlds} sealed worlds, mean` : "Sealed worlds, mean"}{" "}
                <span className="fx-th-sub">{s ? `loop ${s.loop} · block B` : "none recorded yet"}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ctx.rows.map((r) => (
              <tr key={r.metric}>
                <th scope="row">{r.metric}</th>
                <td>
                  <Pair center={r.world.center} guardrails={r.world.guardrails} />
                </td>
                <td>
                  {r.sealed ? (
                    <Pair
                      center={r.sealed.center}
                      guardrails={r.sealed.guardrails}
                      flag={r.metric === "Max drawdown" && r.sealed.better === "guardrails" ? "higher" : undefined}
                      perRisk={r.metric === "Max drawdown" && s?.volMatched ? pct(s.volMatched.value, 2) : undefined}
                    />
                  ) : (
                    <span className="fx-na">not recorded</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fx-aside">
        {s ? (
          <>
            <p className="fx-text">
              {s.favourable ? (
                <>
                  <strong>This world is kinder to the center book than average.</strong> Its certainty-equivalent edge
                  over per-agent guardrails is {pp(ctx.gapWorld, 1)} here and {pp(s.gap, 1)} across the sealed worlds.
                </>
              ) : (
                <>
                  This world is not kinder to the center book than average: its certainty-equivalent edge over per-agent
                  guardrails is {pp(ctx.gapWorld, 1)} here and {pp(s.gap, 1)} across the sealed worlds.
                </>
              )}
            </p>
            {ce?.sealed && dd?.sealed && (
              <p className="fx-text">
                On the sealed worlds the center book {s.utilityAbove ? "beats" : "trails"} per-agent guardrails on certainty
                equivalent ({ce.sealed.center} vs {ce.sealed.guardrails}),{" "}
                {s.drawdownAbove ? (
                  <strong>
                    {s.utilityAbove ? "but" : "and"} its mean max drawdown is still higher than theirs ({dd.sealed.center} vs{" "}
                    {dd.sealed.guardrails})
                  </strong>
                ) : (
                  <>
                    {s.utilityAbove ? "and" : "but"} its mean max drawdown is lower ({dd.sealed.center} vs{" "}
                    {dd.sealed.guardrails})
                  </>
                )}
                .
              </p>
            )}
            {dd?.sealed && s.volMatched && (
              <p className="fx-text fx-perrisk-text">
                The center book runs {s.volMatched.moreVol ? "more" : "no more"} volatility than the guardrails;{" "}
                {s.volMatched.belowGuardrails ? "per unit of risk its drawdown is lower" : "even per unit of risk its drawdown is not lower"}:{" "}
                {pct(s.volMatched.value, 2)} at their volatility, vs {dd.sealed.guardrails}. The raw {dd.sealed.center} is what it actually
                drew down.
              </p>
            )}
            <p className="fx-src">
              Means over {s.worlds} sealed virtual worlds ({s.seeds}) from <code>docs/loops/loop-{s.loop}.json</code>, with
              that loop's change merged. Nothing here is market data.
            </p>
          </>
        ) : (
          <>
            <p className="fx-text">
              <strong>No loop has recorded its sealed block-B books yet</strong>, so this one world has no average to be read
              against. Treat its numbers as one draw, not as a result.
            </p>
            <p className="fx-src">
              The sealed means appear here once a confirmed loop records them in <code>docs/loops/loop-N.json</code>. Nothing
              here is market data.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
