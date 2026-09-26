import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import {
  LazyMotion,
  domAnimation,
  m,
  useScroll,
  useTransform,
  useReducedMotion,
  type MotionValue,
} from "framer-motion";
import Lenis from "lenis";
import type { Snapshot } from "./types";
import { parseSnapshot } from "./snapshot";
import { DashboardSkeleton } from "./components/DashboardSkeleton";
import { FundConsoleSkeleton } from "./components/FundConsoleSkeleton";
import { SectionBoundary } from "./components/SectionBoundary";
import { parseSwarmSnapshot, type SwarmSnapshot } from "./swarm/types";
import { parseAgentHireSummary, type AgentHireSummary } from "./agenthire";
import { parseFundSnapshot, type FundSnapshot } from "./fund/types";
import { isConsoleAlias, parseConsoleHash } from "./fund/hash";
import "./styles.css";

// Code-split the payment dashboard: it renders only below the fold AND only after
// the async demo-snapshot.json fetch resolves, so its subtree (NodeCard,
// EventLog, buildTree, format helpers) is pulled out of the entry chunk and
// loaded lazily — cutting time-to-interactive on the landing hero.
const Dashboard = lazy(() => import("./Dashboard"));
// The center-book section is its own lazy chunk with its own snapshot, so the
// payment dashboard never waits on it (and vice versa).
const CenterBook = lazy(() => import("./swarm/CenterBook"));
// The fund console (the product demo) is its own lazy chunk and snapshot too.
const FundConsole = lazy(() => import("./fund/FundConsole"));

const REPO_URL = "https://github.com/J-Buchen/hackathon";
const EASE = [0.16, 1, 0.3, 1] as const;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

/* -------------------------------------------------------------------------- */
/* Smooth inertia scrolling (the "senthos" feel)                              */
/* -------------------------------------------------------------------------- */
function useSmoothScroll() {
  const prefersReduced = useReducedMotion();
  useEffect(() => {
    if (prefersReduced) return;
    // allowNestedScroll: a wheel over a scrollable panel (the decision log,
    // wide tables) scrolls that panel until it reaches its end, instead of
    // Lenis taking the event and moving the page.
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true, allowNestedScroll: true });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [prefersReduced]);
}

/* -------------------------------------------------------------------------- */
/* In-page and deep links                                                      */
/* -------------------------------------------------------------------------- */
/*
 * The page renders after the browser's own fragment scroll, and the console's
 * panels exist only once its data loads, so a deep link (/#fc-evidence) would
 * otherwise stay at the top. Three pieces:
 *   1. On load, jump to the hash target, and again each time the page's height
 *      changes (a section above it finished loading) until the reader scrolls,
 *      clicks or types, or 5 s pass.
 *   2. Console aliases (#fc-log-rebalance, #fc-tree-grant …) have no element of
 *      their own: scroll to the panel they name. FundConsole sets the log
 *      filter or the replay from the same hash.
 *   3. A click on a link to the CURRENT hash fires no hashchange; replay it so
 *      the console re-applies its state.
 * The sticky nav is cleared by `scroll-padding-top` on html (styles.css).
 */
function useHashNavigation() {
  useEffect(() => {
    const targetOf = (hash: string) => {
      const h = parseConsoleHash(hash);
      return h ? document.getElementById(h.id) : null;
    };
    const smooth = (): ScrollBehavior =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

    let settling = window.location.hash.length > 1;
    // Re-jump when the page's height changes (a section above the target
    // loaded) or when new elements appear (the target itself was rendered: the
    // console's skeleton reserves its height, so its arrival resizes nothing).
    const ro = new ResizeObserver(() => jump());
    const mo = new MutationObserver(() => jump());
    const jump = () => {
      if (settling) targetOf(window.location.hash)?.scrollIntoView({ behavior: "instant", block: "start" });
    };
    const stopSettling = () => {
      settling = false;
      ro.disconnect();
      mo.disconnect();
    };
    let raf = 0;
    if (settling) {
      ro.observe(document.body);
      mo.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
      raf = requestAnimationFrame(jump);
    }
    const timer = window.setTimeout(stopSettling, 5000);
    const passive = { passive: true } as const;
    window.addEventListener("wheel", stopSettling, passive);
    window.addEventListener("touchstart", stopSettling, passive);
    window.addEventListener("pointerdown", stopSettling, passive);
    window.addEventListener("keydown", stopSettling);

    const onHashChange = () => {
      stopSettling();
      if (isConsoleAlias(window.location.hash)) targetOf(window.location.hash)?.scrollIntoView({ behavior: smooth(), block: "start" });
    };
    window.addEventListener("hashchange", onHashChange);

    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href^='#']") : null;
      const href = a?.getAttribute("href");
      if (href && href.length > 1 && href === window.location.hash) {
        window.setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 0);
      }
    };
    document.addEventListener("click", onClick);

    return () => {
      stopSettling();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener("wheel", stopSettling);
      window.removeEventListener("touchstart", stopSettling);
      window.removeEventListener("pointerdown", stopSettling);
      window.removeEventListener("keydown", stopSettling);
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick);
    };
  }, []);
}

