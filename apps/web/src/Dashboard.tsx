import { memo, useMemo, type ReactNode } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import type { Snapshot, EventResult } from "./types";
import { buildTree } from "./tree";
import { formatAmount, formatDate } from "./format";
import { NodeCard } from "./components/NodeCard";
import { EventLog } from "./components/EventLog";
import { ScrollRegion } from "./components/ScrollRegion";

const EASE = [0.16, 1, 0.3, 1] as const;

// Results that count toward the "Blocked / denied" tally. Typed as
// ReadonlySet<EventResult> and hoisted to module scope so (a) it's allocated
// once rather than on every stats recompute, and (b) adding a member here is a
// compile-time decision against the frozen EventResult union.
const BLOCKED_RESULTS: ReadonlySet<EventResult> = new Set<EventResult>([
  "BLOCKED_MANDATE",
  "BLOCKED_SCREENING",
  "DENIED_IDENTITY",
  "ATTENUATION_REJECTED",
]);

/* -------------------------------------------------------------------------- */
/* Reveal-on-scroll wrapper (local copy)                                       */
/*                                                                             */
/* Dashboard is a lazily-loaded chunk, so it carries its own tiny Reveal +     */
/* LazyMotion provider rather than importing them from App (which would drag   */
/* App back into this chunk's dependency graph). domAnimation covers the       */
/* whileInView reveals used below.                                             */
/* -------------------------------------------------------------------------- */
function Reveal({
  children,
  className,
  delay = 0,
  y = 44,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const prefersReduced = useReducedMotion();
  if (prefersReduced) return <div className={className}>{children}</div>;
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-12% 0px -12% 0px" }}
      transition={{ duration: 0.85, delay, ease: EASE }}
    >
      {children}
    </m.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dashboard (a demo run's snapshot)                                           */
/* -------------------------------------------------------------------------- */
function Dashboard({
  snapshot,
  stageLabels,
  panelHeading: PanelHeading = "h2",
  identitySource = "World ID (mock)",
}: {
  snapshot: Snapshot;
  /**
   * Who verified the principal and issued the identity badges. Both demos that
   * render this dashboard use deterministic mocks (MockPrincipalVerifier,
   * MockIdentityGate), so the default says so.
   */
  identitySource?: string;
  /** Per-result stage tags for the event log (the defaults name the main demo's sponsors). */
  stageLabels?: Partial<Record<EventResult, string>>;
  /** Heading level of the two panel titles, so they nest under the section's own heading. */
  panelHeading?: "h2" | "h3" | "h4";
}) {
  const roots = useMemo(() => buildTree(snapshot.nodes), [snapshot.nodes]);

  const stats = useMemo(() => {
    // Single pass over events accumulating all three tallies at once, instead of
    // three separate .filter(...).length walks over the same array.
    const acc = snapshot.events.reduce(
      (a, e) => {
        if (BLOCKED_RESULTS.has(e.result)) a.blocked += 1;
        else if (e.result === "SETTLED") a.settled += 1;
        else if (e.result === "REVOKED") a.revoked += 1;
        return a;
      },
      { blocked: 0, settled: 0, revoked: 0 },
    );
    return { total: snapshot.events.length, ...acc };
  }, [snapshot.events]);

  const root = snapshot.nodes.find((n) => n.parent === null);

  // Build the tile list first so we can map it with a contiguous index — the
  // index drives each tile's staggered CSS entrance (see `--i` below). The root
  // budget tile is conditional, so a static array keeps the delays gap-free.
  const tiles: Array<{
    label: string;
    value: string;
    sub: string;
    tone: "good" | "bad" | "warn" | "neutral";
  }> = [
    {
      label: "Principal",
      value: snapshot.principal.name,
      sub: snapshot.principal.verified ? `${identitySource} ✓` : "unverified",
      tone: snapshot.principal.verified ? "good" : "warn",
    },
    ...(root
      ? [
          {
            label: "Root budget",
            value: `${formatAmount(root.mandate.budget, snapshot.decimals)} ${snapshot.currency}`,
            sub: `${formatAmount(root.mandate.available, snapshot.decimals)} available`,
            tone: "neutral" as const,
          },
        ]
      : []),
    { label: "Agents", value: String(snapshot.nodes.length), sub: "in tree", tone: "neutral" },
    { label: "Settled", value: String(stats.settled), sub: stats.settled === 1 ? "payment" : "payments", tone: "good" },
    {
      label: "Blocked / denied",
      value: String(stats.blocked),
      sub: "policy · screening · identity",
      tone: "bad",
    },
    { label: "As of", value: formatDate(snapshot.asOf), sub: "recorded run · your local time", tone: "neutral" },
  ];

  return (
    <LazyMotion features={domAnimation} strict>
      <Reveal>
        <section className="summary">
          {tiles.map((t, i) => (
            <SummaryTile
              key={t.label}
              index={i}
              label={t.label}
              value={t.value}
              sub={t.sub}
              tone={t.tone}
            />
          ))}
        </section>
      </Reveal>

      <div className="grid">
        <Reveal className="panel panel-tree" delay={0.05}>
          <div className="panel-head">
            <PanelHeading>Delegation tree</PanelHeading>
            <p className="panel-sub">
              Budget <strong>attenuates</strong> down the chain — each child's available
              balance is a slice of its parent's. Revoked subtrees are dashed and greyed out. Identity
              badges are issued by {identitySource}.
            </p>
          </div>
          {/* A keyboard-operable scroll region (WCAG 2.1.1) with an accessible
              name and a "more below" hint. The inner container is the ARIA
              tree; NodeCards are its treeitems. */}
          <ScrollRegion label="Delegation tree">
            {/* A snapshot with zero nodes (malformed/partial file that still
                passes shape validation, or a future minimal demo) would render a
                blank tree container. Show a real empty state instead. */}
            {roots.length === 0 ? (
              <div className="panel-empty" role="status">
                <span className="panel-empty-icon" aria-hidden="true">◇</span>
                <p className="panel-empty-text">No agents in this snapshot</p>
              </div>
            ) : (
              <div role="tree" aria-label="Delegation tree">
                {roots.map((r) => (
                  <NodeCard
                    key={r.node.name}
                    tree={r}
                    currency={snapshot.currency}
                    decimals={snapshot.decimals}
                    identitySource={identitySource}
                  />
                ))}
              </div>
            )}
          </ScrollRegion>
        </Reveal>

        <Reveal className="panel panel-events" delay={0.12}>
          <div className="panel-head">
            <PanelHeading>Event log</PanelHeading>
            <p className="panel-sub">
              Every fund, delegation, payment, and revocation — with the exact reason each
              blocked payment was stopped.
            </p>
          </div>
          {/* Same keyboard-operable scroll region treatment as the tree panel. */}
          <ScrollRegion label="Event log">
            <EventLog
              events={snapshot.events}
              currency={snapshot.currency}
              decimals={snapshot.decimals}
              stageLabels={stageLabels}
            />
          </ScrollRegion>
        </Reveal>
      </div>
    </LazyMotion>
  );
}

/* Pure, prop-driven tile — memoized so parent Reveal re-renders don't churn it. */
const SummaryTile = memo(function SummaryTile({
  label,
  value,
  sub,
  tone,
  index,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "good" | "bad" | "warn" | "neutral";
  index: number;
}) {
  // `--i` feeds the `.tile` `tile-in` keyframe's `animation-delay` in styles.css,
  // producing an index-staggered entrance (neutralized under reduced motion).
  return (
    <div className={`tile tile-${tone}`} style={{ ["--i" as any]: index }}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
});

export default Dashboard;
