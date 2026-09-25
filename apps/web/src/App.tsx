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
import { parseSwarmSnapshot, type SwarmSnapshot } from "./swarm/types";
import "./styles.css";

// Code-split the live dashboard: it renders only below the fold AND only after
// the async demo-snapshot.json fetch resolves, so its subtree (NodeCard,
// EventLog, buildTree, format helpers) is pulled out of the entry chunk and
// loaded lazily — cutting time-to-interactive on the landing hero.
const Dashboard = lazy(() => import("./Dashboard"));
// The center-book section is its own lazy chunk with its own snapshot, so the
// payment dashboard never waits on it (and vice versa).
const CenterBook = lazy(() => import("./swarm/CenterBook"));

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
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
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
      {/* Keyboard bypass: lets tab/AT users jump straight to the live dashboard
          instead of tabbing through the hero + 5 marketing sections. Visually
          hidden until focused (see .skip-link), then drops into view top-left. */}
      <a href="#main" className="skip-link">Skip to dashboard</a>
      <div className="grain" aria-hidden="true" />
      <ScrollProgress />
      <Nav />
      {/* Everything from the hero through the sponsors marquee is the primary
          document content, exposed as a single <main> landmark. tabIndex={-1}
          makes it a programmatic focus target for the skip link above. Nav
          (<nav>) and SiteFooter (<footer>) stay OUTSIDE as their own landmarks. */}
      <main id="main" tabIndex={-1}>
      <Hero />
      <Problem />
      <Attenuation />
      <EnsWow />
      <Pipeline />

      <section className="section" id="dashboard">
        <div className="container">
          <Reveal className="dash-head">
            <span className="overline">Live snapshot</span>
            <h2 className="h2">
              The whole story, <span className="hl">on-screen</span>.
            </h2>
            <p className="lede">
              Rendered straight from <code>demo-snapshot.json</code> — the exact output of{" "}
              <code>npm run demo</code>. Watch the budget attenuate down the tree, and every
              blocked, denied, and revoked payment in the ledger.
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
            <Suspense fallback={<DashboardSkeleton />}>
              <Dashboard snapshot={state.snapshot} />
            </Suspense>
          )}
        </div>
      </section>

      <CenterBookSection />

      <Sponsors />
      </main>
      <SiteFooter />
    </LazyMotion>
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
          <span className="overline">From one agent to a fund of them</span>
          <h2 className="h2">
            Tiger Cub agents, and the <span className="hl">center book</span> that stops them becoming
            one trade.
          </h2>
          <p className="lede">
            Every agent below is inside its own mandate. Guardrails on single agents are table stakes. What
            no single agent can see is the crowding: several smart PMs landing on the same idea. The center
            book allocates by risk-adjusted, attributable returns, cuts at one drawdown and revokes at a
            second, and cuts pods that crowd into the same trade. Each of those moves is a <code>resize</code>{" "}
            or <code>revoke</code> on the same mandate tree.
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
          <Suspense fallback={<DashboardSkeleton />}>
            <CenterBook snapshot={state.snapshot} />
          </Suspense>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Nav                                                                         */
/* -------------------------------------------------------------------------- */
function Nav() {
  return (
    <nav className="nav">
      <div className="nav-brand">
        <span className="nav-mark">◈</span>
        Allowance
      </div>
      <div className="nav-links">
        <a href="#problem" className="nav-hide-sm">The problem</a>
        <a href="#how" className="nav-hide-sm">How it works</a>
        <a href="#dashboard">Dashboard</a>
        <a href="#center-book">Center book</a>
        <span className="nav-pill">
          <span className="dot" /> live · x402
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
        <Coin progress={scrollYProgress} size={120} top="16%" left="72%" drift={140} />
        <Coin progress={scrollYProgress} size={64} top="60%" left="84%" drift={90} />
        <Coin progress={scrollYProgress} size={38} top="34%" left="60%" drift={220} />
        <Coin progress={scrollYProgress} size={80} top="74%" left="8%" drift={60} />
      </div>

      <m.div
        className="container hero-inner"
        style={prefersReduced ? undefined : { y, opacity }}
      >
        <span className="overline">Attenuating delegation for agent payments</span>
        <h1 className="display">
          Give your AI agents an <span className="hl">allowance</span>, not your wallet.
        </h1>
        <p className="lede">
          Autonomous agents spawn sub-agents that spend money. Allowance hands each one a
          budget that can only ever <em>shrink</em> as it's passed down — identity-gated,
          compliance-screened, settled in any token, and fully audited.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href="#dashboard">See it live ↓</a>
          <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noreferrer">
            View the code
          </a>
        </div>
      </m.div>

      <div className="scroll-hint">scroll ↓</div>
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
          <span className="overline">The unsolved niche</span>
          <h2 className="h2">
            An orchestrator hires a researcher. The researcher hires a scraper. The scraper
            pays an API.
          </h2>
          <p className="lede">
            Money now flows through chains of agents. Today you get two terrible options —
            and nothing in between.
          </p>
        </Reveal>
        <div className="card-2">
          <Reveal delay={0.05}>
            <div className="bad-card">
              <h3>Give every agent your wallet</h3>
              <p>
                One compromised, jailbroken, or hallucinating agent drains everything. No cap,
                no scope, no undo.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="bad-card">
              <h3>Approve every payment by hand</h3>
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
          <h2 className="h2">
            Money only ever flows <span className="hl">down and narrower</span>.
          </h2>
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
                    initial={prefersReduced ? undefined : { scaleX: 0 }}
                    whileInView={prefersReduced ? undefined : { scaleX: s.pct }}
                    viewport={{ once: true, margin: "-15% 0px" }}
                    transition={{ duration: 1, delay: i * 0.12 + 0.1, ease: EASE }}
                    style={{ scaleX: prefersReduced ? s.pct : undefined }}
                  >
                    {s.amt} USDC
                  </m.div>
                </div>
                <div className="atten-amt">{s.amt}</div>
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
    <section className="section section-alt">
      <div className="container wow">
        <Reveal>
          <div>
            <span className="overline">The wow</span>
            <h2 className="h2">
              ENSv2's name hierarchy <span className="hl">is</span> the delegation tree.
            </h2>
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
    { n: "03", h: "Screen the payment", tag: "Intercepta · x402", block: true, p: "A live screening call runs before the payment is signed. A flagged counterparty is blocked even when the mandate allows it." },
    { n: "04", h: "Settle in any token", tag: "1inch Aqua", block: false, p: "Pay in USDC, the merchant receives their token — swapped through Aqua/SwapVM as part of settlement." },
    { n: "05", h: "Enforce on-chain", tag: "Uniswap v4 hook", block: false, p: "A v4 hook mirrors the same cap on-chain: a swap that exceeds the node's remaining allowance reverts." },
  ];
  return (
    <section className="section">
      <div className="container">
        <Reveal>
          <span className="overline">The payment pipeline</span>
          <h2 className="h2">
            Five gates before a single cent <span className="hl">moves</span>.
          </h2>
        </Reveal>
        <div className="pipeline">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.06}>
              <div className="pstep">
                <div className="pnum">{s.n}</div>
                <div className="pbody">
                  <h3>{s.h}</h3>
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
            Attenuating delegation for autonomous agent payments — built at ETHGlobal.
          </div>
        </div>
        <div className="footer-note">
          ENS · World ID · Intercepta · 1inch Aqua · Uniswap v4 · Curvegrid · Sui
        </div>
      </div>
    </footer>
  );
}