/* -------------------------------------------------------------------------- */
/* Reveal-on-scroll wrapper                                                    */
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

function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  return <m.div className="scroll-progress" style={{ scaleX: scrollYProgress }} />;
}

/* -------------------------------------------------------------------------- */
/* App shell                                                                   */
/* -------------------------------------------------------------------------- */
export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useSmoothScroll();
  useHashNavigation();

  useEffect(() => {
    let cancelled = false;
    // Bare URL (no ?t=cache-buster) so the browser HTTP cache can serve it; a
    // normal reload still revalidates, and `npm run demo` regenerates the file.
    fetch("/demo-snapshot.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading demo-snapshot.json`);
        return r.json() as Promise<unknown>;
      })
      // Validate the untrusted JSON against the frozen Snapshot schema at the
      // boundary. A malformed/stale file throws a precise path-tagged error here
      // (surfaced by the {status:'error'} branch) instead of crashing later in
      // buildTree/formatAmount.
      .then((raw: unknown) => parseSnapshot(raw))
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
    // strict LazyMotion: features load lazily via domAnimation, and `strict`
    // throws if any full `motion.*` component sneaks back onto the critical path.
    <LazyMotion features={domAnimation} strict>
      {/* Keyboard bypass: lets tab/AT users jump past the nav straight into the
          page content. Visually hidden until focused (see .skip-link), then
          drops into view top-left. */}
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="grain" aria-hidden="true" />
      <ScrollProgress />
      <Nav />
      {/* Everything from the hero through the sponsors marquee is the primary
          document content, exposed as a single <main> landmark. tabIndex={-1}
          makes it a programmatic focus target for the skip link above. Nav
          (<nav>) and SiteFooter (<footer>) stay OUTSIDE as their own landmarks. */}
      <main id="main" tabIndex={-1}>
      <Hero />
      <Guarantees />
      <FundConsoleSection />

      <CenterBookSection />

      <AgentHireSection />

      <UnderTheHood />
      <Problem />
      <Attenuation />
      <EnsWow />
      <Pipeline />

      <section className="section" id="dashboard">
        <div className="container">
          <Reveal className="dash-head">
            <span className="overline">The primitive at work · agent payments · deterministic mocks</span>
            <h3 className="h2 h2-sub">
              The same tree, <span className="hl">spending money</span>.
            </h3>
            <p className="lede">
              Rendered from <code>demo-snapshot.json</code>, the output of <code>npm run demo</code>: a
              scripted, reproducible run with no real money or chain. The delegation tree, its attenuation,
              the mandate checks and revocation are Allowance code. The identity (World ID) and screening
              (Intercepta) verdicts, and settlement (1inch Aqua), come from deterministic mocks.
            </p>
          </Reveal>

          {/* Both the initial fetch (`loading`) and the code-split chunk resolve
              (Suspense fallback) render the same skeleton, which mirrors the real
              dashboard's box — so there's no CLS jump when either resolves. */}
          {state.status === "loading" && <DashboardSkeleton />}
          {state.status === "error" && (
            <div className="notice notice-error">
              Could not load <code>/demo-snapshot.json</code>: {state.message}
              <div className="notice-hint">
                Run <code>npm run demo</code> at the repo root to generate it, then reload.
              </div>
            </div>
          )}
          {state.status === "ready" && (
            <SectionBoundary what="the payment dashboard" hint={<>Reload the page. If it keeps failing, run <code>npm run demo</code> at the repo root to regenerate its data.</>}>
              <Suspense fallback={<DashboardSkeleton />}>
                <Dashboard snapshot={state.snapshot} panelHeading="h4" stageLabels={PAYMENT_STAGES} />
              </Suspense>
            </SectionBoundary>
          )}
        </div>
      </section>

      <Sponsors />
      </main>
      <SiteFooter />
    </LazyMotion>
  );
}

