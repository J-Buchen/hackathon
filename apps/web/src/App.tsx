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
import { EvidenceSkeleton, FundConsoleSkeleton } from "./components/FundConsoleSkeleton";
import { SectionBoundary } from "./components/SectionBoundary";
import { parseSwarmSnapshot, type SwarmSnapshot } from "./swarm/types";
import { parseAgentHireSummary, type AgentHireSummary } from "./agenthire";
import { parseFundSnapshot, type FundSnapshot } from "./fund/types";
import { parseConsoleHash } from "./fund/hash";
import {
  EVIDENCE_LEDE,
  GLOSSARY,
  GLOSSARY_ID,
  INTEGRATIONS,
  LEDGER_FILE,
  NAV_SECTIONS,
  REPO_TREE,
  repoFile,
  type Integration,
} from "./site";
import { bindOpenMenu, focusSection } from "./nav-menu";
import { startSectionGates, useSectionGate } from "./section-gate";
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
// The sealed evidence reads the same snapshot as the console but is its own
// section, so it is its own (small) chunk.
const EvidencePanel = lazy(() => import("./fund/EvidencePanel"));

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
 * otherwise stay at the top. Four pieces:
 *   1. On load, jump to the hash target, and again each time the page's height
 *      changes (a section above it finished loading) until the reader scrolls,
 *      clicks or types, or 5 s pass.
 *   2. In-page jumps (the nav, "See the …" links) settle the same way for a
 *      moment: sections are `content-visibility: auto`, so the ones a first
 *      jump passes over are laid out at a placeholder height and grow once
 *      they render next to the target, which would push it off screen (a phone
 *      jumping from the console to Integrations landed inside the worked
 *      example). Only real height changes re-jump, so a smooth scroll is left
 *      alone unless the page moved under it.
 *   3. Every hashchange also scrolls to its target itself: console aliases
 *      (#fc-log-rebalance, #fc-tree-grant …) have no element of their own
 *      (FundConsole sets the log filter or the replay from the same hash),
 *      and a native fragment scroll that starts while another smooth scroll
 *      is running can be dropped.
 *   4. A click on a link to the CURRENT hash fires no hashchange; replay it so
 *      the console re-applies its state.
 * Any hold ends on the reader's next wheel, touch, pointer or key input, and
 * also on any scroll that carries the target AWAY from where a jump puts it
 * with no jump in between: a scrollbar drag, find-in-page, assistive tech or a
 * script's scrollTo. A smooth scroll toward the target only brings it closer,
 * and a change of page height re-jumps (as the ResizeObserver would) before
 * the direction is judged, so neither ends the hold.
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

    // Where a jump puts the target's top: just below the sticky nav.
    const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    // How far the target sits from that spot (null while it does not exist).
    const offset = () => {
      const t = targetOf(window.location.hash);
      return t ? Math.abs(t.getBoundingClientRect().top - pad) : null;
    };

    let settling = window.location.hash.length > 1;
    let height = -1;
    // The closest the target has come to its spot since the last jump.
    let closest = Infinity;
    // Re-jump when the page's height changes (a section above the target
    // loaded or rendered) or, on load, when new elements appear (the target
    // itself was rendered: the console's skeleton reserves its height, so its
    // arrival resizes nothing).
    const ro = new ResizeObserver(() => {
      const h = document.body.scrollHeight;
      if (h === height) return;
      height = h;
      jump();
    });
    const mo = new MutationObserver(() => jump());
    const jump = () => {
      if (!settling) return;
      const t = targetOf(window.location.hash);
      if (!t) return;
      t.scrollIntoView({ behavior: "instant", block: "start" });
      closest = offset() ?? Infinity;
    };
    const stopSettling = () => {
      settling = false;
      ro.disconnect();
      mo.disconnect();
    };
    // A scroll that moves the target away from its spot, with no change of
    // page height to explain it, is the reader's: it ends the hold (see
    // above). Outside a hold it returns at once.
    const onScroll = () => {
      if (!settling) return;
      const d = offset();
      if (d === null) return;
      const h = document.body.scrollHeight;
      if (height >= 0 && h !== height) {
        height = h;
        jump();
        return;
      }
      if (d > closest + 8) stopSettling();
      else closest = Math.min(closest, d);
    };
    let raf = 0;
    let timer = 0;
    if (settling) {
      ro.observe(document.body);
      mo.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
      raf = requestAnimationFrame(jump);
      timer = window.setTimeout(stopSettling, 5000);
    }
    const passive = { passive: true } as const;
    window.addEventListener("scroll", onScroll, passive);
    window.addEventListener("wheel", stopSettling, passive);
    window.addEventListener("touchstart", stopSettling, passive);
    window.addEventListener("pointerdown", stopSettling, passive);
    window.addEventListener("keydown", stopSettling);

    const onHashChange = () => {
      stopSettling();
      // Scroll to the target here as well as natively: an alias has no element
      // of its own, and a fragment scroll that starts while another smooth
      // scroll is still running can be dropped (Chrome, motion on: the page
      // stayed where it was). Toward the same spot, this only restarts it.
      targetOf(window.location.hash)?.scrollIntoView({ behavior: smooth(), block: "start" });
      // (2) Hold the target in place while the sections it passed over render.
      // The pointer or key that followed the link already fired, so only the
      // reader's next input (or 2 s) ends it.
      settling = true;
      height = document.body.scrollHeight;
      closest = offset() ?? Infinity;
      ro.observe(document.body);
      window.clearTimeout(timer);
      timer = window.setTimeout(stopSettling, 2000);
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
      window.removeEventListener("scroll", onScroll);
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
/* Fund snapshot: one fetch, two sections (the console and the evidence)       */
/* -------------------------------------------------------------------------- */
type FundLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** Parses, but has no agents or no NAV: the console says so; the evidence still renders. */
  | { status: "empty"; snapshot: FundSnapshot }
  | { status: "ready"; snapshot: FundSnapshot };

function useFundSnapshot(): FundLoad {
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
        // A parseable file with no agents or no NAV has nothing to show in the
        // console: say so instead of rendering empty panels (DESIGN.md §11.1).
        if (snapshot.agents.length === 0 || snapshot.books.center.nav.length === 0) setState({ status: "empty", snapshot });
        else setState({ status: "ready", snapshot });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/* -------------------------------------------------------------------------- */
/* App shell                                                                   */
/* -------------------------------------------------------------------------- */
export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const fund = useFundSnapshot();
  useSmoothScroll();
  useHashNavigation();
  useEffect(() => startSectionGates(), []);
  const dashRef = useRef<HTMLElement>(null);
  const dashOpen = useSectionGate(dashRef);

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
      {/* Everything from the hero to the payment dashboard is the primary
          document content, exposed as a single <main> landmark. tabIndex={-1}
          makes it a programmatic focus target for the skip link above. Nav
          (<nav>) and SiteFooter (<footer>) stay OUTSIDE as their own landmarks.
          Section order: hero → guarantees → fund console → sealed evidence →
          worked example → integrations → under the hood. Each top-level
          section carries `data-nav`, the nav entry it lights up. */}
      <main id="main" tabIndex={-1}>
      <Hero />
      <Guarantees />
      <FundConsoleSection state={fund} />
      <EvidenceSection state={fund} />

      <CenterBookSection />

      <IntegrationsSection />

      <UnderTheHood />
      <Problem />
      <Attenuation />
      <EnsWow />
      <Pipeline />

      <section className="section" id="dashboard" data-nav="under-the-hood" ref={dashRef}>
        <div className="container">
          <Reveal className="dash-head">
            <span className="overline">The primitive at work · agent payments · deterministic mocks</span>
            <h3 className="h2 h2-sub">
              The same tree, <span className="hl">spending money</span>.
            </h3>
            <p className="lede">
              A scripted, reproducible run of <code>npm run demo</code>, rendered from <code>demo-snapshot.json</code>, with no
              real money and no chain. The tree, its attenuation, the mandate checks and revocation are Allowance code; the
              World ID, Intercepta and 1inch Aqua verdicts come from deterministic mocks.
            </p>
          </Reveal>

          {/* Both the initial fetch (`loading`) and the code-split chunk resolve
              (Suspense fallback) render the same skeleton, which mirrors the real
              dashboard's box — so there's no CLS jump when either resolves. */}
          {(state.status === "loading" || (state.status === "ready" && !dashOpen)) && <DashboardSkeleton />}
          {state.status === "error" && (
            <div className="notice notice-error">
              Could not load <code>/demo-snapshot.json</code>: {state.message}
              <div className="notice-hint">
                Run <code>npm run demo</code> at the repo root to generate it, then reload.
              </div>
            </div>
          )}
          {state.status === "ready" && dashOpen && (
            <SectionBoundary what="the payment dashboard" hint={<>Reload the page. If it keeps failing, run <code>npm run demo</code> at the repo root to regenerate its data.</>}>
              <Suspense fallback={<DashboardSkeleton />}>
                <Dashboard snapshot={state.snapshot} panelHeading="h4" stageLabels={PAYMENT_STAGES} />
              </Suspense>
            </SectionBoundary>
          )}
        </div>
      </section>
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
function FundConsoleSection({ state }: { state: FundLoad }) {
  const ref = useRef<HTMLElement>(null);
  const open = useSectionGate(ref);
  return (
    <section className="section section-console" id="fund-console" data-nav="fund-console" ref={ref}>
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">Fund console · virtual world</span>
          <h2 tabIndex={-1} className="h2">
            AI PMs, one allocator, <span className="hl">one mandate tree</span>.
          </h2>
          <p className="lede">
            The allocation and risk layer at work for one simulated year: AI agents from different operators trade virtual
            stocks while a crowd piles into one name and unwinds. The same roster runs twice on the same simulated prices,
            once under the allocator (the center book) and once with per-agent guardrails only.
          </p>
        </Reveal>
        {(state.status === "loading" || (state.status === "ready" && !open)) && <FundConsoleSkeleton />}
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
        {state.status === "ready" && open && (
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
/* Sealed evidence — every improvement loop (docs/loops/loop-*.json)           */
/* -------------------------------------------------------------------------- */
// The intro and the terms are data (site.ts): the intro is tested against the
// ledger's rule, and the terms are defined here only (the console's context
// card links to them).
function EvidenceSection({ state }: { state: FundLoad }) {
  const ref = useRef<HTMLElement>(null);
  const open = useSectionGate(ref);
  return (
    <section className="section section-alt section-evidence" id="evidence" data-nav="evidence" aria-labelledby="evidence-h" ref={ref}>
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">Sealed evidence · virtual worlds</span>
          <h2 tabIndex={-1} className="h2" id="evidence-h">
            Every change, judged on <span className="hl">sealed worlds</span>.
          </h2>
          <p className="lede">{EVIDENCE_LEDE}</p>
          <dl className="gloss" id={GLOSSARY_ID} aria-label="Terms used on this page">
            {GLOSSARY.map((g) => (
              <div key={g.term} className="gloss-item">
                <dt>{g.term}</dt>
                <dd>{g.def}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        {(state.status === "loading" || (state.status !== "error" && !open)) && <EvidenceSkeleton />}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/fund-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Run <code>npm run demo:fund</code> at the repo root to generate it, then reload.
            </div>
          </div>
        )}
        {(state.status === "ready" || state.status === "empty") && open && (
          <SectionBoundary what="the sealed evidence" hint={<>Reload the page. If it keeps failing, run <code>npm run demo:fund</code> at the repo root to regenerate <code>fund-snapshot.json</code>.</>}>
            <Suspense fallback={<EvidenceSkeleton />}>
              <EvidencePanel snapshot={state.snapshot} />
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
  const ref = useRef<HTMLElement>(null);
  const open = useSectionGate(ref);
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
    <section className="section" id="center-book" data-nav="center-book" ref={ref}>
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">A worked example · one trend, three Tiger Cubs · simulated prices</span>
          <h2 tabIndex={-1} className="h2">
            Three Tiger-Cub PMs, <span className="hl">one crowded trade</span>.
          </h2>
          <p className="lede">
            The allocator's crowding check up close, on simulated prices: three Tiger-Cub-style PMs in three pods research
            the same coffee trend, each inside its own limits, and all land on the same long. Only the center book, which
            looks across them, sees one crowded trade and cuts it with a <code>resize</code> on the mandate tree; a stop-out
            is one <code>close</code>.
          </p>
        </Reveal>
        {(state.status === "loading" || (state.status === "ready" && !open)) && <DashboardSkeleton />}
        {state.status === "error" && (
          <div className="notice notice-error">
            Could not load <code>/swarm-snapshot.json</code>: {state.message}
            <div className="notice-hint">
              Run <code>npm run demo:swarm</code> at the repo root to generate it, then reload.
            </div>
          </div>
        )}
        {state.status === "ready" && open && (
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
/* Integrations — one card per integration, with its status as the code has it */
/* -------------------------------------------------------------------------- */
const STATUS_GLYPH: Record<Integration["tone"], string> = { local: "●", mock: "○", undeployed: "□" };

function IntegrationCard({ it }: { it: Integration }) {
  return (
    <article className="integ">
      {/* Name, role and chip each on their own line, so every card's header is
          the same height and the chips of a row line up. */}
      <div className="integ-top">
        <h3 className="integ-name">{it.name}</h3>
        <p className="integ-role">{it.role}</p>
        <span className={`integ-status is-${it.tone}`}>
          <span aria-hidden="true">{STATUS_GLYPH[it.tone]} </span>
          <span className="sr-only">Status: </span>
          {it.status}
        </span>
      </div>
      <p className="integ-what">{it.what}</p>
      <p className="integ-used">
        <span className="integ-used-k">Runs in</span> {it.usedIn}
      </p>
      <div className="integ-links">
        <a href={repoFile(it.file)} target="_blank" rel="noreferrer">
          <code>{it.file}</code>
          <span className="sr-only"> (opens GitHub)</span> ↗
        </a>
        {it.see && <a href={it.see.href}>{it.see.label} ↓</a>}
      </div>
    </article>
  );
}

function IntegrationsSection() {
  return (
    <section className="section section-alt" id="integrations" data-nav="integrations" aria-labelledby="integrations-h">
      <div className="container">
        <Reveal className="dash-head">
          <span className="overline">Integrations · status as the code has it</span>
          <h2 tabIndex={-1} className="h2" id="integrations-h">
            What plugs into the tree, <span className="hl">and how real it is</span>.
          </h2>
          <p className="lede">
            What each integration adds to the allocation and risk layer, which demo on this page runs it, and how real it is
            today. The fund console runs none of their code: its operators and names are simulated, and nothing here is
            deployed or moves real funds.
          </p>
        </Reveal>
        <div className="integ-grid">
          {INTEGRATIONS.map((it, i) => (
            <Reveal key={it.name} delay={(i % 3) * 0.05} className="integ-cell">
              <IntegrationCard it={it} />
            </Reveal>
          ))}
        </div>
        <p className="integ-foot">
          Read from the code and <code>docs/SPONSORS.md</code>. Each real service has a client stub that refuses to run until
          it is configured. The repo also carries an offline Curvegrid mock (MultiBaas-style view models, whose summary{" "}
          <code>npm run demo</code> prints in the terminal) and a Sui mock that no demo runs; neither appears on this page.
        </p>
        <AgentHirePanel />
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

/** What the AgentHire run is made of: every disclosure the section has carried, one line each. */
const AGENTHIRE_FACTS: Array<{ k: string; v: ReactNode }> = [
  {
    k: "Real",
    v: (
      <>
        The HTTP calls to an unmodified, keyless AgentHire (its quotes and 402 challenges) and every check Allowance makes
        before signing. What you see is recorded from a local run into <code>agenthire-snapshot.json</code>; regenerate it
        with <code>npm run demo:agenthire</code>.
      </>
    ),
  },
  {
    k: "Scripted",
    v: (
      <>
        The overspend attempts, made by the demo on the scraper's behalf. They are blocked and recorded as an incident on
        Allowance's side (AgentHire has no keyless incident route); that is a record, not a slash.
      </>
    ),
  },
  { k: "Mock", v: <>Operators are bound through a World ID mock.</> },
  { k: "Synthetic", v: <>The PM's return path is an arena virtual world, not market data; its drawdown ladder stops the PM out.</> },
  {
    k: "Simulated",
    v: (
      <>
        AgentHire's settlement and agent-to-agent routes in keyless mode. Its escrow is off-chain, so nothing here claims
        escrow protection.
      </>
    ),
  },
];

function AgentHirePanel() {
  const [state, setState] = useState<AgentHireLoad>({ status: "loading" });
  const ref = useRef<HTMLDivElement>(null);
  const open = useSectionGate(ref);
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
    <div className="ah" id="agenthire" ref={ref}>
      <Reveal className="dash-head">
        <span className="overline">AgentHire, up close · run locally · settlement simulated</span>
        <h3 className="h2 h2-sub">
          A fund's PM hires a scraper on AgentHire. One <span className="hl">close</span> takes it all back.
        </h3>
        <p className="lede">
          The PM hires AgentHire's WebCrawler X at AgentHire's own quote, from a data budget carved out of its capital
          mandate. When the PM is stopped out, one close of its mandate returns the capital and kills the unspent data budget
          in the same step.
        </p>
        <dl className="ah-facts" aria-label="What is real and what is simulated in this run">
          {AGENTHIRE_FACTS.map((f) => (
            <div key={f.k} className="ah-fact">
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
        {state.status === "ready" && state.summary && (
          <div className="notice ah-audit">
            <strong>Shadow audit (simulated marketplace):</strong> {state.summary.auditHeadline}
            {state.summary.incidents.map((i) => (
              <div key={i} className="notice-hint">
                Incident: {i}
              </div>
            ))}
            {state.summary.honesty.length > 0 && (
              <ul className="notice-hint ah-honesty">
                {state.summary.honesty.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Reveal>
      {(state.status === "loading" || (state.status === "ready" && !open)) && <DashboardSkeleton />}
      {state.status === "error" && (
        <div className="notice notice-error">
          Could not load <code>/agenthire-snapshot.json</code>: {state.message}
          <div className="notice-hint">
            Boot AgentHire with <code>bash scripts/agenthire-up.sh</code> (127.0.0.1:5301), run{" "}
            <code>npm run demo:agenthire</code>, then reload.
          </div>
        </div>
      )}
      {state.status === "ready" && open && (
        <SectionBoundary what="the AgentHire run" hint={<>Reload the page. If it keeps failing, run <code>npm run demo:agenthire</code> at the repo root to regenerate its data.</>}>
          <Suspense fallback={<DashboardSkeleton />}>
            <Dashboard snapshot={state.snapshot} panelHeading="h4" stageLabels={AGENTHIRE_STAGES} />
          </Suspense>
        </SectionBoundary>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Nav                                                                        */
/* -------------------------------------------------------------------------- */
/**
 * The section in view: the last top-level section (page order) that crosses a
 * thin reading line a little above the middle of the viewport. Sections are
 * marked with `data-nav` (the nav entry they belong to; the hero is "top").
 * An IntersectionObserver only, no scroll handler and no animation, so it is
 * cheap and the same under reduced motion.
 */
function useActiveSection(): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
    if (els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const crossing = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) crossing.add(e.target);
          else crossing.delete(e.target);
        }
        let current: string | null = null;
        for (const el of els) if (crossing.has(el)) current = el.dataset.nav ?? null;
        // Between sections (or over the footer) keep the last one.
        if (current !== null) setActive(current);
      },
      { rootMargin: "-38% 0px -58% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return active;
}

/** Below this width the section links fold into a disclosure menu (styles.css, .nav). */
const NAV_MENU_QUERY = "(max-width: 899px)";

function Nav() {
  const active = useActiveSection();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // While the menu is open: Escape, a tap outside (the scrim), tabbing out, a
  // section link (which also moves focus to that section) and widening past
  // the breakpoint close it. The rules live in nav-menu.ts, tested as behaviour.
  useEffect(() => {
    const nav = navRef.current;
    if (!open || !nav) return;
    return bindOpenMenu(
      { doc: document, nav, toggle: toggleRef.current, mq: window.matchMedia(NAV_MENU_QUERY) },
      {
        close: () => setOpen(false),
        // After the link's own jump: navigating to a fragment whose target is
        // not focusable moves focus to the document, which would undo it.
        focusSection: (id) => window.setTimeout(() => focusSection(id), 0),
      },
    );
  }, [open]);

  return (
    <>
      <nav className={`nav${open ? " is-open" : ""}`} aria-label="Sections" ref={navRef}>
        <a className="nav-brand" href="#top" aria-label="Allowance: back to the top">
          <span className="nav-mark" aria-hidden="true">◈</span>
          Allowance
        </a>
        <span className="nav-pill" title="Virtual-world demo: every fund number on this page is simulated">
          <span className="dot" aria-hidden="true" /> <span className="nav-pill-long">virtual-world demo</span>
          {/* Visually hidden below 360px (the dot stays), still read aloud. */}
          <span className="nav-pill-short">virtual world</span>
        </span>
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="nav-toggle-bars" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Menu
        </button>
        <ul className="nav-links" id="nav-menu">
          {NAV_SECTIONS.map((s, i) => (
            <li key={s.id}>
              <a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined}>
                <span className="nav-n" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="nav-l">
                  <span className="nav-l-long">{s.label}</span>
                  <span className="nav-l-short">{s.short}</span>
                </span>
                <span className="nav-hint">{s.hint}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {/* Dims the page under the open phone menu, so page text does not read as
          more menu; a tap on it closes the menu (outside the nav). */}
      {open && <div className="nav-scrim" aria-hidden="true" />}
    </>
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
    <section className="hero" id="top" data-nav="top" ref={ref}>
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
            Each agent trades inside a mandate that can only shrink and carries a track record bound to a verified human
            operator (World ID; in this demo the console's operators are simulated labels and the AgentHire run uses a mock
            verifier). The allocator moves capital to the best risk-adjusted agents, spots when "independent" agents are one
            trade and cuts them, and a stop-out closes the agent's whole subtree in one operation.
          </p>
          <div className="btn-row">
            <a className="btn btn-primary" href="#fund-console">Open the fund console ↓</a>
            <a className="btn btn-ghost" href={REPO_TREE} target="_blank" rel="noreferrer">
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
      // Two mechanisms, kept apart: the crowding cut (grouped by overlapping
      // positions only) and, since loop 3, the operator cap after a stop-out.
      // Operator-based grouping of the crowding cut is research, never claimed.
      how: "The crowding cut groups agents by overlapping positions only and scales every contributor by one factor in one pass; a cut whose members share an operator is flagged. Separately, since loop 3 a stop-out caps the same operator's other agents together until each recovers on its own record; the console says whether that fired in its world. Grouping an operator's agents into one crowding cut is still being researched.",
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
    <section className="section section-alt" id="guarantees" data-nav="guarantees">
      <div className="container">
        <Reveal>
          <span className="overline">The four guarantees</span>
          <h2 tabIndex={-1} className="h2">
            Guardrails on one agent are table stakes. <span className="hl">These hold across all of them.</span>
          </h2>
          <p className="lede">
            The allocation and risk layer for capital run by AI agents makes four promises. Each one lands as a single
            operation on one mandate tree, so it holds whether the agent behaves or not.
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
        {/* Accountability sits under the four cards, not inside (G) or (C): it cuts nothing and closes nothing. */}
        <Reveal>
          <p className="guarantees-acct">
            <span className="guarantees-acct-k">Accountability</span> Every stop-out also goes on its operator's record, as a
            loss, not misconduct. A new grant made through the record's grant screen (<code>OperatorGrantScreen</code>) is
            refused above two stop-outs; the showcase book makes no grants after the start, so the fund console shows what
            that screen would answer. The mandate tree is also compared with a rebuild from its own event log three times a
            trading day (the log is not signed). <a className="guarantee-see" href="#fc-operators">See the operator record →</a>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Under the hood — the mandate primitive                                      */
/* -------------------------------------------------------------------------- */
/* A chapter divider: everything after it (to the end of <main>) is one chapter
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
    <section className="section under-hood" id="under-the-hood" data-nav="under-the-hood" aria-labelledby="under-the-hood-h">
      <div className="container">
        <Reveal className="uth">
          <div className="uth-copy">
            <span className="overline">Under the hood · the mandate primitive</span>
            <h2 tabIndex={-1} className="h2 uth-h" id="under-the-hood-h">
              One data structure <span className="hl">carries out all four</span>.
            </h2>
            <p className="uth-lede">
              The allocator decides; an attenuating delegation tree carries each decision out: a mandate's budget and scope
              can only narrow as it is passed down, any node can be revoked, and every write is audited. It started as spend
              control for agents that pay each other, and those payments run on the same tree.
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
    <section className="section section-alt" id="problem" data-nav="under-the-hood">
      <div className="container">
        <Reveal>
          <span className="overline">Why a tree · agents that pay agents</span>
          <h3 className="h2 h2-sub">
            An orchestrator hires a researcher. The researcher hires a scraper. The scraper
            pays an API.
          </h3>
          <p className="lede">
            Money now flows through chains of agents, and today there are two bad options with nothing in between.
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
    <section className="section" id="how" data-nav="under-the-hood">
      <div className="container">
        <Reveal>
          <span className="overline">How it works · attenuation</span>
          <h3 className="h2 h2-sub">
            Money only ever flows <span className="hl">down and narrower</span>.
          </h3>
          <p className="lede">
            A child's budget is always a slice of its parent's <em>remaining</em> balance, and its allowlist can only be a
            subset. Try to broaden either and the delegation is rejected before the child exists.
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
/* ENS names are the tree                                                      */
/* -------------------------------------------------------------------------- */
function EnsWow() {
  return (
    <section className="section section-alt" id="ens" data-nav="under-the-hood">
      <div className="container wow">
        <Reveal>
          <div>
            <span className="overline">ENS names are the tree</span>
            <h3 className="h2 h2-sub">
              ENS's name hierarchy <span className="hl">is</span> the delegation tree.
            </h3>
            <p className="lede">
              Every mandate is named down the tree, so a name already says who delegated to whom. The payment demo mirrors
              each mandate into an in-memory ENSv2 registry mock as subname text records; nothing is registered on a chain.
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
    { n: "01", h: "Verify identity", tag: "World ID · mock", block: false, p: "Every node, and every ancestor, must present a valid agent credential. Expired or unknown agents are denied before anything moves." },
    { n: "02", h: "Check the mandate", tag: "Attenuation", block: true, p: "Not revoked, not expired, within the node's available balance, merchant and purpose on the allowlist. Over-budget spends stop here." },
    { n: "03", h: "Screen the payment", tag: "Intercepta · mock", block: true, p: "A screening call runs before the payment is signed. A flagged counterparty is blocked even when the mandate allows it." },
    { n: "04", h: "Settle in any token", tag: "1inch Aqua · mock", block: false, p: "Pay in USDC while the merchant receives their token. The mock swaps at a fixed 1:1 rate; the Aqua/SwapVM client is a stub." },
    { n: "05", h: "Enforce on-chain", tag: "Uniswap v4 hook · not deployed", block: false, p: "A v4-style hook carries the same cap into the swap: one that exceeds the node's remaining allowance reverts. Contract and tests only; it is not deployed." },
  ];
  return (
    <section className="section" id="pipeline" data-nav="under-the-hood">
      <div className="container">
        <Reveal>
          <span className="overline">The payment pipeline</span>
          <h3 className="h2 h2-sub">
            Five gates before a single cent <span className="hl">moves</span>.
          </h3>
          <p className="lede">Each payment clears identity, the mandate, a screen and settlement in that order; the tags say what runs here.</p>
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
/* Footer                                                                       */
/* -------------------------------------------------------------------------- */
function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <div className="footer-brand">◈ Allowance</div>
          <div className="footer-tag">
            The allocation and risk layer for capital run by AI agents, built on attenuating delegation. Built at ETHGlobal.
            Every fund result on this page is simulated (virtual worlds and synthetic prices); the worked example's research
            notes cite real sources, but its prices are synthetic.
          </div>
        </div>
        <nav className="footer-links" aria-label="Sources">
          <a href={REPO_TREE} target="_blank" rel="noreferrer">Code ↗</a>
          <a href={repoFile(LEDGER_FILE)} target="_blank" rel="noreferrer">Sealed-loop ledger ↗</a>
          <a href="#integrations">Integration status</a>
        </nav>
      </div>
    </footer>
  );
}
