/**
 * Page-level content that is data, not layout: the nav's sections (in page
 * order), the terms the page defines once, the sealed-evidence intro, and the
 * integration cards with their status as the code has it. Kept free of React
 * so it is unit-tested (site.test.ts): every card must link to a file that
 * exists at the linked commit and never claim a deployment, and the evidence
 * intro must state the rule the ledger actually applies.
 */

export const REPO_URL = "https://github.com/J-Buchen/hackathon";

/**
 * The commit every GitHub link on the page points at. GitHub's `main` lags the
 * branch the loops are pushed to (`claude/busy-albattani-6iq8tj`) and does not
 * carry docs/LOOPS.md or docs/AGENTHIRE.md, so the links are pinned to a
 * pushed commit on that branch that carries every linked file: 1e2195f (loop
 * 7 and its UI), whose docs/loops/*.json hold loops 1-7, the ledger this
 * page's evidence is read from. site.test.ts checks that this commit is in the
 * page's own history and
 * holds every linked file. Move it forward when a later loop is pushed.
 */
export const REPO_REF = "1e2195f1c304deb679a5aa29e63cd5f7db77d2f0";

/** A repo file at REPO_REF on GitHub. */
export const repoFile = (path: string): string => `${REPO_URL}/blob/${REPO_REF}/${path}`;
/** The repo at REPO_REF on GitHub. */
export const REPO_TREE = `${REPO_URL}/tree/${REPO_REF}`;
/** The sealed-loop ledger the footer links to. */
export const LEDGER_FILE = "docs/LOOPS.md";

export interface NavSection {
  /** Element id of the section (and the value of its `data-nav`). */
  id: string;
  /** Label in the menu and on wide screens. */
  label: string;
  /** Label between 900 and 1179 px, where the full row does not fit. */
  short: string;
  /** One line under the label in the phone menu. */
  hint: string;
}

/** Every top-level section after the hero, in page order (the brand link is the hero). */
export const NAV_SECTIONS: readonly NavSection[] = [
  { id: "guarantees", label: "Guarantees", short: "Guarantees", hint: "four promises, one tree" },
  { id: "fund-console", label: "Fund console", short: "Console", hint: "one simulated year, one virtual world" },
  { id: "evidence", label: "Sealed evidence", short: "Evidence", hint: "every loop, on worlds nobody tuned on" },
  { id: "center-book", label: "Worked example", short: "Example", hint: "three coffee Tiger Cubs, one crowded trade" },
  { id: "integrations", label: "Integrations", short: "Integrations", hint: "what runs today, card by card" },
  { id: "under-the-hood", label: "Under the hood", short: "Under the hood", hint: "the mandate primitive and payments" },
];

/* -------------------------------------------------------------------------- */
/* Terms, defined once                                                         */
/* -------------------------------------------------------------------------- */

export interface Term {
  term: string;
  def: string;
}

/**
 * The page's jargon, defined once, in plain words. Rendered as the list under
 * the sealed-evidence intro (`#evidence-terms`); the console's context card
 * points there instead of defining the same words again.
 */
export const GLOSSARY: readonly Term[] = [
  { term: "Sealed worlds", def: "virtual worlds no researcher saw or tuned on; only the judge runs them." },
  {
    term: "Block A, block B",
    def: "two fresh batches of sealed worlds per loop: block A picks the changes that pass the judge, block B must confirm them before anything merges.",
  },
  {
    term: "Certainty equivalent",
    def: "the sure yearly return a cautious investor (risk aversion 3) would accept instead of the fund's ups and downs; higher is better.",
  },
  { term: "90% interval", def: "the range the true effect likely sits in, from the world-by-world (paired) differences." },
];

/** Where the glossary sits on the page (the evidence section's term list). */
export const GLOSSARY_ID = "evidence-terms";

/**
 * The sealed-evidence intro. It states the rule the ledger applies
 * (docs/LOOPS.md, "Protocol"): a return or drawdown claim must WIN on both
 * sealed blocks, a structural guarantee need only be NEUTRAL (loop 3's merge
 * did not win), and a fix found after a push is merged with its cost on the
 * record (loop 1's stop ceiling). site.test.ts holds it to the ledger.
 */
