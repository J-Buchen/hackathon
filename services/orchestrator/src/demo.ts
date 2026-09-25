/**
 * Allowance — the demo storyline runner.
 *
 * Runs the full DESIGN §8 storyline (steps a..h) entirely OFFLINE using the
 * deterministic mock adapters, narrates each step in plain "explain-like-I'm-five"
 * language, and writes the final dashboard snapshot to
 * `apps/web/public/demo-snapshot.json`.
 *
 * The one-liner: **give your AI agents an allowance, not your wallet.** A human
 * funds a root agent; authority ATTENUATES down a chain of sub-agents (each hop
 * can only ever narrow its parent's budget/scope); every payment must clear
 * identity -> mandate -> live screening -> settlement; and a single revoke at the
 * top instantly disables an entire subtree.
 *
 * Run:  npm run demo   (from the repo root)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  DelegationTree,
  parseAmount,
  formatAmount,
  writeSnapshotFile,
  checkAttenuation,
  AttenuationError,
  type MandateInput,
  type PaymentRecord,
  type PrincipalProof,
} from "@allowance/core";
import {
  createMockAdapters,
  MockPrincipalVerifier,
  MultiBaasDashboard,
} from "@allowance/adapters";

import { AllowanceFlow } from "./flow";

/* ------------------------------------------------------------------ */
/* Console helpers (small, dependency-free, deterministic).           */
/* ------------------------------------------------------------------ */

const USDC = (v: bigint): string => `${formatAmount(v)} USDC`;

