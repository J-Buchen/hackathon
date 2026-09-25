import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "./types";
import { buildTree } from "./tree";
import { formatAmount, formatDate } from "./format";
import { NodeCard } from "./components/NodeCard";
import { EventLog } from "./components/EventLog";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Pure static read of the snapshot from public/. No backend calls.
    // Cache-bust so a fresh orchestrator run shows up on reload.
    fetch(`/demo-snapshot.json?t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading demo-snapshot.json`);
        return r.json() as Promise<Snapshot>;
      })
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <Header />
      <main className="content">
        {state.status === "loading" && (
          <div className="notice">Loading snapshot…</div>
        )}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/demo-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Run <code>npm run demo</code> at the repo root to generate it, then reload.
            </div>
          </div>
        )}
        {state.status === "ready" && <Dashboard snapshot={state.snapshot} />}
      </main>
      <footer className="footer">
        Allowance — attenuating-delegation for autonomous agent payments · ENS ·
        World ID · Intercepta · 1inch Aqua · Uniswap v4
      </footer>
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <span className="brand-name">Allowance</span>
      </div>
      <div className="tagline">Give your AI agents an allowance, not your wallet.</div>
      <p className="eli5">
        Agents spawn sub-agents that spend money. <strong>Allowance</strong> gives
        each one a budget that can only shrink as it's handed down — like a parent
        giving a kid lunch money, who gives a friend a slice of that. Every hop can
        only <em>narrow</em> the budget and scope, is revocable, and is fully
        audited. The ENS name tree <em>is</em> the chain of command.
      </p>
    </header>
  );
}

function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const roots = useMemo(() => buildTree(snapshot.nodes), [snapshot.nodes]);

  const stats = useMemo(() => {
    const blocked = snapshot.events.filter((e) =>
      ["BLOCKED_MANDATE", "BLOCKED_SCREENING", "DENIED_IDENTITY", "ATTENUATION_REJECTED"].includes(
        e.result,
      ),
    ).length;
    const settled = snapshot.events.filter((e) => e.result === "SETTLED").length;
    const revoked = snapshot.events.filter((e) => e.result === "REVOKED").length;
    return { total: snapshot.events.length, blocked, settled, revoked };
  }, [snapshot.events]);

  const root = snapshot.nodes.find((n) => n.parent === null);

  return (
    <>
      <section className="summary">
        <SummaryTile
          label="Principal"
          value={snapshot.principal.name}
          sub={snapshot.principal.verified ? "IDKit verified ✓" : "unverified"}
          tone={snapshot.principal.verified ? "good" : "warn"}
        />
        {root && (
          <SummaryTile
            label="Root budget"
            value={`${formatAmount(root.mandate.budget, snapshot.decimals)} ${snapshot.currency}`}
            sub={`${formatAmount(root.mandate.available, snapshot.decimals)} available`}
            tone="neutral"
          />
        )}
        <SummaryTile label="Agents" value={String(snapshot.nodes.length)} sub="in tree" tone="neutral" />
        <SummaryTile label="Settled" value={String(stats.settled)} sub="payments" tone="good" />
        <SummaryTile
          label="Blocked / denied"
          value={String(stats.blocked)}
          sub="by policy + screening + identity"
          tone="bad"
        />
        <SummaryTile label="As of" value={formatDate(snapshot.asOf)} sub={`${snapshot.currency}`} tone="neutral" />
      </section>

      <div className="grid">
        <section className="panel panel-tree">
          <div className="panel-head">
            <h2>Delegation tree</h2>
            <p className="panel-sub">
              Budget <strong>attenuates</strong> down the chain — each child's
              available balance is a slice of its parent's. Revoked subtrees are
              dimmed.
            </p>
          </div>
          <div className="panel-scroll">
            {roots.map((r) => (
              <NodeCard
                key={r.node.name}
                tree={r}
                currency={snapshot.currency}
                decimals={snapshot.decimals}
              />
            ))}
          </div>
        </section>

        <section className="panel panel-events">
          <div className="panel-head">
            <h2>Event log</h2>
            <p className="panel-sub">
              Every fund, delegation, payment, and revocation — with the exact
              reason each blocked payment was stopped.
            </p>
          </div>
          <div className="panel-scroll">
            <EventLog
              events={snapshot.events}
              currency={snapshot.currency}
              decimals={snapshot.decimals}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "good" | "bad" | "warn" | "neutral";
}) {
  return (
    <div className={`tile tile-${tone}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}