// The payment demo (npm run demo) runs every adapter as a deterministic mock,
// so the stage tags say which sponsor each stage stands in for, and that it is
// a mock.
const PAYMENT_STAGES = {
  BLOCKED_SCREENING: "Intercepta (mock)",
  DENIED_IDENTITY: "World ID (mock)",
  SETTLED: "1inch Aqua (mock)",
} as const;

/* -------------------------------------------------------------------------- */
/* Fund console — the product, on one virtual world (npm run demo:fund)        */
/* -------------------------------------------------------------------------- */
type FundLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; snapshot: FundSnapshot };

function FundConsoleSection() {
  const [state, setState] = useState<FundLoad>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/fund-snapshot.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading fund-snapshot.json`);
        return r.json() as Promise<unknown>;
      })
      .then((raw) => parseFundSnapshot(raw))
      .then((snapshot) => {
        if (cancelled) return;
        // A parseable file with no agents or no NAV has nothing to show: say so
        // instead of rendering empty panels (DESIGN.md §11.1).
        if (snapshot.agents.length === 0 || snapshot.books.center.nav.length === 0) setState({ status: "empty" });
        else setState({ status: "ready", snapshot });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section section-console" id="fund-console">
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">Fund console · virtual world</span>
          <h2 className="h2">
            AI PMs, one allocator, <span className="hl">one mandate tree</span>.
          </h2>
          <p className="lede">
            A simulated year in one virtual world: AI agents from different operators trade virtual stocks while a crowd
            piles into one name and unwinds. The same roster runs twice on the same prices, once under the allocator (the center
            book) and once with per-agent guardrails only. Every number below is simulated.
          </p>
        </Reveal>
        {state.status === "loading" && <FundConsoleSkeleton />}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/fund-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Run <code>npm run demo:fund</code> at the repo root to generate it, then reload.
            </div>
          </div>
        )}
        {state.status === "empty" && (
          <div className="notice">
            The fund snapshot has no agents or no NAV to show.
            <div className="notice-hint">
              Run <code>npm run demo:fund</code> at the repo root to regenerate it, then reload.
            </div>
          </div>
        )}
        {state.status === "ready" && (
          <SectionBoundary what="the fund console" hint={<>Reload the page. If it keeps failing, run <code>npm run demo:fund</code> at the repo root to regenerate <code>fund-snapshot.json</code>.</>}>
            <Suspense fallback={<FundConsoleSkeleton />}>
              <FundConsole snapshot={state.snapshot} />
            </Suspense>
          </SectionBoundary>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Center book — the swarm allocator (packages/swarm)                          */
/* -------------------------------------------------------------------------- */
type SwarmLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: SwarmSnapshot };

function CenterBookSection() {
  const [state, setState] = useState<SwarmLoad>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/swarm-snapshot.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading swarm-snapshot.json`);
        return r.json() as Promise<unknown>;
      })
      .then((raw) => parseSwarmSnapshot(raw))
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section section-alt" id="center-book">
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">A worked example · one trend, three Tiger Cubs · simulated prices</span>
          <h2 className="h2">
            Three Tiger-Cub PMs, <span className="hl">one crowded trade</span>.
          </h2>
          <p className="lede">
            The console shows the allocator across a whole virtual fund; this is one mechanism up close. Three
            Tiger-Cub-style PMs in three pods research the same trend, weigh it differently and converge on the same
            long, each inside its own limits. Together they are one crowded trade, and only the center book, which looks
            across them, catches it: every cut is a <code>resize</code> and every stop-out a <code>close</code> on the
            same mandate tree.
          </p>
        </Reveal>
        {state.status === "loading" && <DashboardSkeleton />}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/swarm-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Run <code>npm run demo:swarm</code> at the repo root to generate it, then reload.
            </div>
          </div>
        )}
        {state.status === "ready" && (
          <SectionBoundary what="the center book" hint={<>Reload the page. If it keeps failing, run <code>npm run demo:swarm</code> at the repo root to regenerate its data.</>}>
            <Suspense fallback={<DashboardSkeleton />}>
              <CenterBook snapshot={state.snapshot} />
            </Suspense>
          </SectionBoundary>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* AgentHire — a local, keyless marketplace run (npm run demo:agenthire)       */
/* -------------------------------------------------------------------------- */
// This tree settles through AgentHire (keyless, so simulated), not 1inch Aqua,
// and a BLOCKED_MANDATE here can also be the settlement guard refusing a challenge.
// Screening blocks on Allowance's own operator-incident record as well as on
// AgentHire's (simulated) reputation, so the label names both.
const AGENTHIRE_STAGES = {
  SETTLED: "AgentHire · simulated",
  BLOCKED_MANDATE: "mandate · settlement guard",
  BLOCKED_SCREENING: "screening · operator incidents / AgentHire reputation",
  DENIED_IDENTITY: "World ID (mock)",
} as const;

type AgentHireLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot; summary: AgentHireSummary | null };

function AgentHireSection() {
  const [state, setState] = useState<AgentHireLoad>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const getJson = (path: string) =>
      fetch(path).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading ${path.slice(1)}`);
        return r.json() as Promise<unknown>;
      });
    Promise.all([
      getJson("/agenthire-snapshot.json").then(parseSnapshot),
      // The sidecar only adds the headline and notes; the tree renders without it.
      getJson("/agenthire-receipts.json").then(parseAgentHireSummary).catch(() => null),
    ])
      .then(([snapshot, summary]) => {
        if (!cancelled) setState({ status: "ready", snapshot, summary });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section" id="agenthire">
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">A real agent marketplace, run locally · settlement simulated</span>
          <h2 className="h2">
            A fund's PM hires a scraper on AgentHire. One <span className="hl">close</span> takes it all back.
          </h2>
          <p className="lede">
            Rendered from <code>agenthire-snapshot.json</code>, written by{" "}
            <code>npm run demo:agenthire</code> against an unmodified, keyless AgentHire on this machine.
            The scraper is hired at AgentHire's own quote. The overspend attempts, scripted by the demo
            on the scraper's behalf, are blocked and recorded as an incident on Allowance's side, which
            is not a slash; operators are bound through a World ID <em>mock</em>. On a synthetic arena
            return path (not market data), the drawdown ladder stops the PM out, and closing the PM's
            mandate kills the data budget in the same step. AgentHire's settlement and agent-to-agent
            routes are simulated in keyless mode, and its escrow is off-chain, so nothing here claims
            escrow protection.
          </p>
          {state.status === "ready" && state.summary && (
            <div className="notice" style={{ marginTop: 28, textAlign: "left" }}>
              <strong>Shadow audit (simulated marketplace):</strong> {state.summary.auditHeadline}
              {state.summary.incidents.map((i) => (
                <div key={i} className="notice-hint">
                  Incident: {i}
                </div>
              ))}
              {state.summary.honesty.length > 0 && (
                <ul className="notice-hint" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
                  {state.summary.honesty.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Reveal>
        {state.status === "loading" && <DashboardSkeleton />}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/agenthire-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Boot AgentHire with <code>bash scripts/agenthire-up.sh</code> (127.0.0.1:5301), run{" "}
              <code>npm run demo:agenthire</code>, then reload.
            </div>
          </div>
        )}
        {state.status === "ready" && (
          <SectionBoundary what="the AgentHire run" hint={<>Reload the page. If it keeps failing, run <code>npm run demo:agenthire</code> at the repo root to regenerate its data.</>}>
            <Suspense fallback={<DashboardSkeleton />}>
              <Dashboard snapshot={state.snapshot} stageLabels={AGENTHIRE_STAGES} />
            </Suspense>
          </SectionBoundary>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Nav                                                                        */
/* -------------------------------------------------------------------------- */
function Nav() {
  return (
    <nav className="nav">
      <div className="nav-brand">
        <span className="nav-mark">◈</span>
        Allowance
      </div>
      <div className="nav-links">
        <a href="#guarantees" className="nav-hide-sm">Guarantees</a>
        <a href="#fund-console">Fund console</a>
        <a href="#fc-evidence" className="nav-hide-sm nav-hide-md">Evidence</a>
        <a href="#agenthire" className="nav-hide-sm">AgentHire</a>
        <a href="#under-the-hood" className="nav-hide-sm nav-hide-md">Under the hood</a>
        <span className="nav-pill" title="Virtual-world demo: every fund number on this page is simulated">
          <span className="dot" aria-hidden="true" /> <span className="nav-pill-long">virtual-world demo</span>
          {/* Visually hidden below 360px (the dot stays), still read aloud. */}
          <span className="nav-pill-short">virtual world</span>
        </span>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero — parallax + drifting coins                                            */
/* -------------------------------------------------------------------------- */
function Coin({
  progress,
  size,
  top,
  left,
  drift,
}: {
  progress: MotionValue<number>;
  size: number;
  top: string;
  left: string;
  drift: number;
}) {
  const prefersReduced = useReducedMotion();
  const y = useTransform(progress, [0, 1], [0, drift]);
  return (
    <m.div
      className="coin"
      style={{ width: size, height: size, top, left, y: prefersReduced ? 0 : y }}
    />
  );
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  const prefersReduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [0, 170]);
  const opacity = useTransform(scrollYProgress, [0, 0.85], [1, 0]);
  const glowY = useTransform(scrollYProgress, [0, 1], [0, -140]);

  return (
    <section className="hero" ref={ref}>
      <m.div className="hero-glow" style={{ y: prefersReduced ? 0 : glowY }} />
      <div className="hero-coins" aria-hidden="true">
        <Coin progress={scrollYProgress} size={84} top="9%" left="86%" drift={140} />
        <Coin progress={scrollYProgress} size={44} top="82%" left="91%" drift={90} />
        <Coin progress={scrollYProgress} size={56} top="86%" left="3%" drift={60} />
      </div>

      <m.div
        className="container hero-inner"
        style={prefersReduced ? undefined : { y, opacity }}
      >
        <div className="hero-copy">
          <span className="overline">The allocation and risk layer for capital run by AI agents</span>
          <h1 className="display display-product">
            A multi-manager fund where the <span className="hl">PMs are AI agents</span>.
          </h1>
          <p className="lede">
            Each agent trades inside a mandate that can only shrink, and carries a track record
            bound to its human operator (World ID in production; simulated here). The allocator moves capital to the best
            risk-adjusted agents, spots when "independent" agents are one trade, and cuts them.
            A stop-out closes the agent's whole subtree in one operation.
          </p>
          <div className="btn-row">
            <a className="btn btn-primary" href="#fund-console">Open the fund console ↓</a>
            <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noreferrer">
              View the code
            </a>
          </div>
        </div>
        <HeroVisual />
      </m.div>

      <div className="scroll-hint">scroll ↓</div>
    </section>
  );
}

/* A static, number-free sketch of the product: the mandate tree on Day 34 of
   the console's virtual world, when one group cut hit picker-0 and desk-0
   (overlapping books; they also share an operator) and herd-1 had already been
   stopped out (Day 30). Names, pods, operators and states match the console;
   the bars are illustrative. */
function HeroVisual() {
  const rows: Array<{ pod?: string; agent?: string; op?: string; w?: number; tone?: "hl" | "closed" }> = [
    { pod: "alpha" },
    { agent: "picker-0", op: "op-8", w: 0.72, tone: "hl" },
    { agent: "trend-2", op: "op-2", w: 0.5 },
    { pod: "beta" },
    { agent: "desk-0", op: "op-8", w: 0.62, tone: "hl" },
    { agent: "herd-1", op: "op-6", w: 0, tone: "closed" },
  ];
  return (
    <figure className="hero-card" aria-label="Illustration: a fund's mandate tree with a group cut and a stopped-out agent">
      <div className="hc-head">
        <span className="hc-root">
          <span className="hc-kind">Fund</span> fund.eth
        </span>
        <span className="hc-tag">illustration</span>
      </div>
      <ul className="hc-rows">
        {rows.map((r, i) =>
          r.pod ? (
            <li key={i} className="hc-pod">
              <span className="hc-kind">Pod</span> {r.pod}
            </li>
          ) : (
            <li key={i} className={`hc-agent${r.tone ? ` is-${r.tone}` : ""}`}>
              <span className="hc-name">{r.agent}</span>
              <span className="hc-op">{r.op}</span>
              <span className="hc-bar" aria-hidden="true">
                <span className="hc-fill" style={{ transform: `scaleX(${r.w ?? 0})` }} />
              </span>
              <span className="hc-state">{r.tone === "closed" ? "⦸ stopped" : "● active"}</span>
            </li>
          ),
        )}
      </ul>
      <figcaption className="hc-notes">
        <span className="hc-note">
          <span className="hero-proof-k">G</span>
          <span>
            picker-0 and desk-0 held overlapping positions, one trade under two names, so the allocator cut them
            together. They also share op-8.
          </span>
        </span>
        <span className="hc-note">
          <span className="hero-proof-k hero-proof-stop" aria-hidden="true">⦸</span>
          <span>
            herd-1 hit its loss limit: one close shut its mandate (and anything it delegated), and the unspent capital
            returned to its pod. A stop-out, not a penalty.
          </span>
        </span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* The four guarantees (R / A / G / C)                                         */
/* -------------------------------------------------------------------------- */
function Guarantees() {
  const items = [
    {
      k: "R",
      h: "Reserved at grant",
      p: "Every agent's capital is set aside from the fund the moment it is granted, so no agent can ever trade money that was promised to another.",
      op: "delegate",
      how: "A child's budget is carved from its parent's available balance; a grant the parent cannot back is rejected before the agent exists. Every order is then sized from the agent's available authority in the tree and checked against it before it trades.",
      see: "#fc-tree-grant",
      seeLabel: "See the reservations at grant",
    },
    {
      k: "A",
      h: "Resized by risk-adjusted record",
      p: "Capital follows each agent's own attributable, risk-adjusted track record, and a drawdown is judged against the risk that agent actually runs.",
      op: "resize",
      how: "Every rebalance and every drawdown cut is one resize of the agent's mandate: it grows only from the parent's available balance and never shrinks below what is committed.",
      see: "#fc-log-rebalance",
      seeLabel: "See the rebalances",
    },
    {
      k: "G",
      h: "One trade, one cut",
      p: "When \"independent\" agents are really the same bet, the allocator treats them as one position and cuts them together, whatever names they trade under.",
      op: "group resize",
      how: "The crowding scan groups agents whose books overlap and scales every contributor by one factor in one pass. An operator is also one counterparty: when one of its agents is stopped out, its other agents are capped together in one plan until each recovers on its own record (never revoked, never shielded from their own stop).",
      see: "#fc-log-group",
      seeLabel: "See the group cuts",
    },
    {
      k: "C",
      h: "A stop-out closes the subtree",
      p: "A stop-out is a loss limit, not a punishment: one operation shuts the agent's mandate and everything it delegated, and hands the unspent capital back up the tree.",
      op: "close",
      how: "DelegationTree.close shrinks every descendant to what it spent (deepest first), revokes the node, and returns the freed amount to the parent. The center book stops every agent out this way (since loop 2), and the AgentHire run closes an active subtree that was still paying for work.",
      see: "#agenthire",
      seeLabel: "See a close on an active subtree",
    },
  ];
  return (
    <section className="section section-alt" id="guarantees">
      <div className="container">
        <Reveal>
          <span className="overline">The four guarantees</span>
          <h2 className="h2">
            Guardrails on one agent are table stakes. <span className="hl">These hold across all of them.</span>
          </h2>
          <p className="lede">
            An allocator's promises are only as good as what enforces them. The allocator decides; each decision below lands
            as a single operation on one mandate tree, so it holds whether the agent behaves or not.
          </p>
        </Reveal>
        <div className="guarantees">
          {items.map((g, i) => (
            <Reveal key={g.k} delay={i * 0.06}>
              <article className="guarantee">
                <div className="guarantee-top">
                  <span className="guarantee-k" aria-hidden="true">{g.k}</span>
                  <h3>
                    <span className="sr-only">({g.k}) </span>
                    {g.h}
                  </h3>
                </div>
                <p className="guarantee-p">{g.p}</p>
                <div className="guarantee-how">
                  <span className="guarantee-how-label">Mechanism</span>
                  <code>{g.op}</code>
                  <p>{g.how}</p>
                </div>
                <a className="guarantee-see" href={g.see}>
                  {g.seeLabel} →
                </a>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Under the hood — the mandate primitive                                      */
/* -------------------------------------------------------------------------- */
/* A chapter divider: everything after it (up to the sponsors) is one chapter
   about the primitive, so those sections use h3 headings a step lighter. */
const UNDER_THE_HOOD = [
  { href: "#problem", label: "Why a tree" },
  { href: "#how", label: "Attenuation" },
  { href: "#ens", label: "ENS names are the tree" },
  { href: "#pipeline", label: "The payment pipeline" },
  { href: "#dashboard", label: "The primitive at work" },
];

function UnderTheHood() {
  return (
    <section className="section under-hood" id="under-the-hood" aria-labelledby="under-the-hood-h">
      <div className="container">
        <Reveal className="uth">
          <div className="uth-copy">
            <span className="overline">Under the hood · the mandate primitive</span>
            <h2 className="h2 uth-h" id="under-the-hood-h">
              One data structure <span className="hl">carries out all four</span>.
            </h2>
            <p className="uth-lede">
              The allocator decides; an attenuating delegation tree carries each decision out. A mandate's budget and
              scope can only narrow as it is passed down, any node can be revoked, and every write is audited. It started
              as spend control for agents that pay each other, and those payments run on the same tree.
            </p>
          </div>
          <nav className="uth-index" aria-label="In this chapter">
            <ol>
              {UNDER_THE_HOOD.map((s, i) => (
                <li key={s.href}>
                  <a href={s.href}>
                    <span className="uth-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                    {s.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Problem                                                                     */
/* -------------------------------------------------------------------------- */
function Problem() {
  return (
    <section className="section section-alt" id="problem">
      <div className="container">
        <Reveal>
          <span className="overline">Why a tree · agents that pay agents</span>
          <h3 className="h2 h2-sub">
            An orchestrator hires a researcher. The researcher hires a scraper. The scraper
            pays an API.
          </h3>
          <p className="lede">
            Money now flows through chains of agents. Today you get two terrible options —
            and nothing in between.
          </p>
        </Reveal>
        <div className="card-2">
          <Reveal delay={0.05}>
            <div className="bad-card">
              <h4>Give every agent your wallet</h4>
              <p>
                One compromised, jailbroken, or hallucinating agent drains everything. No cap,
                no scope, no undo.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="bad-card">
              <h4>Approve every payment by hand</h4>
              <p>
                Safe, but it defeats the entire point of autonomy. You become the bottleneck
                for your own agents.
              </p>
            </div>
          </Reveal>
        </div>
        <Reveal delay={0.18}>
          <p className="lede" style={{ marginTop: 40 }}>
            Nobody has a clean primitive for <strong className="hl">authority that
            attenuates down a chain</strong>: each hop narrows its parent's budget and scope,
            is revocable, and is auditable end-to-end. Allowance is that primitive.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Attenuation viz — bars shrink 100 → 30 → 10 as you scroll in               */
/* -------------------------------------------------------------------------- */
function Attenuation() {
  const prefersReduced = useReducedMotion();
  const steps = [
    { name: "alice.eth", lbl: "alice", amt: "100", pct: 1.0, scope: "any merchant · any purpose" },
    { name: "researcher.alice.eth", lbl: "researcher", amt: "30", pct: 0.3, scope: "arxiv · openai · sanctioned-vendor" },
    { name: "scraper.researcher.alice.eth", lbl: "scraper", amt: "10", pct: 0.1, scope: "arxiv (a strict subset)" },
  ];
  return (
    <section className="section" id="how">
      <div className="container">
        <Reveal>
          <span className="overline">How it works · attenuation</span>
          <h3 className="h2 h2-sub">
            Money only ever flows <span className="hl">down and narrower</span>.
          </h3>
          <p className="lede">
            A child's budget is always a slice of its parent's <em>remaining</em> balance —
            and its allowlist can only be a subset. Try to broaden it and the delegation is
            rejected before the child is ever created.
          </p>
        </Reveal>

        <div className="atten">
          {steps.map((s, i) => (
            <Reveal key={s.name} delay={i * 0.12}>
              <div className="atten-row">
                <div className="atten-name">
                  <span className="lbl">{s.lbl}</span>
                  <span className="atten-scope">{s.scope}</span>
                </div>
                <div className="atten-track">
                  <m.div
                    className="atten-fill"
                    aria-hidden="true"
                    initial={prefersReduced ? undefined : { scaleX: 0 }}
                    whileInView={prefersReduced ? undefined : { scaleX: s.pct }}
                    viewport={{ once: true, margin: "-15% 0px" }}
                    transition={{ duration: 1, delay: i * 0.12 + 0.1, ease: EASE }}
                    style={{ scaleX: prefersReduced ? s.pct : undefined }}
                  />
                  {/* Not inside the scaled fill (it would be squashed with it):
                      its own element at the fill's end, faded in once the bar
                      has grown. */}
                  <m.span
                    className={`atten-label ${s.pct >= 0.5 ? "is-in" : "is-out"}`}
                    style={{ left: `${s.pct * 100}%` }}
                    initial={prefersReduced ? undefined : { opacity: 0 }}
                    whileInView={prefersReduced ? undefined : { opacity: 1 }}
                    viewport={{ once: true, margin: "-15% 0px" }}
                    transition={{ duration: 0.4, delay: i * 0.12 + 0.8, ease: EASE }}
                  >
                    {s.amt} USDC
                  </m.span>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.2}>
          <p className="atten-note">
            <strong>100 → 30 → 10 USDC.</strong> {" "}
            <strong>{"{any} → {3 shops} → {1 shop}."}</strong> Revoke any node and its entire
            subtree stops instantly.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* ENS wow                                                                     */
/* -------------------------------------------------------------------------- */
function EnsWow() {
  return (
    <section className="section section-alt" id="ens">
      <div className="container wow">
        <Reveal>
          <div>
            <span className="overline">The wow</span>
            <h3 className="h2 h2-sub">
              ENSv2's name hierarchy <span className="hl">is</span> the delegation tree.
            </h3>
            <p className="lede">
              A name already encodes who-is-boss-of-whom. We store each agent's mandate —
              budget, scope, expiry — as resolver records on its subname. The naming tree and
              the authority tree are the same tree.
            </p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div>
            <div className="wow-name">
              <span className="wow-seg wow-seg-0">scraper</span>
              <span className="wow-dot">.</span>
              <span className="wow-seg wow-seg-1">researcher</span>
              <span className="wow-dot">.</span>
              <span className="wow-seg wow-seg-2">alice</span>
              <span className="wow-dot">.</span>
              <span className="wow-seg wow-seg-2">eth</span>
            </div>
            <p className="wow-caption">
              left-most label = the node itself · each dot = one hop up the chain of command
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Pipeline — numbered process, senthos-style                                  */
/* -------------------------------------------------------------------------- */
function Pipeline() {
  const steps = [
    { n: "01", h: "Verify identity", tag: "World ID", block: false, p: "Every node — and every ancestor — must present a valid agent credential. Expired or rogue agents are denied before anything moves." },
    { n: "02", h: "Check the mandate", tag: "Attenuation", block: true, p: "Not revoked, not expired, within the node's available balance, merchant and purpose on the allowlist. Over-budget spends stop here." },
    { n: "03", h: "Screen the payment", tag: "Intercepta · x402", block: true, p: "A screening call runs before the payment is signed. A flagged counterparty is blocked even when the mandate allows it." },
    { n: "04", h: "Settle in any token", tag: "1inch Aqua", block: false, p: "Pay in USDC, the merchant receives their token — swapped through Aqua/SwapVM as part of settlement." },
    { n: "05", h: "Enforce on-chain", tag: "Uniswap v4 hook", block: false, p: "A v4 hook mirrors the same cap on-chain: a swap that exceeds the node's remaining allowance reverts." },
  ];
  return (
    <section className="section" id="pipeline">
      <div className="container">
        <Reveal>
          <span className="overline">The payment pipeline</span>
          <h3 className="h2 h2-sub">
            Five gates before a single cent <span className="hl">moves</span>.
          </h3>
        </Reveal>
        <div className="pipeline">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.06}>
              <div className="pstep">
                <div className="pnum">{s.n}</div>
                <div className="pbody">
                  <h4>{s.h}</h4>
                  <p>{s.p}</p>
                </div>
                <span className={`ptag ${s.block ? "ptag-block" : ""}`}>{s.tag}</span>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Sponsors marquee                                                            */
/* -------------------------------------------------------------------------- */
function Sponsors() {
  const items = [
    ["ENS", "$6k"],
    ["World ID", "$10k"],
    ["Intercepta", "$2k"],
    ["1inch Aqua", "$5k"],
    ["Uniswap v4", "$6k"],
    ["Curvegrid", "$3k"],
    ["Sui", "$5k"],
  ];
  const track = (
    <div className="marquee-track" aria-hidden="true">
      {items.map(([name, amt], i) => (
        <span className="sponsor" key={`${name}-${i}`}>
          {name} <span className="amt">{amt}</span>
          <span className="sep">·</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="sponsors">
      <div className="marquee">
        {track}
        {track}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                       */
/* -------------------------------------------------------------------------- */
function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <div className="footer-brand">◈ Allowance</div>
          <div className="footer-tag">
            The allocation and risk layer for capital run by AI agents, built on attenuating
            delegation. Built at ETHGlobal. Fund results shown are from simulated virtual worlds.
          </div>
        </div>
        <div className="footer-note">
          ENS · World ID · Intercepta · 1inch Aqua · Uniswap v4 · Curvegrid · Sui
        </div>
      </div>
    </footer>
  );
}