export const EVIDENCE_LEDE =
  "The allocator changes only when a change passes the sealed judge: a return or drawdown claim must win world by world " +
  "on block A and again on a fresh block B, a structural guarantee must stay neutral on both, and a fix found after a " +
  "push is recorded with its cost. Each result keeps its 90% interval and the ledger's notes, including where the center " +
  "book still draws down more than per-agent guardrails.";

/* -------------------------------------------------------------------------- */
/* Integrations                                                                */
/* -------------------------------------------------------------------------- */

export interface Integration {
  name: string;
  /** What it is, in two or three words. */
  role: string;
  /** How real it is today, from the code and docs, short enough for one line. Never a deployment claim. */
  status: string;
  /** local: runs here against the real software; mock: a deterministic stand-in; undeployed: code and tests, never deployed. */
  tone: "local" | "mock" | "undeployed";
  /** One sentence: what it adds to the mandate tree. */
  what: string;
  /** Where on this page it runs, and as what (the fund console runs none of them). */
  usedIn: string;
  /** Repo-relative file or doc the card links to (at REPO_REF). */
  file: string;
  /** Optional in-page link. */
  see?: { href: string; label: string };
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    name: "AgentHire",
    role: "agent marketplace",
    status: "runs locally · settlement simulated",
    tone: "local",
    what:
      "A PM hires data agents from a budget carved out of its capital mandate: hires are priced at AgentHire's own quote, " +
      "overspends are blocked and recorded Allowance-side, and one close takes the unspent budget back.",
    usedIn:
      "the AgentHire run below, recorded from a local run against an unmodified, keyless AgentHire (regenerate with " +
      "npm run demo:agenthire); its settlement and agent-to-agent routes are simulated.",
    file: "docs/AGENTHIRE.md",
    see: { href: "#agenthire", label: "See the run" },
  },
  {
    name: "World ID",
    role: "operator binding",
    status: "mock verifier",
    tone: "mock",
    what:
      "Binds each agent's track record to a verified human operator, so a cut whose agents share one person can be " +
      "flagged.",
    usedIn:
      "the AgentHire run and the payment demo, through a mock verifier; the fund console's operators are simulated labels.",
    file: "packages/adapters/src/worldidkit.ts",
  },
  {
    name: "ENS",
    role: "mandate names",
    status: "names in code · registry mock",
    tone: "mock",
    what: "Every mandate is named down the tree (desk\u20110.beta.arena.eth), so a name says who delegated to whom.",
    usedIn:
      "the fund console's virtual worlds (ENS-style names as plain strings) and the payment demo (an in-memory ENSv2 " +
      "registry mock); nothing is registered on a chain.",
    file: "packages/adapters/src/ens.ts",
  },
  {
    name: "Intercepta",
    role: "payment screening",
    status: "mock",
    tone: "mock",
    what:
      "Screens a payment's counterparty before it is signed, so a flagged merchant is blocked even inside a valid " +
      "mandate.",
    usedIn: "the AgentHire run and the payment demo, as a deterministic denylist standing in for the service.",
    file: "packages/adapters/src/intercepta.ts",
  },
  {
    name: "1inch Aqua",
    role: "cross-token swap",
    status: "mock",
    tone: "mock",
    what: "Lets an agent pay in its own token while the merchant receives theirs; the mock swaps at a fixed 1:1 rate.",
    usedIn: "the payment demo only; the AgentHire run settles through AgentHire.",
    file: "packages/adapters/src/oneinch.ts",
  },
  {
    name: "Uniswap v4 SpendCapHook",
    role: "on-chain cap",
    status: "contract + tests · not deployed",
    tone: "undeployed",
    what:
      "Carries the mandate's cap into the swap itself: beforeSwap reverts when an amount exceeds the node's remaining " +
      "allowance or its mandate is revoked or expired.",
    usedIn:
      "the payment demo, as an off-chain mirror of the hook's check on every payment; the contract itself runs only in " +
      "its tests.",
    file: "contracts/contracts/SpendCapHook.sol",
  },
];

/** Every repo file the page links to on GitHub. */
export const LINKED_FILES: readonly string[] = [...INTEGRATIONS.map((i) => i.file), LEDGER_FILE];