function header(step: string, eli5: string): void {
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${step}`);
  console.log(`  (ELI5) ${eli5}`);
  console.log("═".repeat(78));
}

function line(msg: string): void {
  console.log(`   ${msg}`);
}

/** Pretty one-line verdict for a payment attempt + the on-chain hook mirror. */
function reportPayment(label: string, r: { record: PaymentRecord; hook: { allowed: boolean; revert?: string }; hookAgrees: boolean }): void {
  const { record, hook, hookAgrees } = r;
  line(`${label}: ${record.outcome}${record.reason ? ` — ${record.reason}` : ""}`);
  if (record.settlement) {
    const s = record.settlement;
    line(
      `   settlement: ${s.settled ? "moved" : "did NOT move"} funds` +
        (s.swapped ? ` (1inch Aqua swapped ${s.fromToken} -> ${s.toToken}, in ${s.amountIn} out ${s.amountOut})` : " (no swap needed)"),
    );
  }
  if (record.screening) {
    line(`   Intercepta: ${record.screening.approved ? "APPROVED" : "BLOCKED"}${record.screening.reference ? ` [ref ${record.screening.reference}]` : ""}`);
  }
  line(
    `   Uniswap v4 hook mirror: ${hook.allowed ? "would ALLOW swap" : `would REVERT (${hook.revert})`} ` +
      `— agrees with pipeline: ${hookAgrees ? "yes" : "NO"}`,
  );
}

/* ------------------------------------------------------------------ */
/* Timeline constants (fixed so the demo is fully reproducible).      */
/* ------------------------------------------------------------------ */

/** asOf = 2026-09-25T12:00:00Z (matches the seed snapshot). */
const AS_OF = Math.floor(Date.UTC(2026, 8, 25, 12, 0, 0) / 1000);
/** All mandates expire 30 days out; evaluation time (`now`) is AS_OF. */
const EXPIRY = AS_OF + 30 * 24 * 60 * 60;

/** Names used throughout the storyline. */
const ROOT = "alice.eth";
const RESEARCHER = "researcher.alice.eth";
const SCRAPER = "scraper.researcher.alice.eth";
const GHOST = "ghost.alice.eth";

/* ------------------------------------------------------------------ */
/* Small assertion helper so the demo self-verifies its own outcomes. */
/* ------------------------------------------------------------------ */

const failures: string[] = [];
function expect(what: string, actual: bigint | number | string, expected: bigint | number | string): void {
  const ok = actual === expected;
  line(`assert ${what}: ${ok ? "OK" : "FAIL"} (got ${actual}, expected ${expected})`);
  if (!ok) failures.push(`${what}: got ${actual}, expected ${expected}`);
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("");
  console.log("┌────────────────────────────────────────────────────────────────────────┐");
  console.log("│  ALLOWANCE — give your AI agents an allowance, not your wallet.           │");
  console.log("│  Attenuating delegation for autonomous AI-agent payments.                │");
  console.log("└────────────────────────────────────────────────────────────────────────┘");

  const tree = new DelegationTree();
  const adapters = createMockAdapters(); // World ID + Intercepta + 1inch Aqua mocks
  const idkit = new MockPrincipalVerifier(); // World IDKit (human-principal verifier)
  const flow = new AllowanceFlow(tree, adapters, { settlementToken: "USDC" });
  const payAt = { now: AS_OF } as const;

  /* ── (a) Human verifies via IDKit, then funds the root agent ─────────────── */
  header(
    "(a) Alice proves she is a real human (World IDKit), then funds her root agent",
    "A grown-up shows ID, then puts money in the family piggy bank the robot will manage.",
  );

  // First show the FAILURE path (DESIGN §6): a bad proof => funding is refused.
  const badProof: PrincipalProof = { action: "fund-root", signal: "fail" };
  const badResult = await idkit.verify(badProof);
  line(`World IDKit (bad proof): verified=${badResult.verified} — ${badResult.reason ?? ""}`);
  if (!badResult.verified) {
    line("=> Funding REFUSED. The root agent is NOT created on a failed human check.");
  }

  // Now the SUCCESS path: a valid proof => we may fund the root.
  const goodProof: PrincipalProof = { action: "fund-root", signal: "alice" };
  const goodResult = await idkit.verify(goodProof);
  line(`World IDKit (valid proof): verified=${goodResult.verified} [nullifier ${goodResult.nullifierHash}]`);

  const rootMandate: MandateInput = {
    budget: parseAmount("100"), // 100 USDC
    // merchants/purposes left undefined = "any" (the root may spend anywhere).
    expiry: EXPIRY,
  };
  tree.fundRoot({
    principal: "alice",
    rootName: ROOT,
    mandate: rootMandate,
    principalVerified: goodResult.verified,
  });
  flow.syncEns(); // project the new root onto the ENS registry
  line(`Funded ${ROOT} with ${USDC(rootMandate.budget)} (merchants: any). principal.verified=${goodResult.verified}`);
  line(`ENS: registered name "${ROOT}" with allowance.* mandate text records.`);

  /* ── (b) Root delegates a narrowed slice to the researcher ───────────────── */
  header(
    "(b) The root agent gives the researcher a 30 USDC allowance (fewer shops)",
    "The piggy bank hands the researcher robot a 30-dollar envelope it may only spend at 3 named shops.",
  );
  const researcherMandate: MandateInput = {
    budget: parseAmount("30"),
    // NOTE: sanctioned-vendor IS in the allowlist on purpose — the MANDATE permits
    // it, so that LIVE screening (Intercepta) is what catches it in step (e).
    allowedMerchants: ["arxiv", "openai", "sanctioned-vendor"],
    expiry: EXPIRY,
  };
  tree.delegate(ROOT, "researcher", researcherMandate);
  flow.syncEns();
  line(`Delegated ${USDC(researcherMandate.budget)} to ${RESEARCHER}, merchants={arxiv, openai, sanctioned-vendor}.`);
  line(`ENS: registered subname "${RESEARCHER}" under "${ROOT}" (subname == delegation).`);
  line(`Attenuation held: 30 USDC <= root available ${USDC(tree.available(ROOT))} at delegation time.`);

  /* ── (c) Researcher delegates a still-narrower slice to the scraper ──────── */
  header(
    "(c) The researcher sub-delegates 10 USDC to a scraper (only ONE shop)",
    "The researcher robot gives its little helper a 10-dollar envelope good at a single shop.",
  );
  const scraperMandate: MandateInput = {
    budget: parseAmount("10"),
    allowedMerchants: ["arxiv"], // narrower than the parent's set — attenuation OK
    expiry: EXPIRY,
  };
  tree.delegate(RESEARCHER, "scraper", scraperMandate);
  flow.syncEns();
  line(`Delegated ${USDC(scraperMandate.budget)} to ${SCRAPER}, merchants={arxiv} (a strict subset).`);
  line(`Authority ATTENUATES down the chain: 100 -> 30 -> 10 USDC, {any} -> {3 shops} -> {1 shop}.`);

  // Bonus: prove attenuation REJECTS an over-broad child (never persists it).
  try {
    tree.delegate(RESEARCHER, "greedy", {
      budget: parseAmount("999"), // way over the researcher's remaining
      expiry: EXPIRY,
    });
  } catch (err) {
    if (err instanceof AttenuationError) {
      line(`Attempt to over-delegate 999 USDC to greedy.* -> REJECTED (${err.reason}). Child never created.`);
    } else {
      throw err;
    }
  }

  /* ── (d) Scraper tries to overspend its own envelope ─────────────────────── */
  header(
    "(d) The scraper tries to spend 15 USDC — but its envelope only holds 10",
    "The little helper tries to buy something too expensive for its tiny envelope. Denied.",
  );
  const dResult = await flow.executePayment(
    { node: SCRAPER, merchant: "arxiv", amount: parseAmount("15"), purpose: "download-papers" },
    payAt,
  );
  reportPayment("scraper pays arxiv 15 USDC", dResult);

  /* ── (e) Researcher pays a permitted-but-sanctioned merchant ─────────────── */
  header(
    "(e) The researcher pays a shop the policy allows — but LIVE screening blocks it",
    "The envelope says this shop is fine, but a real-time background check flags it. Blocked.",
  );
  const eResult = await flow.executePayment(
    { node: RESEARCHER, merchant: "sanctioned-vendor", amount: parseAmount("5"), purpose: "data" },
    payAt,
  );
  reportPayment("researcher pays sanctioned-vendor 5 USDC", eResult);

  /* ── (f) Researcher makes a good payment; Aqua swaps tokens ──────────────── */
  header(
    "(f) The researcher pays OpenAI 8 USDC — cleared, and 1inch Aqua swaps the token",
    "A normal purchase: ID checks out, envelope allows it, background check is clean, money moves (in the shop's preferred currency).",
  );
  const fResult = await flow.executePayment(
    {
      node: RESEARCHER,
      merchant: "openai",
      amount: parseAmount("8"),
      purpose: "inference",
      payerToken: "USDC", // Alice funds in USDC ...
      merchantToken: "USDT", // ... but the merchant wants USDT -> Aqua swaps.
    },
    payAt,
  );
  reportPayment("researcher pays openai 8 USDC", fResult);
  line(`researcher spentDirect is now ${USDC(tree.requireNode(RESEARCHER).mandate.spentDirect)}.`);

  /* ── (g) An unverified ("ghost") agent tries to pay ──────────────────────── */
  header(
    "(g) A ghost agent with an EXPIRED identity tries to pay — World ID denies it",
    "A robot whose ID badge expired tries to buy something. The door won't even open.",
  );
  // Delegate the ghost node with an expired machine identity (5 USDC envelope).
  tree.delegate(
    ROOT,
    "ghost",
    { budget: parseAmount("5"), expiry: EXPIRY },
    { identityStatus: "expired" },
  );
  flow.syncEns();
  line(`Delegated ${USDC(parseAmount("5"))} to ${GHOST} but its World ID status is "expired".`);
  const gResult = await flow.executePayment(
    { node: GHOST, merchant: "arxiv", amount: parseAmount("3"), purpose: "scrape" },
    payAt,
  );
  reportPayment("ghost pays arxiv 3 USDC", gResult);

  /* ── (h) Revoke the researcher; the whole subtree goes dark ──────────────── */
  header(
    "(h) Alice revokes the researcher — and the scraper below it is instantly disabled",
    "The grown-up takes back the researcher's envelope. Every helper who got money from it stops working too.",
  );
  tree.revoke(RESEARCHER);
  flow.syncEns();
  line(`Revoked ${RESEARCHER}. Revocation cascades to every descendant via the ancestor check.`);
  const hResult = await flow.executePayment(
    { node: SCRAPER, merchant: "arxiv", amount: parseAmount("5"), purpose: "download-papers" },
    payAt,
  );
  reportPayment("scraper pays arxiv 5 USDC (post-revoke)", hResult);

  /* ── Final balances + self-check ─────────────────────────────────────────── */
  header(
    "SUMMARY — the spend tree after the whole story",
    "Here's how much is left in every envelope, and proof the numbers add up.",
  );
  for (const node of tree.listNodes()) {
    const m = node.mandate;
    line(
      `${node.name.padEnd(30)} budget ${USDC(m.budget).padEnd(14)} ` +
        `spent ${USDC(m.spentDirect).padEnd(14)} reserved ${USDC(tree.reserved(node.name)).padEnd(14)} ` +
        `available ${USDC(tree.available(node.name)).padEnd(14)} ` +
        `id=${node.identityStatus}${m.revoked ? " [REVOKED]" : ""}`,
    );
  }

  console.log("");
  line("Self-check against DESIGN §8 expected outcomes:");
  expect("root available", tree.available(ROOT), parseAmount("65")); // 100 - 30 - 5
  expect("researcher available", tree.available(RESEARCHER), parseAmount("12")); // 30 - 10 - 8
  expect("researcher spentDirect", tree.requireNode(RESEARCHER).mandate.spentDirect, parseAmount("8"));
  // 11 events: FUND, DELEGATE×2, ATTENUATION_REJECTED (bonus greedy attempt),
  // 3 payments (d/e/f), DELEGATE ghost, ghost payment, REVOKE, post-revoke payment.
  expect("total events", tree.events.length, 11);
  expect("step (d) outcome", dResult.record.outcome, "BLOCKED_MANDATE");
  expect("step (e) outcome", eResult.record.outcome, "BLOCKED_SCREENING");
  expect("step (f) outcome", fResult.record.outcome, "SETTLED");
  expect("step (f) swapped", String(fResult.record.settlement?.swapped), "true");
  expect("step (g) outcome", gResult.record.outcome, "DENIED_IDENTITY");
  expect("step (h) outcome", hResult.record.outcome, "REVOKED");

  /* ── Curvegrid AI summary + write the dashboard snapshot ─────────────────── */
  const snapshotPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../apps/web/public/demo-snapshot.json",
  );
  const snapshot = await writeSnapshotFile(tree, snapshotPath, { asOf: AS_OF });

  header(
    "Curvegrid AI agent reads the chain state and explains it",
    "A helper robot looks at everything that happened and says it back in one breath.",
  );
  const dashboard = new MultiBaasDashboard(snapshot.decimals);
  line(dashboard.summarize(snapshot));
  const chain = dashboard.readChainActivity(snapshot);
  line(`MultiBaas-style chain activity: ${chain.length} on-chain events synthesized (e.g. ${chain[0]?.event} @ block ${chain[0]?.blockNumber}).`);

  console.log("");
  line(`Snapshot written -> ${snapshotPath}`);
  line(`   ${snapshot.nodes.length} nodes, ${snapshot.events.length} events, asOf=${snapshot.asOf}.`);

  if (failures.length > 0) {
    console.error("");
    console.error(`DEMO FAILED — ${failures.length} assertion(s) did not match:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("");
  console.log("✓ Demo complete. All outcomes match DESIGN §8. Open apps/web to see the dashboard.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo crashed:", err);
  process.exit(1);
});
